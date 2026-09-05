import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isPendingNewChatUrl,
    readChatGptThreadMessageCount,
    readStrayConversationAfterSubmit,
    verifyChatGptComposerTarget,
    waitForVerifiedComposerTarget,
    navigateExactChatVerified,
} from '../src/backend/adapter/chatgpt-exact-send.js';
import {
    ensurePageOnExactConversation,
} from '../src/backend/adapter/chatgpt_text.js';

const CONV_ID = '6a9c3077-afd0-83e8-b94a-0f4e014d1517';
const OTHER_ID = '6a9c377b-210c-83e8-8b75-ea197ac6993f';
const PROJECT_ID = 'g-p-6a94a675c3dc819180b3580303cc9725';
const PLAIN_CONVERSATION_URL = `https://chatgpt.com/c/${CONV_ID}`;
const PROJECT_CONVERSATION_URL = `https://chatgpt.com/g/${PROJECT_ID}/c/${CONV_ID}`;
const PROJECT_LANDING_URL = `https://chatgpt.com/g/${PROJECT_ID}-aiva/project`;
const PENDING_NEW_CHAT_URL = 'https://chatgpt.com/c/WEB:98a42429-490c-4e2f-b89c-3e570e2642e0';

// Fake Playwright page. `threadMessages` may be a number, null (DOM count
// throws: unreadable), or a function called on every read (dynamic pages).
// `gotoBehavior(url)` decides the URL a navigation lands on; returning a
// PENDING_ or landing URL reproduces the issue #18 round-2 failure shapes.
function createFakePage({
    startUrl = 'https://chatgpt.com/',
    threadMessages = 2,
    gotoBehavior = null,
    resolver = null,
} = {}) {
    const state = {
        url: startUrl,
        gotoCalls: [],
        resolverCalls: [],
        waitForTimeoutCalls: 0,
    };
    const readThread = () => (typeof threadMessages === 'function' ? threadMessages() : threadMessages);

    const locatorFor = (selector) => {
        const firstLocator = {
            isVisible: async () => selector === '#prompt-textarea',
            waitFor: async () => {},
            focus: async () => {},
            first() { return firstLocator; },
        };
        const base = {
            first: () => firstLocator,
            async count() {
                if (selector.includes('data-message-author-role')) {
                    const value = readThread();
                    if (value === null) throw new Error('detach');
                    return value;
                }
                return selector === '#prompt-textarea' ? 1 : 0;
            },
        };
        return base;
    };

    const page = {
        url: () => state.url,
        async goto(url) {
            state.gotoCalls.push(url);
            state.url = gotoBehavior ? gotoBehavior(url) : url;
            return { status: () => 200 };
        },
        locator: locatorFor,
        async waitForTimeout() { state.waitForTimeoutCalls += 1; },
    };

    const resolve = resolver
        ? async (p, url) => { state.resolverCalls.push(url); return resolver(p, url); }
        : null;

    return { page, state, resolve };
}

// deps for navigateExactChatVerified with no-op composer waits, matching how
// routes.js wires it (gotoWithCheck/waitForChatInput are integration concerns).
const depsFor = (fake, extra = {}) => ({
    resolve: fake.resolve || (async () => ({ ok: true, url: PLAIN_CONVERSATION_URL })),
    goto: async (p, url) => p.goto(url),
    dismissDialog: async () => {},
    waitForComposer: async () => {},
    logger: null,
    ...extra,
});

// ==========================================
// Pending new-chat URL detection
// ==========================================

test('isPendingNewChatUrl recognizes the WEB: placeholder of a just-created chat', () => {
    assert.equal(isPendingNewChatUrl(PENDING_NEW_CHAT_URL), true);
    assert.equal(isPendingNewChatUrl(PLAIN_CONVERSATION_URL), false);
    assert.equal(isPendingNewChatUrl(PROJECT_LANDING_URL), false);
    assert.equal(isPendingNewChatUrl(null), false);
});

// ==========================================
// Pre-type gate: prove the composer belongs to the target conversation
// ==========================================

