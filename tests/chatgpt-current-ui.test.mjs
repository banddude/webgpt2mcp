import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CHATGPT_INPUT_SELECTORS,
    CHATGPT_SEND_BUTTON_SELECTORS,
    findChatInput,
    focusChatGptInput,
    readCurrentChatGptDomTranscript,
    findChatGptSendButton,
    isChatGptSendControlVisibilityRace,
    chatgptCloudRequest,
    isTransientChatGptBrowserError,
    chatGptReadRetryDelayMs,
    deleteChatGptConversation,
    dismissStaleChatGptAuthDialog,
} from '../src/backend/adapter/chatgpt_text.js';

test('composer compatibility includes the current ChatGPT textarea and semantic fallbacks', async () => {
    assert.ok(CHATGPT_INPUT_SELECTORS.includes('.ProseMirror'));
    assert.ok(CHATGPT_INPUT_SELECTORS.indexOf('.ProseMirror') < CHATGPT_INPUT_SELECTORS.indexOf('#mobile-composer-prompt'));
    assert.ok(CHATGPT_INPUT_SELECTORS.includes('#mobile-composer-prompt'));
    assert.ok(CHATGPT_INPUT_SELECTORS.includes('textarea[aria-label="Chat with ChatGPT"]'));
    assert.ok(CHATGPT_INPUT_SELECTORS.includes('textarea[placeholder*="Ask ChatGPT"]'));
    assert.ok(CHATGPT_SEND_BUTTON_SELECTORS.includes('button[aria-label="Send message"]'));

    const seen = [];
    const current = { isVisible: async () => true, marker: 'current-textarea' };
    const page = {
        locator(selector) {
            seen.push(selector);
            return {
                first() {
                    if (selector === '#mobile-composer-prompt') return current;
                    return { isVisible: async () => false };
                },
            };
        },
    };
    const found = await findChatInput(page);
    assert.equal(found, current);
    assert.ok(seen.includes('#mobile-composer-prompt'));
});

test('composer focus reacquires after a rerender instead of pinning an ElementHandle', async () => {
    let generation = 0;
    let waits = 0;
    const stale = {
        async isVisible() { return true; },
        async focus() {
            generation = 1;
            throw new Error('Element is not attached to the DOM');
        },
    };
    const fresh = {
        async isVisible() { return true; },
        async focus() {},
        marker: 'fresh-composer',
    };
    const page = {
        locator(selector) {
            return {
                first() {
                    if (selector === '#prompt-textarea') return generation === 0 ? stale : fresh;
                    return { isVisible: async () => false };
                },
            };
        },
        async waitForTimeout() { waits += 1; },
    };

    const focused = await focusChatGptInput(page, { timeout: 1000 });
    assert.equal(focused, fresh);
    assert.equal(waits, 1);
});

