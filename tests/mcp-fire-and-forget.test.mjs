import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Mike, 2026-09-07: no tool may wait for ChatGPT. create/send/chatgpt return on
// send-acceptance with the conversation URL; nothing in the service re-polls.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONV = '6a9f18a6-3510-83e8-b328-f178696257a7';

function fakeApi() {
    const hits = { dispatch: 0, completions: 0, reads: 0, requests: [] };
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            const payload = body ? JSON.parse(body) : {};
            hits.requests.push({ path: req.url, body: payload });
            if (req.url === '/admin/chatgpt/dispatch') {
                hits.dispatch += 1;
                if (payload.prompt === '__uncertain__') {
                    res.writeHead(502, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ success: false, submitted: null, submission_attempted: true, error: 'send_outcome_unknown', actual_url: `https://chatgpt.com/c/${CONV}` }));
                    return;
                }
                if (payload.prompt === '__disconnect__') { req.socket.destroy(); return; }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ success: true, submitted: true, detached: true, conversation_id: CONV, conversation_url: `https://chatgpt.com/c/${CONV}`, exact_user_turn_confirmed: true, stream_status_after: 'IS_STREAMING' }));
                return;
            }
            if (req.url === `/admin/chatgpt/conversation/${CONV}`) {
                hits.reads++;
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ id: CONV, stream_status: 'IS_STREAMING', messages: [{ role: 'assistant', text: 'Partial answer' }] }));
                return;
            }
            if (req.url === '/admin/chatgpt/login' || req.url === '/admin/chatgpt/status') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(req.url.endsWith('/login')
                    ? { opened: true, authenticated: false, loginRequired: true, status: { state: 'logged-out' }, url: 'https://chatgpt.com/auth/login' }
                    : { loggedIn: true, state: 'logged-in' }));
                return;
            }
            if (req.url === '/v1/chat/completions') { hits.completions += 1; return; } // hang forever: a slow ChatGPT answer
            res.writeHead(404); res.end('{}');
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port })));
}

// The MCP SDK is installed per checkout (mcp-server/node_modules or gateway/node_modules),
// never committed. Find it so the temp copy of the server can import it.
function sdkModulesDir() {
    for (const dir of ['mcp-server/node_modules', 'gateway/node_modules', 'node_modules']) {
        const full = path.join(root, dir);
        if (fs.existsSync(path.join(full, '@modelcontextprotocol', 'sdk'))) return full;
    }
    return null;
}

