// Exact conversation/project reference parsing for the MCP surface.
// Pure module: no SDK imports, no side effects, safe to unit test directly.
//
// Conversations filed in a ChatGPT project are served under
// /g/<g-p-id>[-slug]/c/<conversationId>. Every accepted form canonicalizes to
// the public /c/<id> URL; the conversation ID identifies the chat, and the
// server resolves the real project-scoped URL before navigating (issue #18).

export const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CONVERSATION_URL_RE = /^https:\/\/chatgpt\.com\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
export const PROJECT_CONVERSATION_URL_RE = /^https:\/\/chatgpt\.com\/g\/(g-p-[0-9a-z]+(?:-[0-9a-z-]+)?)\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

export function parseConversationRef(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return null;
    if (CONVERSATION_ID_RE.test(raw)) {
        return { id: raw.toLowerCase(), url: `https://chatgpt.com/c/${raw.toLowerCase()}` };
    }
    let match = raw.match(CONVERSATION_URL_RE);
    if (match) {
        const id = match[1].toLowerCase();
        return { id, url: `https://chatgpt.com/c/${id}` };
    }
    match = raw.match(PROJECT_CONVERSATION_URL_RE);
    if (match) {
        const id = match[2].toLowerCase();
        return { id, url: `https://chatgpt.com/c/${id}`, projectId: match[1].toLowerCase() };
    }
    return null;
}

export function exactRefError() {
    return {
        content: [{
            type: 'text',
            text: 'Error: conversation must be an exact ChatGPT conversation ID, an exact https://chatgpt.com/c/... URL, or an exact project-scoped https://chatgpt.com/g/g-p-.../c/... URL. Titles, topics, and fuzzy names are not accepted for this operation.',
        }],
        isError: true,
    };
}

// Verified live: ChatGPT web projects are "snorlax" gizmos with g-p-* ids,
// surfaced as https://chatgpt.com/g/<g-p-id>[-slug] URLs.
export const PROJECT_ID_RE = /^g-p-[0-9a-z]+$/i;
export const PROJECT_URL_RE = /^https:\/\/chatgpt\.com\/g\/(g-p-[0-9a-z]+)/i;

export function parseProjectRef(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return null;
    if (PROJECT_ID_RE.test(raw)) return raw;
    const match = raw.match(PROJECT_URL_RE);
    if (match) return match[1];
    return null;
}

export function projectRefError() {
    return {
        content: [{
            type: 'text',
            text: 'Error: project must be an exact ChatGPT project ID (g-p-...) or an exact https://chatgpt.com/g/g-p-... URL. Project names are not accepted for this operation.',
        }],
        isError: true,
    };
}
