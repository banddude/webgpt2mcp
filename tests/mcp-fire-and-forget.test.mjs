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
    const hits = { dispatch: 0, completions: 0 };
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            if (req.url === '/admin/chatgpt/dispatch') {
                hits.dispatch += 1;
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ success: true, submitted: true, detached: true, conversation_id: CONV, conversation_url: `https://chatgpt.com/c/${CONV}`, exact_user_turn_confirmed: true, stream_status_after: 'IS_STREAMING' }));
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
    const close = () => { child.kill(); fs.rmSync(tmp, { recursive: true, force: true }); };
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
    } finally { c.close(); api.server.close(); }
});

test('no background poller and no cloud stream_status polling remain in the service', () => {
    const routes = fs.readFileSync(path.join(root, 'src/server/api/admin/routes.js'), 'utf8');
    assert.ok(!routes.includes('startWorkerRegistryPoller'), 'worker registry poller must not be wired');
    assert.ok(!routes.includes('completion_polling: true'), 'dispatch must not advertise polling');
    const adapter = fs.readFileSync(path.join(root, 'src/backend/adapter/chatgpt_text.js'), 'utf8');
    assert.ok(adapter.includes('readCloudStreamStatus: async () => null'), 'watchdog must not poll stream_status');
    assert.equal((adapter.match(/backend-api\/conversation\/\$\{id\}\/stream_status/g) || []).length, 0);
    const mcp = fs.readFileSync(path.join(root, 'mcp-server/index.mjs'), 'utf8');
    assert.ok(!mcp.includes('/v1/chat/completions'), 'MCP must not use the blocking completions endpoint');
});