function mcpClient(port) {
    const tmp = fs.mkdtempSync(path.join(root, 'mcp-server', '.test-tmp-'));
    for (const f of fs.readdirSync(path.join(root, 'mcp-server'))) if (f.endsWith('.mjs')) fs.copyFileSync(path.join(root, 'mcp-server', f), path.join(tmp, f));
    fs.symlinkSync(sdkModulesDir(), path.join(tmp, 'node_modules'), 'dir');
    const child = spawn(process.execPath, [path.join(tmp, 'index.mjs')], { env: { ...process.env, CHATGPT_API_URL: `http://127.0.0.1:${port}`, CHATGPT_API_KEY: 'test-key' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map(); let buf = '';
    child.stdout.on('data', chunk => { buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; try { const m = JSON.parse(line); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} } });
    let id = 0;
    const call = (method, params, timeoutMs = 5000) => new Promise((resolve, reject) => { const mid = ++id; const t = setTimeout(() => { pending.delete(mid); reject(new Error(`${method} did not return within ${timeoutMs}ms`)); }, timeoutMs); pending.set(mid, m => { clearTimeout(t); resolve(m); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n'); });
    const notify = (method, params = {}) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    const close = async () => { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; fs.rmSync(tmp, { recursive: true, force: true }); };
    return { call, notify, close };
}

test('create returns on acceptance while ChatGPT is still generating and never touches the blocking endpoint', { skip: sdkModulesDir() ? false : 'install mcp-server deps (@modelcontextprotocol/sdk) to run the live MCP proof' }, async () => {
    const api = await fakeApi();
    const c = mcpClient(api.port);
    try {
        await c.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
        c.notify('notifications/initialized');
        const t0 = Date.now();
        const r = await c.call('tools/call', { name: 'create', arguments: { message: 'make an image of a cozy office' } }, 5000);
        const took = Date.now() - t0;
        assert.ok(!r.error, JSON.stringify(r.error));
        const text = r.result.content[0].text;
        assert.match(text, new RegExp(`https://chatgpt.com/c/${CONV}`));
        assert.match(text, /does not wait/i);
        assert.equal(r.result._meta.completion_polling, false);
        assert.equal(r.result._meta.accepted, true);
        assert.ok(took < 5000, `took ${took}ms`);
        assert.equal(api.hits.dispatch, 1);
        assert.equal(api.hits.completions, 0, 'blocking /v1/chat/completions must never be called');
        const chat = await c.call('tools/call', { name: 'chatgpt', arguments: { prompt: 'hi', conversation_url: `https://chatgpt.com/c/${CONV}` } }, 5000);
        assert.equal(chat.result._meta.completion_polling, false);
        assert.equal(api.hits.completions, 0);
        const list = await c.call('tools/list', {});
        for (const name of ['create', 'send', 'chatgpt']) {
            const tool = list.result.tools.find(t => t.name === name);
            assert.match(tool.description, /never waits for or returns the reply/i, `${name} description must say it never waits`);
        }
    } finally { await c.close(); api.server.closeAllConnections(); api.server.close(); }
});

test('no background poller and no cloud stream_status polling remain in the service', () => {
    const routes = fs.readFileSync(path.join(root, 'src/server/api/admin/routes.js'), 'utf8');
    assert.ok(!routes.includes('startWorkerRegistryPoller'), 'worker registry poller must not be wired');
    assert.ok(!routes.includes('completion_polling: true'), 'dispatch must not advertise polling');
    const adapter = fs.readFileSync(path.join(root, 'src/backend/adapter/chatgpt_text.js'), 'utf8');
    assert.ok(!adapter.includes('startStreamWatchdog'), 'retired watchdog implementation must be gone');
    assert.equal((adapter.match(/backend-api\/conversation\/\$\{id\}\/stream_status/g) || []).length, 0);
    const mcp = fs.readFileSync(path.join(root, 'mcp-server/index.mjs'), 'utf8');
    assert.ok(!mcp.includes('/v1/chat/completions'), 'MCP must not use the blocking completions endpoint');
});


test('MCP sends exact text once for every send tool; unknown options and failed sends never replay', { skip: sdkModulesDir() ? false : 'MCP SDK dependencies required' }, async () => {
    const api = await fakeApi();
    const c = mcpClient(api.port);
    const exact = '  Café 🧪\n\nKeep\tspacing and `ticks` $(literal).\n  ';
    try {
        await c.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'exact', version: '1' } });
        c.notify('notifications/initialized');
        for (const [name, args] of [
            ['create', { message: exact }],
            ['dispatch', { prompt: exact }],
            ['chatgpt', { prompt: exact }],
            ['chatgpt', { prompt: exact, conversation_url: `https://chatgpt.com/c/${CONV}` }],
            ['send', { message: exact, conversation: `https://chatgpt.com/c/${CONV}` }],
        ]) {
            const before = api.hits.requests.length;
            const result = await c.call('tools/call', { name, arguments: args });
            assert.equal(result.result.isError, undefined, result.result.content[0].text);
            assert.equal(api.hits.requests.length, before + 1, 'exactly one HTTP command; no persistence or completion request');
            assert.equal(api.hits.requests.at(-1).body.prompt, exact);
            assert.equal(api.hits.requests.at(-1).path, '/admin/chatgpt/dispatch');
            assert.equal(api.hits.reads, 0);
        }
        const count = api.hits.requests.length;
        for (const [name, args] of [
            ['chatgpt', { prompt: exact, system_prompt: 'secret instructions' }],
            ['chatgpt', { prompt: exact, conversation_url: 0 }],
            ['chatgpt', { prompt: exact, conversation_url: '' }],
            ['create', { message: exact, agent: 'aiva' }],
            ['send', { message: exact, conversation: `https://chatgpt.com/c/${CONV}`, tools: [] }],
            ['dispatch', { prompt: exact, model: 'codex' }],
            ['send', { message: exact, conversation: 'a fuzzy title' }],
            ['delete', { conversation: `https://chatgpt.com/c/${CONV}` }],
            ['project_delete', { project: 'g-p-abc123', confirm: false }],
        ]) {
            const result = await c.call('tools/call', { name, arguments: args });
            assert.equal(result.result.isError, true, name);
        }
        assert.equal(api.hits.requests.length, count, 'rejected arguments must not touch HTTP');
        for (const prompt of ['__uncertain__', '__disconnect__']) {
            const before = api.hits.dispatch;
            const result = await c.call('tools/call', { name: 'create', arguments: { message: prompt } });
            assert.equal(result.result.isError, true);
            assert.match(result.result.content[0].text, /do not resubmit automatically/i);
            assert.equal(api.hits.dispatch, before + 1);
            assert.equal(api.hits.reads, 0);
        }
        const read = await c.call('tools/call', { name: 'conversation_read', arguments: { conversation: `https://chatgpt.com/c/${CONV}` } });
        assert.equal(read.result._meta.stream_status, 'IS_STREAMING');
        assert.match(read.result.content[0].text, /Partial answer/);
        assert.equal(api.hits.reads, 1, 'explicit read returns the current partial reply without waiting');
        assert.equal(api.hits.completions, 0);
        const schemas = await c.call('tools/list', {});
        for (const name of ['create', 'dispatch', 'chatgpt', 'send']) {
            const tool = schemas.result.tools.find(tool => tool.name === name);
            assert.equal(tool.inputSchema.properties.system_prompt, undefined);
            assert.doesNotMatch(tool.description, /notify aiva/);
        }
    } finally { await c.close(); api.server.closeAllConnections(); api.server.close(); }
});


test('MCP login is one nonwaiting command and rejects retired options without HTTP work', { skip: sdkModulesDir() ? false : 'MCP SDK dependencies required' }, async () => {
    const api = await fakeApi();
    const c = mcpClient(api.port);
    try {
        await c.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
        c.notify('notifications/initialized');
        const list = await c.call('tools/list', {});
        const login = list.result.tools.find(tool => tool.name === 'login');
        assert.deepEqual(login.inputSchema.properties, {});
        assert.equal(login.inputSchema.additionalProperties, false);
        for (const args of [{ wait_seconds: 300 }, { wait_seconds: 0 }, { waitSeconds: 0 }, { wait: true }]) {
            const result = await c.call('tools/call', { name: 'login', arguments: args });
            assert.equal(result.result.isError, true);
            assert.match(result.result.content[0].text, /Unsupported login options/);
        }
        assert.equal(api.hits.requests.length, 0);
        const result = await c.call('tools/call', { name: 'login', arguments: {} });
        assert.equal(result.result.isError, undefined);
        assert.equal(result.result._meta.status.state, 'logged-out');
        assert.equal(result.result._meta.authenticated, false);
        assert.deepEqual(api.hits.requests, [{ path: '/admin/chatgpt/login', body: {} }]);
        const status = await c.call('tools/call', { name: 'status', arguments: {} });
        assert.equal(status.result._meta.loggedIn, true);
        assert.equal(api.hits.requests.length, 2);
    } finally { await c.close(); api.server.closeAllConnections(); api.server.close(); }
});
