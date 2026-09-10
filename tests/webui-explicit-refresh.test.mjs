import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Execute each real component's setup code with fake Vue lifecycle, stores,
// network and timers. This never starts a WebUI/browser or service.
function component(relativePath, expose) {
    const source = fs.readFileSync(new URL(`../webui/src/${relativePath}`, import.meta.url), 'utf8');
    const setup = source.match(/<script setup>([\s\S]*?)<\/script>/)[1];
    const mounted = [];
    const calls = { requests: [], timers: [], auth: 0, status: 0, stats: 0, restarts: [] };
    const settings = { token: 'fake-token', getHeaders: () => ({ Authorization: 'Bearer fake-token' }),
        checkAuth: async () => { calls.auth++; return true; }, setToken: () => {} };
    const system = {
        fetchStatus: async () => { calls.status++; }, fetchStats: async () => { calls.stats++; },
        restartService: async options => { calls.restarts.push(options); return true; },
    };
    const noop = () => {};
    const globals = {
        ref: value => ({ value }), computed: getter => ({ get value() { return typeof getter === 'function' ? getter() : getter.get(); } }),
        h: noop, onMounted: fn => mounted.push(fn), onUnmounted: noop,
        useSettingsStore: () => settings, useSystemStore: () => system, useRouter: () => ({ push: noop }),
        message: { info: noop, error: noop, success: noop, warning: noop }, Modal: { confirm: noop },
        window: { innerWidth: 1280, addEventListener: noop, removeEventListener: noop },
        setInterval: (...args) => calls.timers.push(args), setTimeout: (...args) => calls.timers.push(args),
        clearInterval: noop, clearTimeout: noop,
        fetch: async url => { calls.requests.push(url); return { ok: true, json: async () => url.includes('/logs') ? { logs: [], total: 0 } : [] }; },
        console,
    };
    for (const icon of setup.match(/\b[A-Z]\w*Outlined\b/g) || []) globals[icon] = {};
    const context = vm.createContext(globals);
    vm.runInContext(setup.replace(/^import\s[\s\S]*?;\s*$/gm, '') + `\nglobalThis.controls = { ${expose.join(', ')} };`, context);
    return { calls, controls: context.controls, source,
        mount: async () => { for (const fn of mounted) await fn(); for (let n = 0; n < 4; n++) await Promise.resolve(); } };
}

test('App authentication runs once on page open and schedules no connection checks', async () => {
    const app = component('App.vue', ['logout']);
    await app.mount();
    assert.equal(app.calls.auth, 1);
    assert.deepEqual(app.calls.timers, []);
    assert.deepEqual(app.calls.requests, []);
});

test('dashboard and logs load once, then refresh only through explicit actions', async () => {
    const dash = component('components/dash.vue', ['refreshData']);
    await dash.mount();
    assert.equal(dash.calls.status, 1);
    assert.equal(dash.calls.stats, 1);
    assert.deepEqual(dash.calls.requests, [], 'retired queue is never read');
    assert.deepEqual(dash.calls.timers, []);
    assert.match(dash.source, /@click="refreshData"/);
    await dash.controls.refreshData();
    assert.equal(dash.calls.status, 2);
    assert.equal(dash.calls.stats, 2);
    const logs = component('components/tools/logs.vue', ['fetchLogs']);
    await logs.mount();
    assert.deepEqual(logs.calls.requests, ['/admin/logs?lines=500']);
    assert.deepEqual(logs.calls.timers, []);
    assert.match(logs.source, /@click="fetchLogs"/);
    await logs.controls.fetchLogs();
    assert.deepEqual(logs.calls.requests, ['/admin/logs?lines=500', '/admin/logs?lines=500']);
});

test('explicit restart submits one command and never polls for readiness', async () => {
    const cache = component('components/tools/cache.vue', ['handleRestart']);
    await cache.mount();
    assert.deepEqual(cache.calls.requests, ['/admin/config/instances']);
    const options = { loginMode: true, workerName: 'fake-browser-worker' };
    await cache.controls.handleRestart(options);
    assert.deepEqual(cache.calls.restarts, [options]);
    assert.equal(cache.calls.status, 0);
    assert.deepEqual(cache.calls.timers, []);
});