test('gate passes when the URL names the target conversation and its thread is rendered', async () => {
    const { page } = createFakePage({ startUrl: PROJECT_CONVERSATION_URL, threadMessages: 4 });
    const gate = await verifyChatGptComposerTarget(page, CONV_ID);
    assert.equal(gate.ok, true);
    assert.equal(gate.conversationId, CONV_ID);
    assert.equal(gate.threadMessages, 4);
    assert.equal(gate.reason, null);
});

test('gate FAILS on a fresh chat hydrated under the target URL (round-2 live failure): URL matches, thread is empty', async () => {
    const { page } = createFakePage({ startUrl: PLAIN_CONVERSATION_URL, threadMessages: 0 });
    const gate = await verifyChatGptComposerTarget(page, CONV_ID);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, 'conversation_thread_not_visible');
});

test('gate fails on a project landing page and on the WEB: placeholder URL', async () => {
    const landing = createFakePage({ startUrl: PROJECT_LANDING_URL, threadMessages: 0 });
    assert.equal((await verifyChatGptComposerTarget(landing.page, CONV_ID)).reason, 'url_conversation_mismatch');

    const pending = createFakePage({ startUrl: PENDING_NEW_CHAT_URL, threadMessages: 0 });
    assert.equal((await verifyChatGptComposerTarget(pending.page, CONV_ID)).reason, 'url_conversation_mismatch');
});

test('gate fails when the thread count cannot be read at all', async () => {
    const { page } = createFakePage({ startUrl: PLAIN_CONVERSATION_URL, threadMessages: null });
    const gate = await verifyChatGptComposerTarget(page, CONV_ID);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, 'conversation_thread_unreadable');
    // the raw reader reports null, never a fake zero
    assert.equal(await readChatGptThreadMessageCount(page), null);
});

test('gate fails when no target conversation id is given', async () => {
    const { page } = createFakePage({ startUrl: PLAIN_CONVERSATION_URL });
    assert.equal((await verifyChatGptComposerTarget(page, null)).reason, 'target_conversation_id_missing');
});

test('waitForVerifiedComposerTarget waits for the thread to render after navigation', async () => {
    let reads = 0;
    const { page } = createFakePage({
        startUrl: PLAIN_CONVERSATION_URL,
        // composer first, thread two reads later
        threadMessages: () => (reads++ < 2 ? 0 : 3),
    });
    const gate = await waitForVerifiedComposerTarget(page, CONV_ID, { timeoutMs: 2000, pollMs: 10 });
    assert.equal(gate.ok, true);
    assert.equal(gate.threadMessages, 3);
});

test('waitForVerifiedComposerTarget gives up after the deadline and returns the failure reason', async () => {
    const { page } = createFakePage({ startUrl: PLAIN_CONVERSATION_URL, threadMessages: 0 });
    const gate = await waitForVerifiedComposerTarget(page, CONV_ID, { timeoutMs: 80, pollMs: 20 });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, 'conversation_thread_not_visible');
});

// ==========================================
// Stray conversation reporting after a submit that left the target
// ==========================================

test('readStrayConversationAfterSubmit waits for the WEB: placeholder to settle and reports the stray id', async () => {
    let reads = 0;
    const { page } = createFakePage({
        startUrl: PENDING_NEW_CHAT_URL,
        threadMessages: 1,
    });
    page.url = () => (reads++ < 2 ? PENDING_NEW_CHAT_URL : `https://chatgpt.com/c/${OTHER_ID}`);
    const stray = await readStrayConversationAfterSubmit(page, CONV_ID, { settleMs: 2000, pollMs: 10 });
    assert.equal(stray.isStray, true);
    assert.equal(stray.conversationId, OTHER_ID);
    assert.equal(stray.pending, false);
    assert.equal(stray.url, `https://chatgpt.com/c/${OTHER_ID}`);
});

test('readStrayConversationAfterSubmit reports not-stray when the page is back on the target conversation', async () => {
    const { page } = createFakePage({ startUrl: PLAIN_CONVERSATION_URL });
    const stray = await readStrayConversationAfterSubmit(page, CONV_ID, { settleMs: 100, pollMs: 20 });
    assert.equal(stray.isStray, false);
    assert.equal(stray.conversationId, CONV_ID);
});

