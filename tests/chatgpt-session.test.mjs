import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createChatGptSessionManager } from '../src/server/chatgptSession.js';

function jwt(payload) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'none' })}.${encode(payload)}.`;
}

function fakeBrowser(sessionResults, { storageCookies = [] } = {}) {
    const results = [...sessionResults];
    const addedCookies = [];
    const context = {
        async storageState({ path: target }) {
            await fs.writeFile(target, JSON.stringify({ cookies: storageCookies, origins: [] }));
        },
        async addCookies(cookies) {
            addedCookies.push(...cookies);
        },
    };
    const page = {
        currentUrl: 'https://chatgpt.com/',
        context: () => context,
        async evaluate() {
            if (!results.length) throw new Error('no fake session result left');
            return results.shift();
        },
        async goto(url) {
            this.currentUrl = url;
        },
        url() {
            return this.currentUrl;
        },
        async waitForTimeout() {},
    };
    const queueManager = {
        getPoolContext() {
            return { poolManager: { getFirstPage: () => page } };
        },
    };
    return { queueManager, page, addedCookies };
}

async function tempDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'webgpt-session-test-'));
}

test('logged-in status reports token age/expiry and persists browser state', async () => {
    const nowMs = Date.parse('2026-09-05T01:00:00.000Z');
    const token = jwt({ iat: Math.floor(nowMs / 1000) - 120, exp: Math.floor(nowMs / 1000) + 1800 });
    const browser = fakeBrowser([{ ok: true, accessToken: token, sessionKeys: ['accessToken', 'user'], userPresent: true }], {
        storageCookies: [{ name: '__Secure-next-auth.session-token', value: 'secret', domain: '.chatgpt.com', path: '/' }],
    });
    const dir = await tempDir();
    const manager = createChatGptSessionManager({ queueManager: browser.queueManager, dataDir: dir, now: () => nowMs, notifier: async () => {} });

    const status = await manager.inspect();
    assert.equal(status.loggedIn, true);
    assert.equal(status.state, 'logged-in');
    assert.equal(status.tokenAgeSeconds, 120);
    assert.equal(status.tokenExpiresInSeconds, 1800);
    assert.equal(status.persisted, true);
    const saved = JSON.parse(await fs.readFile(manager.storageStatePath, 'utf8'));
    assert.equal(saved.cookies.length, 1);
});

test('persisted ChatGPT cookies are restored before declaring logout', async () => {
    const nowMs = Date.parse('2026-09-05T01:00:00.000Z');
    const token = jwt({ iat: Math.floor(nowMs / 1000) - 10, exp: Math.floor(nowMs / 1000) + 3600 });
    const browser = fakeBrowser([
        { ok: false, sessionKeys: ['WARNING_BANNER'], userPresent: false },
        { ok: true, accessToken: token, sessionKeys: ['accessToken', 'user'], userPresent: true },
    ]);
    const dir = await tempDir();
    const manager = createChatGptSessionManager({ queueManager: browser.queueManager, dataDir: dir, now: () => nowMs, notifier: async () => {} });
    await fs.writeFile(manager.storageStatePath, JSON.stringify({
        cookies: [
            { name: 'good', value: '1', domain: '.chatgpt.com', path: '/' },
            { name: 'ignore', value: '2', domain: '.example.com', path: '/' },
        ],
        origins: [],
    }));

    const status = await manager.inspect();
    assert.equal(status.loggedIn, true);
    assert.equal(status.restoredCookies, 1);
    assert.deepEqual(browser.addedCookies.map((cookie) => cookie.name), ['good']);
});

test('logged-out outage alerts once across repeated checks and re-arms after recovery', async () => {
    const nowMs = Date.parse('2026-09-05T01:00:00.000Z');
    const token = jwt({ iat: Math.floor(nowMs / 1000), exp: Math.floor(nowMs / 1000) + 3600 });
    const browser = fakeBrowser([
        { ok: false, sessionKeys: ['WARNING_BANNER'] },
        { ok: false, sessionKeys: ['WARNING_BANNER'] },
        { ok: true, accessToken: token, sessionKeys: ['accessToken'] },
        { ok: false, sessionKeys: ['WARNING_BANNER'] },
    ]);
    const dir = await tempDir();
    const alerts = [];
    const manager = createChatGptSessionManager({ queueManager: browser.queueManager, dataDir: dir, now: () => nowMs, notifier: async (message) => alerts.push(message) });

    const first = await manager.inspect({ allowRestore: false });
    const second = await manager.inspect({ allowRestore: false });
    assert.equal(first.loggedIn, false);
    assert.equal(second.loggedIn, false);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /needs Mike to log in/i);

    const recovered = await manager.inspect({ allowRestore: false });
    assert.equal(recovered.loggedIn, true);
    const nextOutage = await manager.inspect({ allowRestore: false });
    assert.equal(nextOutage.loggedIn, false);
    assert.equal(alerts.length, 2);
});

test('login command opens the bridge browser login page without exposing credentials', async () => {
    const browser = fakeBrowser([{ ok: false, sessionKeys: ['WARNING_BANNER'] }]);
    const dir = await tempDir();
    const manager = createChatGptSessionManager({ queueManager: browser.queueManager, dataDir: dir, notifier: async () => {} });

    const result = await manager.openLogin({ waitSeconds: 0 });
    assert.equal(result.opened, true);
    assert.equal(result.authenticated, false);
    assert.equal(result.loginRequired, true);
    assert.equal(browser.page.url(), 'https://chatgpt.com/auth/login');
});

test('WARNING_BANNER-only auth session remains logged in when backend-api/me proves cookie auth', async () => {
    const nowMs = Date.parse('2026-09-05T02:44:00.000Z');
    const browser = fakeBrowser([{
        ok: true,
        accessToken: null,
        authMode: 'cookies',
        sessionKeys: ['WARNING_BANNER'],
        backendMeHttpStatus: 200,
        userPresent: true,
    }]);
    const dir = await tempDir();
    const alerts = [];
    const manager = createChatGptSessionManager({
        queueManager: browser.queueManager,
        dataDir: dir,
        now: () => nowMs,
        notifier: async (message) => alerts.push(message),
    });

    const status = await manager.inspect({ allowRestore: false });
    assert.equal(status.loggedIn, true);
    assert.equal(status.state, 'logged-in');
    assert.equal(status.authMode, 'cookies');
    assert.deepEqual(status.sessionKeys, ['WARNING_BANNER']);
    assert.equal(status.backendMeHttpStatus, 200);
    assert.equal(status.tokenAgeSeconds, null);
    assert.equal(status.loginRequired, undefined);
    assert.equal(alerts.length, 0);
});