test('recent-dispatch DOM transcript is gated to the exact current conversation', async () => {
    let evaluations = 0;
    const payload = {
        id: '12345678-1234-1234-1234-1234567890ab',
        messages: [{ role: 'user', text: 'hello' }],
        read_source: 'recent-dispatch-dom',
    };
    const page = {
        url() { return 'https://chatgpt.com/c/12345678-1234-1234-1234-1234567890ab'; },
        async evaluate(_fn, id) { evaluations += 1; assert.equal(id, payload.id); return payload; },
    };
    const matched = await readCurrentChatGptDomTranscript(page, payload.id);
    assert.deepEqual(matched, payload);
    assert.equal(evaluations, 1);

    const wrong = await readCurrentChatGptDomTranscript(page, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    assert.equal(wrong, null);
    assert.equal(evaluations, 1);
});

test('send control selection skips hidden duplicate buttons', async () => {
    const hidden = { isVisible: async () => false, isEnabled: async () => true, marker: 'hidden' };
    const visible = { isVisible: async () => true, isEnabled: async () => true, marker: 'visible' };
    const page = {
        locator(selector) {
            if (selector === '[data-testid="send-button"]') {
                return { count: async () => 2, nth: index => index === 0 ? hidden : visible };
            }
            return { count: async () => 0, nth: () => null };
        },
    };
    const found = await findChatGptSendButton(page);
    assert.equal(found, visible);
});

test('send control visibility race only classifies pre-click DOM failures', () => {
    assert.equal(isChatGptSendControlVisibilityRace('elementHandle.click: Element is not visible'), true);
    assert.equal(isChatGptSendControlVisibilityRace('Element is not attached to the DOM'), true);
    assert.equal(isChatGptSendControlVisibilityRace('Timeout 10000ms exceeded while clicking'), false);
    assert.equal(isChatGptSendControlVisibilityRace('Execution context was destroyed'), false);
});

test('cloud management requests use bearer plus cookies when accessToken is available', async () => {
    const requests = [];
    const originalFetch = globalThis.fetch;
    const page = {
        async evaluate(fn, args) {
            globalThis.fetch = async (url, options = {}) => {
                requests.push({ url, options });
                if (String(url).includes('/api/auth/session')) {
                    return {
                        ok: true,
                        status: 200,
                        async json() { return { accessToken: 'token-for-test', user: { id: 'u' } }; },
                    };
                }
                return {
                    ok: true,
                    status: 200,
                    async text() { return JSON.stringify({ items: [] }); },
                };
            };
            try {
                return await fn(args);
            } finally {
                globalThis.fetch = originalFetch;
            }
        },
    };

    const result = await chatgptCloudRequest(page, { path: 'conversations', query: { limit: '1' } });
    assert.equal(result.ok, true);
    assert.equal(result.authMode, 'bearer-and-cookies');
    const backend = requests.find(request => String(request.url).includes('/backend-api/conversations'));
    assert.ok(backend);
    assert.equal(backend.options.credentials, 'include');
    assert.equal(backend.options.headers.Authorization, 'Bearer token-for-test');
});

test('cloud management requests fall back to cookies when auth session has no accessToken', async () => {
    const requests = [];
    const originalFetch = globalThis.fetch;
    const page = {
        async evaluate(fn, args) {
            globalThis.fetch = async (url, options = {}) => {
                requests.push({ url, options });
                if (String(url).includes('/api/auth/session')) {
                    return {
                        ok: true,
                        status: 200,
                        async json() { return { WARNING_BANNER: 'warning' }; },
                    };
                }
                return {
                    ok: true,
                    status: 200,
                    async text() { return JSON.stringify({ items: [] }); },
                };
            };
            try {
                return await fn(args);
            } finally {
                globalThis.fetch = originalFetch;
            }
        },
    };

    const result = await chatgptCloudRequest(page, { path: 'conversations', query: { limit: '1' } });
    assert.equal(result.ok, true);
    assert.equal(result.authMode, 'cookies');
    const backend = requests.find(request => String(request.url).includes('/backend-api/conversations'));
    assert.ok(backend);
    assert.equal(backend.options.credentials, 'include');
    assert.equal(backend.options.headers.Authorization, undefined);
});


test('transient ChatGPT browser error classification covers navigation fetch races', () => {
    assert.equal(isTransientChatGptBrowserError('NetworkError when attempting to fetch resource.'), true);
    assert.equal(isTransientChatGptBrowserError('Execution context was destroyed, most likely because of a navigation.'), true);
    assert.equal(isTransientChatGptBrowserError('HTTP 404'), false);
});

test('conversation read backoff honors Retry-After and expands 429 fallback', () => {
    assert.equal(chatGptReadRetryDelayMs({ error: 'api failed: 429', retry_after_ms: 12500 }, 0), 12500);
    assert.equal(chatGptReadRetryDelayMs({ error: 'api failed: 429' }, 0), 3000);
    assert.equal(chatGptReadRetryDelayMs({ error: 'api failed: 429' }, 2), 12000);
    assert.equal(chatGptReadRetryDelayMs({ error: 'NetworkError when attempting to fetch resource.' }, 2), 3000);
});

test('cloud GET retries a transient browser fetch error but mutations are not replayed', async () => {
    let getEvaluations = 0;
    let getWaits = 0;
    const getPage = {
        async evaluate() {
            getEvaluations += 1;
            if (getEvaluations === 1) return { ok: false, error: 'NetworkError when attempting to fetch resource.' };
            return { ok: true, http: 200, data: { items: [] }, authMode: 'bearer-and-cookies', sessionKeys: ['accessToken'] };
        },
        async waitForTimeout() { getWaits += 1; },
    };
    const getResult = await chatgptCloudRequest(getPage, { method: 'GET', path: 'conversations' });
    assert.equal(getResult.ok, true);
    assert.equal(getEvaluations, 2);
    assert.equal(getWaits, 1);

    let patchEvaluations = 0;
    const patchPage = {
        async evaluate() {
            patchEvaluations += 1;
            return { ok: false, error: 'NetworkError when attempting to fetch resource.' };
        },
        async waitForTimeout() { throw new Error('PATCH must not retry ambiguous mutations'); },
    };
    const patchResult = await chatgptCloudRequest(patchPage, {
        method: 'PATCH',
        path: 'conversation/12345678-1234-1234-1234-1234567890ab',
        body: { is_visible: false },
    });
    assert.equal(patchResult.ok, false);
    assert.equal(patchEvaluations, 1);
});

test('conversation delete uses current soft-delete PATCH contract', async () => {
    const requests = [];
    const originalFetch = globalThis.fetch;
    const page = {
        async evaluate(fn, args) {
            globalThis.fetch = async (url, options = {}) => {
                requests.push({ url: String(url), options });
                if (String(url).includes('/api/auth/session')) {
                    return {
                        ok: true,
                        status: 200,
                        async json() { return { accessToken: 'delete-token' }; },
                    };
                }
                return {
                    ok: true,
                    status: 200,
                    async text() { return JSON.stringify({ success: true }); },
                };
            };
            try {
                return await fn(args);
            } finally {
                globalThis.fetch = originalFetch;
            }
        },
    };

    const result = await deleteChatGptConversation(
        page,
        'https://chatgpt.com/c/12345678-1234-1234-1234-1234567890ab',
    );
    assert.equal(result.success, true);
    const mutation = requests.find(request => request.url.includes('/backend-api/conversation/12345678-1234-1234-1234-1234567890ab'));
    assert.ok(mutation);
    assert.equal(mutation.options.method, 'PATCH');
    assert.deepEqual(JSON.parse(mutation.options.body), { is_visible: false });
    assert.equal(mutation.options.headers.Authorization, 'Bearer delete-token');
});


test('authenticated stale mobile auth dialog rehydrates the worker page before typing', async () => {
    let visible = true;
    let reloadCount = 0;
    let escapeCount = 0;
    const dialog = { async isVisible() { return visible; } };
    const page = {
        locator(selector) {
            assert.equal(selector, '#mobile-auth-dialog');
            return { first: () => dialog };
        },
        async evaluate() { return true; },
        async reload() { reloadCount += 1; visible = false; },
        keyboard: { async press() { escapeCount += 1; } },
        async waitForTimeout() {},
    };

    const result = await dismissStaleChatGptAuthDialog(page);
    assert.deepEqual(result, { present: true, dismissed: true, authenticated: true, method: 'reload' });
    assert.equal(reloadCount, 1);
    assert.equal(escapeCount, 0);
});

test('auth dialog is never dismissed when backend cookie authentication is absent', async () => {
    let escapeCount = 0;
    const page = {
        locator() { return { first: () => ({ isVisible: async () => true }) }; },
        async evaluate() { return false; },
        keyboard: { async press() { escapeCount += 1; } },
        async waitForTimeout() {},
    };

    const result = await dismissStaleChatGptAuthDialog(page);
    assert.deepEqual(result, { present: true, dismissed: false, authenticated: false });
    assert.equal(escapeCount, 0);
});