test('readStrayConversationAfterSubmit reports pending when the placeholder never settles', async () => {
    const { page } = createFakePage({ startUrl: PENDING_NEW_CHAT_URL });
    const stray = await readStrayConversationAfterSubmit(page, CONV_ID, { settleMs: 60, pollMs: 20 });
    assert.equal(stray.pending, true);
    assert.equal(stray.conversationId, null);
    assert.equal(stray.isStray, false);
});

// ==========================================
// Navigation policy: resolver-first, never guess, thread-verified arrival
// ==========================================

test('resolver failure (429) refuses navigation loudly: no goto, no typed URL guesses', async () => {
    const { page, state } = createFakePage({ startUrl: PROJECT_LANDING_URL });
    const nav = await navigateExactChatVerified(page, CONV_ID, depsFor({}, {
        resolve: async () => ({ ok: false, error: 'HTTP 429: too many requests', http: 429 }),
    }));
    assert.equal(nav.ok, false);
    assert.equal(nav.error, 'conversation_url_resolution_failed');
    assert.equal(nav.resolutionError, 'HTTP 429: too many requests');
    assert.equal(nav.resolutionHttp, 429);
    assert.equal(state.gotoCalls.length, 0, 'a resolver failure must never navigate');
});

test('a resolver that THROWS is treated the same as a loud failure', async () => {
    const { page, state } = createFakePage({ startUrl: PROJECT_LANDING_URL });
    const nav = await navigateExactChatVerified(page, CONV_ID, depsFor({}, {
        resolve: async () => { throw new Error('network reset'); },
    }));
    assert.equal(nav.ok, false);
    assert.equal(nav.error, 'conversation_url_resolution_failed');
    assert.equal(nav.resolutionError, 'network reset');
    assert.equal(state.gotoCalls.length, 0);
});

test('a page already VERIFIED on the target needs no resolver and no navigation', async () => {
    const { page, state } = createFakePage({ startUrl: PROJECT_CONVERSATION_URL, threadMessages: 2 });
    let resolverCalled = false;
    const nav = await navigateExactChatVerified(page, CONV_ID, depsFor({}, {
        resolve: async () => { resolverCalled = true; return { ok: true, url: PLAIN_CONVERSATION_URL }; },
    }));
    assert.equal(nav.ok, true);
    assert.equal(nav.verifiedBy, 'already_on_target');
    assert.equal(resolverCalled, false);
    assert.equal(state.gotoCalls.length, 0);
});

test('a page on the target URL WITHOUT a thread is not "already there": the resolver is still consulted', async () => {
    const { page, state } = createFakePage({ startUrl: PLAIN_CONVERSATION_URL, threadMessages: 0 });
    const nav = await navigateExactChatVerified(page, CONV_ID, depsFor({}, {
        resolve: async () => ({ ok: false, error: 'HTTP 429', http: 429 }),
    }));
    assert.equal(nav.ok, false);
    assert.equal(nav.error, 'conversation_url_resolution_failed');
    assert.equal(state.gotoCalls.length, 0);
});

test('resolver success navigates to exactly the resolved URL and passes when the thread renders', async () => {
    const { page, state } = createFakePage({
        startUrl: PROJECT_LANDING_URL,
        gotoBehavior: () => PROJECT_CONVERSATION_URL,
        threadMessages: 2,
    });
    const nav = await navigateExactChatVerified(page, CONV_ID, depsFor({}, {
        resolve: async () => ({ ok: true, url: PROJECT_CONVERSATION_URL }),
    }));
    assert.equal(nav.ok, true);
    assert.equal(nav.actualUrl, PROJECT_CONVERSATION_URL);
    assert.deepEqual(state.gotoCalls, [PROJECT_CONVERSATION_URL], 'only the resolved URL may be navigated to');
});

