import assert from 'node:assert/strict';
import test from 'node:test';

import {
    manifest,
    parseChatGptConversationReference,
    chatGptConversationIdFromPageUrl,
    resolveChatGptConversationUrl,
    ensurePageOnExactConversation,
} from '../src/backend/adapter/chatgpt_text.js';
import {
    parseConversationRef,
    parseProjectRef,
} from '../mcp-server/conversation-refs.mjs';

const CONV_ID = '6a9c3077-afd0-83e8-b94a-0f4e014d1517';
const OTHER_ID = '0e1f2a3b-4c5d-6e7f-8a9b-0c1d2e3f4a5b';
const PROJECT_ID = 'g-p-6a94a675c3dc819180b3580303cc9725';
const PROJECT_LANDING_URL = `https://chatgpt.com/g/${PROJECT_ID}-aiva/project`;
const PROJECT_CONVERSATION_URL = `https://chatgpt.com/g/${PROJECT_ID}-aiva/c/${CONV_ID}`;

// Minimal fake of the Playwright page surface used by the conversation
// navigation paths. `gotoBehavior` decides where a navigation lands so tests
// can reproduce ChatGPT redirecting a project conversation to the project
// landing page instead of the chat itself.
function createFakePage({ startUrl, cloudConversation = null, gotoBehavior = null } = {}) {
    const state = {
        url: startUrl,
        gotoCalls: [],
        keyboardCalls: [],
        evaluateCalls: [],
    };

    const locatorFor = (selector) => {
        const firstLocator = {
            isVisible: async () => selector === '#prompt-textarea',
            waitFor: async () => {},
            focus: async () => {},
            // Playwright locators chain: first().first() is valid, and
            // waitForInput reacquires .first() on the locator it is given.
            first() {
                return firstLocator;
            },
        };
        return { first: () => firstLocator };
    };

    const page = {
        url: () => state.url,
        async goto(url) {
            state.gotoCalls.push(url);
            state.url = gotoBehavior ? gotoBehavior(url) : url;
            return { status: () => 200 };
        },
        locator: locatorFor,
        getByRole: () => locatorFor('role-button'),
        async evaluate(fn, arg) {
            state.evaluateCalls.push(arg);
            if (arg?.path && arg.path.startsWith('/conversation/')) {
                if (!cloudConversation) return { ok: false, http: 404, body: 'nope' };
                return { ok: true, http: 200, data: cloudConversation, authMode: 'bearer-and-cookies' };
            }
            return { ok: false, error: 'unsupported evaluate in fake page' };
        },
        async waitForTimeout() {},
        keyboard: {
            press: (key) => { state.keyboardCalls.push(`press:${key}`); },
            down: (key) => { state.keyboardCalls.push(`down:${key}`); },
            up: (key) => { state.keyboardCalls.push(`up:${key}`); },
            type: (text) => { state.keyboardCalls.push(`type:${text}`); },
        },
    };

    return { page, state };
}

// ==========================================
// Reference parsing (issue #18: the project-scoped URL form is valid)
// ==========================================

test('parseChatGptConversationReference accepts the project-scoped conversation URL', () => {
    const reference = parseChatGptConversationReference(PROJECT_CONVERSATION_URL);
    assert.deepEqual(reference, {
        id: CONV_ID,
        url: `https://chatgpt.com/c/${CONV_ID}`,
        projectId: `${PROJECT_ID}-aiva`,
    });
});

test('parseChatGptConversationReference accepts plain UUID and /c/ URLs', () => {
    assert.deepEqual(parseChatGptConversationReference(CONV_ID), {
        id: CONV_ID,
        url: `https://chatgpt.com/c/${CONV_ID}`,
        projectId: null,
    });
    assert.deepEqual(parseChatGptConversationReference(`https://chatgpt.com/c/${CONV_ID}/`), {
        id: CONV_ID,
        url: `https://chatgpt.com/c/${CONV_ID}`,
        projectId: null,
    });
});

test('parseChatGptConversationReference rejects titles, fuzzy names, and project landing URLs', () => {
    assert.equal(parseChatGptConversationReference('Repeat color'), null);
    assert.equal(parseChatGptConversationReference(`https://chatgpt.com/g/${PROJECT_ID}-aiva/project`), null);
    assert.equal(parseChatGptConversationReference(`https://chatgpt.com/g/${PROJECT_ID}-aiva`), null);
    assert.equal(parseChatGptConversationReference(''), null);
    assert.equal(parseChatGptConversationReference(null), null);
});

test('MCP parseConversationRef accepts the same project-scoped form and canonicalizes it', () => {
    assert.deepEqual(parseConversationRef(PROJECT_CONVERSATION_URL), {
        id: CONV_ID,
        url: `https://chatgpt.com/c/${CONV_ID}`,
        projectId: `${PROJECT_ID}-aiva`,
    });
    assert.deepEqual(parseConversationRef(CONV_ID), { id: CONV_ID, url: `https://chatgpt.com/c/${CONV_ID}` });
    assert.equal(parseConversationRef('aiva worker chat'), null);
});

test('parseProjectRef still resolves project ids and project URLs', () => {
    assert.equal(parseProjectRef(PROJECT_ID), PROJECT_ID);
    assert.equal(parseProjectRef(PROJECT_CONVERSATION_URL), PROJECT_ID);
    assert.equal(parseProjectRef('AIVA'), null);
});

// ==========================================
// Page URL conversation extraction
// ==========================================

