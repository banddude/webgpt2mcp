function pageScore(state) {
    if (!state) return Number.NEGATIVE_INFINITY;
    let score = state.authenticated ? 200 : -200;
    if (state.urlIsChatGpt) score += 10;
    if (state.desktopComposerVisible) score += 60;
    if (state.mobileComposerVisible) score += 5;
    if (state.authDialogVisible) score -= 100;
    else score += 30;
    return score;
}

export function scoreChatGptPageState(state) {
    return pageScore(state);
}

export async function inspectChatGptPage(page) {
    if (!page || page.isClosed?.()) return null;
    return page.evaluate(async () => {
        const visible = (element) => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };
        const anyVisible = (selector) => Array.from(document.querySelectorAll(selector)).some(visible);

        let authenticated = false;
        let backendMeHttpStatus = null;
        try {
            const response = await fetch('/backend-api/me', {
                credentials: 'include',
                cache: 'no-store',
            });
            backendMeHttpStatus = response.status;
            authenticated = response.ok;
        } catch { }

        return {
            url: location.href,
            urlIsChatGpt: location.hostname === 'chatgpt.com' || location.hostname.endsWith('.chatgpt.com'),
            authenticated,
            backendMeHttpStatus,
            desktopComposerVisible: anyVisible('.ProseMirror, #prompt-textarea, [contenteditable="true"][role="textbox"]'),
            mobileComposerVisible: anyVisible('#mobile-composer-prompt, textarea[aria-label="Chat with ChatGPT"]'),
            authDialogVisible: anyVisible('#mobile-auth-dialog'),
            viewport: { width: window.innerWidth, height: window.innerHeight },
        };
    }).catch(() => null);
}

export async function selectChatGptControlPage(poolContext) {
    const poolManager = poolContext?.poolManager || null;
    const workers = Array.isArray(poolManager?.workers) ? poolManager.workers : [];
    const candidates = workers
        .map((worker, index) => ({ worker, index, page: worker?.page }))
        .filter(candidate => candidate.page && !candidate.page.isClosed?.());

    if (candidates.length === 0) {
        return poolManager?.getFirstPage?.() || poolContext?.getFirstPage?.() || null;
    }

    let best = null;
    for (const candidate of candidates) {
        const state = await inspectChatGptPage(candidate.page);
        const score = pageScore(state);
        if (!best || score > best.score) {
            best = { ...candidate, state, score };
        }
    }

    return best?.page || poolManager?.getFirstPage?.() || poolContext?.getFirstPage?.() || null;
}
