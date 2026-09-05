import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CHATGPT_INPUT_SELECTORS,
    CHATGPT_SEND_BUTTON_SELECTORS,
    findChatInput,
    chatgptCloudRequest,
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

test('cloud management requests use browser cookies without requiring a bearer token', async () => {
    let observed = null;
    const originalFetch = globalThis.fetch;
    const page = {
        async evaluate(fn, args) {
            globalThis.fetch = async (url, options = {}) => {
                observed = { url, options };
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
    assert.match(observed.url, /backend-api\/conversations/);
    assert.equal(observed.options.credentials, 'include');
    assert.equal(observed.options.headers.Authorization, undefined);
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
