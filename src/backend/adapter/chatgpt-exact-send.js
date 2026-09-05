// Exact-send safety gates for ChatGPT steering (issue #18, round 2).
//
// The live failure: a project-scoped conversation continued through send()
// typed and submitted into a composer that belonged to a brand-new chat. The
// pre-send URL check had passed, but the ChatGPT SPA had hydrated a fresh
// composer under the target URL (and the cloud resolver had 429'd, so
// navigation had fallen back to guessed /c/<id> candidates that land on the
// project landing page). These helpers make the two guarantees the issue
// demands:
//   1. A pre-type gate that runs immediately before typing and proves the
//      composer belongs to the target conversation: target id in the URL AND
//      an existing message thread in the DOM (a project landing page or a
//      fresh chat has neither the id nor the thread).
//   2. When the cloud resolver fails (429 or otherwise) navigation fails
//      loudly BEFORE any typing; URL guesses are never typed into.
//   3. After submit, if the page left the target conversation, the stray
//      conversation (ChatGPT's /c/WEB:<pending> placeholder settles into a
//      real id) is reported to the caller.

import { chatGptConversationIdFromPageUrl, parseChatGptConversationReference } from './chatgpt_text.js';

const CHATGPT_THREAD_MESSAGE_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"]';

// The new ChatGPT UI parks a just-created chat under /c/WEB:<id> until the
// server assigns the real conversation id.
const CHATGPT_PENDING_CONVERSATION_URL_RE = /\/c\/WEB:[0-9a-z-]+$/i;

export function isPendingNewChatUrl(url) {
    return CHATGPT_PENDING_CONVERSATION_URL_RE.test(String(url || ''));
}

/**
 * Count the conversation thread messages currently rendered in the DOM.
 * Returns null when the count cannot be read (never 0: an unreadable thread
 * must not pass a gate that requires a thread).
 */
export async function readChatGptThreadMessageCount(page) {
    const count = await page.locator(CHATGPT_THREAD_MESSAGE_SELECTOR)
        .count()
        .catch(() => null);
    return typeof count === 'number' ? count : null;
}

/**
 * Prove the page is showing one exact existing conversation. The URL must
 * carry the target conversation id (public or project-scoped form) AND the
 * conversation's message thread must be rendered. A URL match alone is not
 * proof: the SPA can show a fresh, empty composer (project landing page or
 * new chat) while the address bar still names the target conversation.
 */
export async function verifyChatGptComposerTarget(page, targetConversationId, { requireThread = true } = {}) {
    const url = typeof page?.url === 'function' ? page.url() : null;
    const conversationId = chatGptConversationIdFromPageUrl(url);
    const result = {
        ok: false,
        reason: null,
        url,
        conversationId,
        targetConversationId: targetConversationId || null,
        threadMessages: null,
    };
    if (!targetConversationId) {
        result.reason = 'target_conversation_id_missing';
        return result;
    }
    if (conversationId !== targetConversationId) {
        result.reason = 'url_conversation_mismatch';
        return result;
    }
    if (requireThread) {
        result.threadMessages = await readChatGptThreadMessageCount(page);
        if (result.threadMessages === null) {
            result.reason = 'conversation_thread_unreadable';
            return result;
        }
        if (result.threadMessages < 1) {
            result.reason = 'conversation_thread_not_visible';
            return result;
        }
    }
    result.ok = true;
    return result;
}

/**
 * verifyChatGptComposerTarget with a settle window: right after a navigation
 * the composer can render before the thread does, so poll until the gate
 * passes or the deadline expires. Returns the last verification result.
 */
export async function waitForVerifiedComposerTarget(page, targetConversationId, { timeoutMs = 5000, pollMs = 250, requireThread = true } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
        last = await verifyChatGptComposerTarget(page, targetConversationId, { requireThread });
        if (last.ok || Date.now() >= deadline) return last;
        await page.waitForTimeout(pollMs).catch(() => {});
    }
}

/**
 * After a submit that left the target conversation, read where the page
 * actually landed. ChatGPT first shows the /c/WEB:<pending> placeholder for a
 * chat the submit just created; wait briefly for it to settle into the real
 * conversation id so the caller learns WHICH stray chat exists.
 */
export async function readStrayConversationAfterSubmit(page, targetConversationId, { settleMs = 6000, pollMs = 300 } = {}) {
    const deadline = Date.now() + settleMs;
    let url = typeof page?.url === 'function' ? page.url() : null;
    let conversationId = chatGptConversationIdFromPageUrl(url);
    for (;;) {
        url = typeof page?.url === 'function' ? page.url() : null;
        conversationId = chatGptConversationIdFromPageUrl(url);
        const pending = isPendingNewChatUrl(url);
        const settled = !pending && conversationId !== null;
        if (settled || Date.now() >= deadline) break;
        await page.waitForTimeout(pollMs).catch(() => {});
    }
    return {
        url,
        conversationId,
        pending: isPendingNewChatUrl(url),
        isStray: Boolean(conversationId && conversationId !== targetConversationId),
    };
}

