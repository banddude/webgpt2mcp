import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CHATGPT_INPUT_SELECTORS,
    CHATGPT_SEND_BUTTON_SELECTORS,
    findChatInput,
    chatgptCloudRequest,
} from '../src/backend/adapter/chatgpt_text.js';

test('composer compatibility includes the current ChatGPT textarea and semantic fallbacks', async () => {
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