test('arrival on the target URL with an EMPTY thread (fresh chat under the old URL) is a mismatch, never a composer to type into', async () => {
    const { page, state } = createFakePage({
        startUrl: PROJECT_LANDING_URL,
        // navigation lands on a URL that still names the target conversation,
        // but the UI hydrated a brand-new empty chat there (issue #18 round 2)
        gotoBehavior: () => `https://chatgpt.com/g/${PROJECT_ID}/c/${CONV_ID}`,
        threadMessages: 0,
    });
    const nav = await navigateExactChatVerified(page, CONV_ID, depsFor({}, {
        resolve: async () => ({ ok: true, url: PROJECT_CONVERSATION_URL }),
        gateTimeoutMs: 60,
    }));
    assert.equal(nav.ok, false);
    assert.equal(nav.error, 'conversation_navigation_mismatch');
    assert.ok(state.gotoCalls.length >= 1);
});

test('arrival on the project landing page is a mismatch', async () => {
    const { page } = createFakePage({
        startUrl: 'https://chatgpt.com/',
        gotoBehavior: () => PROJECT_LANDING_URL,
        threadMessages: 0,
    });
    const nav = await navigateExactChatVerified(page, CONV_ID, depsFor({}, {
        resolve: async () => ({ ok: true, url: PLAIN_CONVERSATION_URL }),
        gateTimeoutMs: 60,
    }));
    assert.equal(nav.ok, false);
    assert.equal(nav.error, 'conversation_navigation_mismatch');
    assert.equal(nav.actualUrl, PROJECT_LANDING_URL);
});

test('an invalid conversation reference fails before anything else', async () => {
    const { page } = createFakePage({ startUrl: 'https://chatgpt.com/' });
    const nav = await navigateExactChatVerified(page, 'aiva worker chat', depsFor({ page }));
    assert.equal(nav.ok, false);
    assert.equal(nav.error, 'conversation_reference_invalid');
});

// ==========================================
// Adapter ensurePageOnExactConversation follows the same policy
// ==========================================

test('ensurePageOnExactConversation fails loudly when the cloud resolver fails and the page is elsewhere', async () => {
    const { page, state } = createFakePage({ startUrl: `https://chatgpt.com/c/${OTHER_ID}`, threadMessages: 2 });
    const attached = await ensurePageOnExactConversation(page, CONV_ID, {
        resolve: async () => ({ ok: false, error: 'HTTP 429: too many requests', http: 429 }),
    });
    assert.equal(attached.ok, false);
    assert.equal(attached.error, 'conversation_url_resolution_failed');
    assert.equal(attached.resolutionError, 'HTTP 429: too many requests');
    assert.equal(attached.actualUrl, `https://chatgpt.com/c/${OTHER_ID}`);
    assert.equal(state.gotoCalls.length, 0, 'a resolver failure must never fall back to a guessed URL');
});

test('ensurePageOnExactConversation succeeds without navigation when already verified on target', async () => {
    const { page, state } = createFakePage({ startUrl: PROJECT_CONVERSATION_URL, threadMessages: 2 });
    let resolverCalled = false;
    const attached = await ensurePageOnExactConversation(page, CONV_ID, {
        resolve: async () => { resolverCalled = true; return { ok: false, error: 'HTTP 429', http: 429 }; },
    });
    assert.equal(attached.ok, true);
    assert.equal(attached.verifiedBy, 'already_on_target');
    assert.equal(resolverCalled, false);
    assert.equal(state.gotoCalls.length, 0);
});

test('ensurePageOnExactConversation rejects a fresh empty chat even when the URL names the target', async () => {
    const { page } = createFakePage({
        startUrl: PLAIN_CONVERSATION_URL,
        gotoBehavior: () => PLAIN_CONVERSATION_URL,
        threadMessages: 0,
    });
    const attached = await ensurePageOnExactConversation(page, CONV_ID, {
        resolve: async () => ({ ok: true, url: PLAIN_CONVERSATION_URL, projectId: null }),
        gateTimeoutMs: 60,
    });
    assert.equal(attached.ok, false);
    assert.equal(attached.error, 'conversation_thread_not_visible');
});