/**
 * Navigate the page to one exact conversation under the no-guessing policy:
 *
 *   - If the page ALREADY passes the composer-target gate (URL id + thread),
 *     no navigation and no cloud resolution happen.
 *   - Otherwise the cloud resolver MUST say where the conversation lives.
 *     When it fails (429, auth, anything) navigation fails loudly with
 *     error 'conversation_url_resolution_failed' and nothing is typed. The
 *     legacy fallback of trying guessed URLs (/c/<id>, configured project
 *     ids) is what typed into a project landing page composer and created a
 *     stray chat (issue #18 round 2); it is intentionally gone.
 *   - With the resolved URL, navigate, wait for the composer, and require
 *     the full gate (URL id + thread) before reporting success.
 *
 * deps is injected so routes.js can reuse its own helpers and tests can run
 * the whole policy against a fake page:
 *   resolve(page, url) -> { ok, url, error?, http? }  cloud conversation resolver
 *   goto(page, url)    -> Promise                    navigation primitive
 *   dismissDialog(page)-> Promise                    stale auth-dialog dismiss
 *   waitForComposer(page) -> Promise<locator>        composer wait (throws on timeout)
 */
export async function navigateExactChatVerified(page, conversationUrl, deps = {}) {
    const resolve = deps.resolve;
    const goto = deps.goto || ((p, url) => p.goto(url, { timeout: 60000 }));
    const dismissDialog = deps.dismissDialog || (async () => {});
    const waitForComposer = deps.waitForComposer || (async () => {});
    const log = deps.logger || null;
    const attempts = deps.attempts || 2;
    const gateTimeoutMs = deps.gateTimeoutMs ?? 5000;

    const reference = parseChatGptConversationReference(conversationUrl);
    const targetConversationId = reference?.id || null;
    if (!targetConversationId) {
        return {
            ok: false,
            ready: false,
            error: 'conversation_reference_invalid',
            actualUrl: typeof page?.url === 'function' ? page.url() : null,
        };
    }

    // Already provably on the target conversation: no resolver, no navigation.
    const current = await verifyChatGptComposerTarget(page, targetConversationId);
    if (current.ok) {
        log?.info?.(`exact navigation skipped: page already verified on ${targetConversationId} (${current.url}, ${current.threadMessages} thread messages)`);
        return { ok: true, ready: true, actualUrl: current.url, verifiedBy: 'already_on_target' };
    }

    if (typeof resolve !== 'function') {
        return {
            ok: false,
            ready: false,
            error: 'conversation_url_resolution_failed',
            resolutionError: 'resolver_unavailable',
            actualUrl: typeof page?.url === 'function' ? page.url() : null,
        };
    }

    let resolution = null;
    try {
        resolution = await resolve(page, conversationUrl);
    } catch (error) {
        resolution = { ok: false, error: error?.message || String(error) };
    }
    if (!resolution?.ok || typeof resolution.url !== 'string') {
        const resolutionError = resolution?.error || 'resolver_failed';
        const http = resolution?.http || null;
        log?.warn?.(`refusing to navigate to ${targetConversationId}: conversation URL resolution failed (${resolutionError}${http ? ` HTTP ${http}` : ''}); page stays at ${page.url()}. No URL is guessed.`);
        return {
            ok: false,
            ready: false,
            error: 'conversation_url_resolution_failed',
            resolutionError,
            resolutionHttp: http,
            actualUrl: page.url(),
        };
    }

    log?.info?.(`resolved ${targetConversationId} -> ${resolution.url}; navigating (page was at ${page.url()})`);

    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            if (page.url() !== resolution.url) {
                await goto(page, resolution.url);
            }
            await dismissDialog(page);
            await waitForComposer(page);
            const gate = await waitForVerifiedComposerTarget(page, targetConversationId, { timeoutMs: gateTimeoutMs });
            log?.info?.(`candidate ${resolution.url} (attempt ${attempt}) landed on ${page.url()}: gate ${gate.ok ? 'PASSED' : `FAILED (${gate.reason})`}, threadMessages=${gate.threadMessages}`);
            if (gate.ok) {
                return { ok: true, ready: true, actualUrl: page.url(), resolvedUrl: resolution.url, threadMessages: gate.threadMessages };
            }
            lastError = new Error(`conversation_navigation_mismatch:${page.url()}`);
        } catch (error) {
            lastError = error;
            log?.info?.(`candidate ${resolution.url} (attempt ${attempt}) threw: ${error?.message || error}`);
        }
        if (attempt < attempts) await page.waitForTimeout(1250).catch(() => {});
    }

    return {
        ok: false,
        ready: false,
        lastError,
        error: 'conversation_navigation_mismatch',
        resolvedUrl: resolution.url,
        actualUrl: page.url(),
    };
}