test('chatGptConversationIdFromPageUrl understands both conversation URL forms', () => {
    assert.equal(chatGptConversationIdFromPageUrl(`https://chatgpt.com/c/${CONV_ID}`), CONV_ID);
    assert.equal(chatGptConversationIdFromPageUrl(PROJECT_CONVERSATION_URL), CONV_ID);
    assert.equal(chatGptConversationIdFromPageUrl(`https://chatgpt.com/g/${PROJECT_ID}/c/${CONV_ID}?model=auto`), CONV_ID);
});

test('chatGptConversationIdFromPageUrl returns null for pages that are not one exact conversation', () => {
    assert.equal(chatGptConversationIdFromPageUrl(PROJECT_LANDING_URL), null);
    assert.equal(chatGptConversationIdFromPageUrl('https://chatgpt.com/'), null);
    assert.equal(chatGptConversationIdFromPageUrl(`https://chatgpt.com/c/${OTHER_ID}#${CONV_ID}`), OTHER_ID);
    assert.equal(chatGptConversationIdFromPageUrl(''), null);
});

// ==========================================
// Cloud URL resolution
// ==========================================

test('resolveChatGptConversationUrl returns the project-scoped URL for a project conversation', async () => {
    const { page } = createFakePage({
        startUrl: 'https://chatgpt.com/',
        cloudConversation: { id: CONV_ID, gizmo_id: PROJECT_ID },
    });
    const resolved = await resolveChatGptConversationUrl(page, `https://chatgpt.com/c/${CONV_ID}`);
    assert.equal(resolved.ok, true);
    assert.equal(resolved.projectId, PROJECT_ID);
    assert.equal(resolved.url, `https://chatgpt.com/g/${PROJECT_ID}/c/${CONV_ID}`);
});

test('resolveChatGptConversationUrl returns the public URL for an unfiled conversation', async () => {
    const { page } = createFakePage({
        startUrl: 'https://chatgpt.com/',
        cloudConversation: { id: CONV_ID, gizmo_id: null },
    });
    const resolved = await resolveChatGptConversationUrl(page, CONV_ID);
    assert.equal(resolved.ok, true);
    assert.equal(resolved.projectId, null);
    assert.equal(resolved.url, `https://chatgpt.com/c/${CONV_ID}`);
});

test('resolveChatGptConversationUrl reports failures instead of guessing a URL', async () => {
    const { page } = createFakePage({ startUrl: 'https://chatgpt.com/' });
    const resolved = await resolveChatGptConversationUrl(page, `https://chatgpt.com/c/${CONV_ID}`);
    assert.equal(resolved.ok, false);
    assert.ok(resolved.error);
});

// ==========================================
// Regression: a project-scoped conversation continues in place
// ==========================================

test('a project-scoped conversation already on screen continues in place without navigation', async () => {
    const { page, state } = createFakePage({
        startUrl: PROJECT_CONVERSATION_URL,
        cloudConversation: { id: CONV_ID, gizmo_id: PROJECT_ID },
    });
    const attached = await ensurePageOnExactConversation(page, `https://chatgpt.com/c/${CONV_ID}`);
    assert.equal(attached.ok, true);
    assert.equal(attached.conversationId, CONV_ID);
    assert.equal(attached.url, PROJECT_CONVERSATION_URL);
    assert.equal(state.gotoCalls.length, 0, 'must not navigate when the target conversation is already on screen');
});

test('a project conversation is opened through its resolved project URL, not the assumed /c/ URL', async () => {
    const { page, state } = createFakePage({
        startUrl: `https://chatgpt.com/c/${OTHER_ID}`,
        cloudConversation: { id: CONV_ID, gizmo_id: PROJECT_ID },
    });
    const attached = await ensurePageOnExactConversation(page, CONV_ID);
    assert.equal(attached.ok, true);
    assert.equal(state.gotoCalls[0], `https://chatgpt.com/g/${PROJECT_ID}/c/${CONV_ID}`);
});

// ==========================================
// Regression: a mismatch fails loudly and sends nothing
// ==========================================

test('landing on the project page instead of the chat is a loud mismatch, never a composer to type into', async () => {
    const { page } = createFakePage({
        startUrl: 'https://chatgpt.com/',
        cloudConversation: { id: CONV_ID, gizmo_id: PROJECT_ID },
        // Issue #18 reproduction: navigating towards the conversation ends up
        // on the project landing page, which has its own composer.
        gotoBehavior: () => PROJECT_LANDING_URL,
    });
    const attached = await ensurePageOnExactConversation(page, `https://chatgpt.com/c/${CONV_ID}`);
    assert.equal(attached.ok, false);
    assert.equal(attached.error, 'conversation_navigation_mismatch');
    assert.equal(attached.actualUrl, PROJECT_LANDING_URL);
});

test('generate() sends nothing when the target conversation cannot be shown on screen', async () => {
    const { page, state } = createFakePage({
        startUrl: `https://chatgpt.com/c/${OTHER_ID}`,
        cloudConversation: { id: CONV_ID, gizmo_id: PROJECT_ID },
        gotoBehavior: () => PROJECT_LANDING_URL,
    });
    const result = await manifest.generate(
        { page, config: {} },
        'Say the same color.',
        [],
        null,
        { conversationUrl: `https://chatgpt.com/c/${CONV_ID}` },
    );
    assert.ok(result.error, 'the generation must fail');
    assert.ok(result.error.includes('conversation_navigation_mismatch'), `unexpected error: ${result.error}`);
    assert.equal(result.actual_url, PROJECT_LANDING_URL);
    assert.equal(state.keyboardCalls.length, 0, 'no keystroke may reach an unverified composer');
});
