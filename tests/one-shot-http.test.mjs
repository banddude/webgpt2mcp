import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createGlobalRouter } from '../src/server/api/index.js';
import { createQueueManager } from '../src/server/queue.js';
import { fillExactPrompt, submitTurnOnce } from '../src/server/chatgptSubmit.js';
import { AdapterRegistry } from '../src/backend/registry.js';
import { manifest as textBrowser, chatgptCloudRequest } from '../src/backend/adapter/chatgpt_text.js';
import { manifest as imageBrowser } from '../src/backend/adapter/chatgpt.js';

const ID = '12345678-1234-1234-1234-1234567890ab';
const URL = `https://chatgpt.com/c/${ID}`;
const PROMPT = '  Exact café 🧪\n\nKeep\tspacing, `ticks` and $(literal).\n  ';
async function fixture(context) {
    const server = http.createServer(createGlobalRouter({ authToken: 'test-token', config: {}, ...context }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        async call(path, { method = 'POST', body = { input: 'retired input' }, auth = true } = {}) {
            const response = await fetch(base + path, { method,
                headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer test-token' } : {}) },
                body: method === 'GET' ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
            const raw = await response.text();
            return { status: response.status, body: raw ? JSON.parse(raw) : null };
        },
        close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
    };
}

test('retired HTTP model and task endpoints cannot inspect a browser or enqueue work', async () => {
    let calls = 0;
    const forbidden = () => { calls++; throw new Error('retired endpoint touched backend'); };
    const api = await fixture({ queueManager: { addTask: forbidden, initializePool: forbidden, getPoolContext: forbidden },
        getModels: forbidden, chatGptSession: { inspect: forbidden } });
    try {
        for (const route of ['/v1', '/v1/models', '/v1/responses', '/v1/responses/anything', '/v1/chat/completions',
            '/responses', '/chat/completions', '/models', '/admin/queue', '/admin/config/pool', '/admin/chatgpt/skill/execute', '/admin/chatgpt/skill/status/old']) {
            for (const method of ['POST', 'GET']) {
                assert.equal((await api.call(route, { method })).status, 404, `${method} ${route}`);
            }
        }
        assert.equal((await api.call('/v1/responses', { auth: false })).status, 401);
        assert.equal(calls, 0);
    } finally { await api.close(); }
});

test('browser ownership keeps authentication controls but exposes no model queue', async () => {
    const queue = createQueueManager({}, { initBrowser: async () => ({ fake: true }), getCookies: async () => ({ cookies: [] }) });
    assert.equal(queue.addTask, undefined);
    assert.equal(queue.canAcceptNonStreaming, undefined);
    const release = queue.acquireControlLock('one command');
    assert.equal(queue.acquireControlLock('another'), null);
    release(); release();
    assert.equal(queue.isControlLocked(), false);
    const api = await fixture({ queueManager: queue });
    try {
        assert.equal((await api.call('/admin/cookies', { method: 'GET', auth: false })).status, 401);
        assert.deepEqual(await api.call('/admin/cookies', { method: 'GET' }), { status: 200, body: { cookies: [] } });
    } finally { await api.close(); }
    const registry = new AdapterRegistry();
    for (const manifest of [textBrowser, imageBrowser]) {
        assert.equal(manifest.generate, undefined);
        assert.equal(registry.validateManifest(manifest, 'browser metadata'), true);
        assert.equal(manifest.getTargetUrl({}), 'https://chatgpt.com/');
    }
});

function fakePage({ throwAfterClick = false } = {}) {
    const state = { url: 'https://chatgpt.com/', prompt: '', clicks: 0, enters: 0, reads: 0, fills: [] };
    const hidden = { first() { return this; }, count: async () => 0, isVisible: async () => false };
    const composer = { first() { return this; }, isVisible: async () => true, focus: async () => {}, waitFor: async () => {},
        fill: async value => { state.prompt = value; state.fills.push(value); }, evaluate: async () => state.prompt };
    const submit = () => { state.clicks++; state.url = URL; if (throwAfterClick) throw new Error('Element is not visible after click'); };
    const button = { first() { return this; }, nth() { return this; }, count: async () => 1, isVisible: async () => true,
        isEnabled: async () => true, click: async () => submit() };
    const users = { count: async () => state.clicks, last: () => ({ innerText: async () => state.prompt }) };
    const page = { url: () => state.url, isClosed: () => false, waitForTimeout: async () => {},
        keyboard: { press: async () => { state.enters++; } },
        evaluate: async () => { state.reads++; throw new Error('No cloud read or completion observation allowed during new send'); },
        locator: selector => selector === '#prompt-textarea' ? composer
            : selector === '[data-message-author-role="user"]' ? users
            : /send-button|composer-submit-button/.test(selector) ? button : hidden,
    };
    return { page, state };
}

test('actual HTTP dispatch fills exact text once and returns a URL while the fake website has no answer', async () => {
    const { page, state } = fakePage();
    const queue = createQueueManager({}, { initBrowser: async () => ({ poolManager: { getFirstPage: () => page } }) });
    let inspectCalls = 0;
    const api = await fixture({ queueManager: queue, chatGptSession: { inspect: async () => { inspectCalls++; return { loggedIn: true }; } } });
    try {
        const result = await api.call('/admin/chatgpt/dispatch', { body: { prompt: PROMPT } });
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.equal(result.body.conversation_url, URL);
        assert.equal(result.body.completion_polling, false);
        assert.equal(result.body.exact_user_turn_confirmed, true);
        assert.deepEqual(state.fills, [PROMPT]);
        assert.equal(state.clicks, 1);
        assert.equal(state.enters, 0);
        assert.equal(state.reads, 0);
        assert.equal(queue.isControlLocked(), false);
        // Busy commands are rejected before even inspecting auth; nothing gets queued.
        const release = queue.acquireControlLock('busy');
        assert.equal((await api.call('/admin/chatgpt/dispatch', { body: { prompt: 'must not send later' } })).status, 409);
        release();
        assert.equal(state.clicks, 1);
        assert.equal(inspectCalls, 1);
        for (const forbidden of ['system_prompt', 'messages', 'tools', 'input', 'instructions', 'agent', 'project', 'stream']) {
            assert.equal((await api.call('/admin/chatgpt/dispatch', { body: { prompt: PROMPT, [forbidden]: 'hidden' } })).status, 400);
        }
        for (const conversation_url of ['', 0, false, 'fuzzy title']) {
            assert.equal((await api.call('/admin/chatgpt/dispatch', { body: { prompt: PROMPT, conversation_url } })).status, 400);
        }
        assert.equal(state.clicks, 1);
    } finally { await api.close(); }
});

test('a click accepted before a DOM error is uncertain and never replayed by HTTP dispatch', async () => {
    const { page, state } = fakePage({ throwAfterClick: true });
    const queue = createQueueManager({}, { initBrowser: async () => ({ poolManager: { getFirstPage: () => page } }) });
    const api = await fixture({ queueManager: queue, chatGptSession: { inspect: async () => ({ loggedIn: true }) } });
    try {
        const result = await api.call('/admin/chatgpt/dispatch', { body: { prompt: PROMPT } });
        assert.ok(result.status >= 400);
        assert.equal(result.body.submitted, null);
        assert.equal(result.body.submission_attempted, true);
        assert.equal(result.body.actual_url, URL);
        assert.equal(state.clicks, 1);
        assert.equal(state.enters, 0);
        assert.equal(queue.isControlLocked(), false);
    } finally { await api.close(); }
});

test('exact-fill validation catches invisible whitespace changes; disconnected caller never submits', async () => {
    const composer = { fill: async () => {} };
    assert.equal(await fillExactPrompt(composer, PROMPT, async () => PROMPT), true);
    assert.equal(await fillExactPrompt(composer, PROMPT, async () => PROMPT.trim()), false);
    let actions = 0;
    const result = await submitTurnOnce({ page: {}, findSendButton: async () => ({}), cancelled: () => true,
        clickControl: async () => { actions++; } });
    assert.equal(result.submitted, false);
    assert.equal(actions, 0);
});

test('an explicit HTTP read returns one snapshot or a rate limit without completion retries', async () => {
    let reads = 0;
    let limited = false;
    const page = { evaluate: async () => { reads++; return limited ? { error: 'api failed: 429', retry_after_ms: 60000 }
        : { id: ID, stream_status: 'IS_STREAMING', messages: [{ role: 'assistant', text: 'Partial answer' }] }; } };
    const queue = { getPoolContext: () => ({ poolManager: { getFirstPage: () => page } }) };
    const api = await fixture({ queueManager: queue, chatGptSession: { inspect: async () => ({ loggedIn: true }) } });
    try {
        const snapshot = await api.call(`/admin/chatgpt/conversation/${ID}`, { method: 'GET' });
        assert.equal(snapshot.status, 200);
        assert.equal(snapshot.body.stream_status, 'IS_STREAMING');
        assert.equal(reads, 1);
        limited = true;
        assert.ok((await api.call(`/admin/chatgpt/conversation/${ID}`, { method: 'GET' })).status >= 400);
        assert.equal(reads, 2, '429 returns immediately and never starts a scheduled retry');
    } finally { await api.close(); }
});

test('keyboard submission is only used when no click was attempted, and preserves modal denial', async () => {
    let presses = 0;
    const options = { page: { keyboard: { press: async key => { assert.equal(key, 'Enter'); presses++; } } },
        findSendButton: async () => null, clearModal: async () => ({ visible: true }),
        waitForComposer: async () => ({ focus: async () => {} }) };
    assert.equal((await submitTurnOnce(options)).error, 'conversation_rate_limit_modal');
    assert.equal(presses, 0);
    options.clearModal = async () => ({ visible: false });
    assert.equal((await submitTurnOnce(options)).method, 'keyboard');
    assert.equal(presses, 1);
});


test('mutating website control does not retry an HTTP 429 denial', async () => {
    const originalFetch = globalThis.fetch;
    let commands = 0;
    globalThis.fetch = async url => {
        if (url === '/api/auth/session') return { ok: true, json: async () => ({}) };
        commands++;
        return { ok: false, status: 429, text: async () => 'rate limited' };
    };
    try {
        const result = await chatgptCloudRequest({ evaluate: async (fn, args) => fn(args) }, { method: 'POST', path: '/gizmos', body: { name: 'fixture' } });
        assert.equal(result.http, 429);
        assert.equal(commands, 1);
    } finally { globalThis.fetch = originalFetch; }
});


test('login HTTP command rejects waiting options and returns one explicit current snapshot', async () => {
    let opens = 0;
    const snapshot = { opened: true, authenticated: false, loginRequired: true,
        status: { state: 'logged-out' }, url: 'https://chatgpt.com/auth/login' };
    const api = await fixture({ chatGptSession: {
        inspect: async () => { throw new Error('login must not add an auth probe'); },
        openLogin: async (...args) => { assert.equal(args.length, 0); opens++; return snapshot; },
    } });
    try {
        for (const body of [{ wait_seconds: 300 }, { wait_seconds: 0 }, { waitSeconds: 0 }, { wait: true }, [], null]) {
            assert.equal((await api.call('/admin/chatgpt/login', { body })).status, 400);
        }
        assert.equal((await api.call('/admin/chatgpt/login', { body: {}, auth: false })).status, 401);
        assert.equal(opens, 0);
        const result = await api.call('/admin/chatgpt/login', { body: {} });
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.status, snapshot.status);
        assert.equal(result.body.authenticated, false);
        assert.equal(opens, 1);
    } finally { await api.close(); }
});

test('retired server model settings fail before any configuration write', async () => {
    const api = await fixture({});
    try {
        for (const key of ['keepaliveMode', 'queueBuffer', 'imageLimit', 'imageMarkdown']) {
            const result = await api.call('/admin/config/server', { body: { [key]: 1 } });
            assert.equal(result.status, 400);
            assert.match(JSON.stringify(result.body), /Unsupported retired model setting/);
        }
    } finally { await api.close(); }
});
