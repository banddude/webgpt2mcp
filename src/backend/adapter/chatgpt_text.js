/**
 * @fileoverview ChatGPT 文本生成适配器
 */

import {
    sleep,
    safeClick
} from '../engine/utils.js';
import {
    waitForInput,
    gotoWithCheck
} from '../utils/index.js';
import { logger } from '../../utils/logger.js';
// Circular by design: the exact-send gate helpers import URL parsers back from
// this module. Both sides only use hoisted function declarations, so the ESM
// cycle resolves cleanly.
import {
    verifyChatGptComposerTarget,
    waitForVerifiedComposerTarget,
} from './chatgpt-exact-send.js';

// --- 配置常量 ---
const CHATGPT_CONVERSATION_ID_RE = /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;
// ChatGPT has changed the composer markup more than once. Keep the stable
// semantic fallbacks ahead of the generic contenteditable fallback so a stale
// selector cannot make an otherwise healthy authenticated page unusable.
export const CHATGPT_INPUT_SELECTORS = [
    '#prompt-textarea',
    '[contenteditable="true"][data-placeholder*="Ask ChatGPT"]',
    '[contenteditable="true"][aria-label*="Ask ChatGPT"]',
    '.ProseMirror[contenteditable="true"]',
    '.ProseMirror',
    '[contenteditable="true"][role="textbox"]',
    '#mobile-composer-prompt',
    'textarea[aria-label="Chat with ChatGPT"]',
    'textarea[placeholder*="Ask ChatGPT"]',
    '[contenteditable="true"]'
];

export const CHATGPT_INPUT_SELECTOR = CHATGPT_INPUT_SELECTORS.join(', ');
export const CHATGPT_SEND_BUTTON_SELECTORS = [
    '[data-testid="send-button"]',
    'button[aria-label="Send message"]',
    'button[aria-label^="Send"]',
];
export const CHATGPT_SEND_BUTTON_SELECTOR = CHATGPT_SEND_BUTTON_SELECTORS.join(', ');
export const CHATGPT_STOP_BUTTON_SELECTORS = [
    '[data-testid="stop-button"]',
    'button[aria-label^="Stop"]',
];
export const CHATGPT_STOP_BUTTON_SELECTOR = CHATGPT_STOP_BUTTON_SELECTORS.join(', ');

export async function findChatInput(page) {
    for (const selector of CHATGPT_INPUT_SELECTORS) {
        const locator = page.locator(selector).first();
        if (await locator.isVisible().catch(() => false)) return locator;
    }
    return null;
}

export async function findChatGptSendButton(page, { requireEnabled = true } = {}) {
    for (const selector of CHATGPT_SEND_BUTTON_SELECTORS) {
        const matches = page.locator(selector);
        const count = await matches.count().catch(() => 0);
        for (let index = 0; index < count; index += 1) {
            const candidate = matches.nth(index);
            if (!await candidate.isVisible().catch(() => false)) continue;
            if (requireEnabled && !await candidate.isEnabled().catch(() => false)) continue;
            return candidate;
        }
    }
    return null;
}

export function isChatGptSendControlVisibilityRace(value) {
    const message = String(value?.message || value || '');
    return [
        'Element is not visible',
        'Element is not attached',
        'not attached to the DOM',
        'element has been detached',
    ].some(fragment => message.includes(fragment));
}

export async function dismissStaleChatGptAuthDialog(page) {
    const dialog = page.locator('#mobile-auth-dialog').first();
    const present = await dialog.isVisible().catch(() => false);
    if (!present) return { present: false, dismissed: false, authenticated: null };

    const authenticated = await page.evaluate(async () => {
        try {
            const response = await fetch('/backend-api/me', {
                credentials: 'include',
                cache: 'no-store',
            });
            return response.ok;
        } catch {
            return false;
        }
    }).catch(() => false);

    if (!authenticated) {
        return { present: true, dismissed: false, authenticated: false };
    }

    // The current ChatGPT UI can leave a worker tab's React tree in a logged-out
    // mobile state even after the shared browser context has valid authenticated
    // cookies. Reload the same page first so the app rehydrates from those cookies.
    // This preserves the current conversation URL and does not create a new context.
    try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(750);
    } catch { }

    if (!await dialog.isVisible().catch(() => false)) {
        return { present: true, dismissed: true, authenticated: true, method: 'reload' };
    }

    // If ChatGPT kept the stale dialog after rehydration, use its normal cancel path.
    await page.keyboard.press('Escape').catch(() => {});
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        if (!await dialog.isVisible().catch(() => false)) {
            return { present: true, dismissed: true, authenticated: true, method: 'reload+escape' };
        }
        await page.waitForTimeout(100);
    }

    return { present: true, dismissed: false, authenticated: true, method: 'reload+escape' };
}

export async function waitForChatInput(page, options = {}) {
    const { timeout = 60000, click = false } = options;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
        const input = await findChatInput(page);
        if (input) {
            await waitForInput(page, input, {
                timeout: Math.max(deadline - Date.now(), 5000),
                click
            });
            return input;
        }
        await page.waitForTimeout(250);
    }

    throw new Error(`ChatGPT composer not found (tried: ${CHATGPT_INPUT_SELECTORS.join(', ')})`);
}

export async function focusChatGptInput(page, options = {}) {
    const { timeout = 15000 } = options;
    const deadline = Date.now() + timeout;
    let lastError = null;

    while (Date.now() < deadline) {
        const input = await findChatInput(page);
        if (input) {
            try {
                // Keep focus as a Locator operation. ChatGPT frequently replaces
                // the composer node during React rerenders; converting the locator
                // to an ElementHandle makes that normal rerender fatal.
                await input.focus({ timeout: Math.max(deadline - Date.now(), 500) });
                if (await input.isVisible().catch(() => false)) return input;
            } catch (error) {
                lastError = error;
            }
        }
        await page.waitForTimeout(100).catch(() => {});
    }

    throw lastError || new Error('ChatGPT composer could not be focused');
}

export async function readCurrentChatGptDomTranscript(page, conversationId) {
    const id = String(conversationId || '').toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return null;
    const currentMatch = String(page?.url?.() || '').match(/\/c\/([0-9a-f-]{36})/i);
    if (!currentMatch || currentMatch[1].toLowerCase() !== id) return null;

    return page.evaluate((targetId) => {
        const isVisible = element => {
            if (!(element instanceof Element)) return false;
            const style = window.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };
        const messages = [];
        const nodes = document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]');
        for (const node of nodes) {
            if (!isVisible(node)) continue;
            const role = node.getAttribute('data-message-author-role');
            const text = String(node.innerText || node.textContent || '').trim();
            if (!text) continue;
            messages.push({
                id: node.getAttribute('data-message-id') || null,
                role,
                text,
                model: null,
                create_time: null,
            });
        }
        const stopCandidates = document.querySelectorAll('[data-testid="stop-button"], button[aria-label^="Stop"]');
        const streaming = Array.from(stopCandidates).some(isVisible);
        const hasAssistant = messages.some(message => message.role === 'assistant');
        const rawTitle = String(document.title || '').trim();
        const title = rawTitle.replace(/\s*[|\-]\s*ChatGPT\s*$/i, '').trim() || null;
        return {
            id: targetId,
            title,
            create_time: null,
            update_time: null,
            is_archived: false,
            project_id: null,
            stream_status: streaming ? 'IS_STREAMING' : (hasAssistant ? 'COMPLETE' : null),
            messages,
            read_source: 'recent-dispatch-dom',
        };
    }, id).catch(() => null);
}

export async function readChatInputText(locator) {
    if (!locator) return '';
    return locator.evaluate((element) => {
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
            return element.value || '';
        }
        return element.innerText || element.textContent || '';
    }).catch(() => '');
}

// Select the website model before an explicit new-chat send.
async function selectModel(page, codeName, meta = {}) {
    try {
        // 1. 点击 Model selector 按钮
        const modelSelectorBtn = page.getByRole('button', { name: /^Model selector/ });
        const btnExists = await modelSelectorBtn.count();
        if (btnExists === 0) {
            logger.debug('适配器', '未找到模型选择器按钮，跳过选择模型', meta);
            return false;
        }

        await modelSelectorBtn.waitFor({ timeout: 5000 });
        await safeClick(page, modelSelectorBtn, { bias: 'button' });
        await sleep(300, 500);

        // 2. 检查是否有 Legacy models 选项
        const legacyMenuItem = page.getByRole('menuitem', { name: /^Legacy models/ });
        const legacyExists = await legacyMenuItem.count();
        if (legacyExists > 0) {
            logger.debug('适配器', '发现 Legacy models 选项，正在点击...', meta);
            await safeClick(page, legacyMenuItem, { bias: 'button' });
            await sleep(300, 500);
        }

        // 3. 查找匹配 codeName 开头的 menuitem 或 menuitemradio
        let targetMenuItem = page.getByRole('menuitemradio', { name: new RegExp(`^${codeName}`, 'i') });
        let targetExists = await targetMenuItem.count();
        if (targetExists === 0) {
            targetMenuItem = page.getByRole('menuitem', { name: new RegExp(`^${codeName}`, 'i') });
            targetExists = await targetMenuItem.count();
        }

        if (targetExists > 0) {
            logger.info('适配器', `正在选择模型: ${codeName}`, meta);
            await safeClick(page, targetMenuItem.first(), { bias: 'button' });
            return true;
        } else {
            logger.debug('适配器', `未找到模型 ${codeName}，使用默认模型`, meta);
            // 点击空白区域关闭菜单
            await page.keyboard.press('Escape');
            return false;
        }
    } catch (e) {
        logger.warn('适配器', `选择模型失败: ${e.message}`, meta);
        // 尝试关闭菜单
        await page.keyboard.press('Escape').catch(() => { });
        return false;
    }
}

// Website model selection for explicit commands.
export { selectModel as selectChatGptModel };

// Shared request helper for the authenticated ChatGPT backend API. Runs inside the
// logged-in page so the session cookies and access token of the real browser
// session are used, exactly like the conversation listing/reading paths. These
// calls never navigate the page and never touch the DOM, so they are safe to run
// while a generation is streaming in the same tab.
export function isTransientChatGptBrowserError(value) {
    const message = String(value?.message || value || '');
    return [
        'Execution context was destroyed',
        'NetworkError when attempting to fetch resource',
        'Failed to fetch',
        'Load failed',
    ].some(fragment => message.includes(fragment));
}

export function chatGptReadRetryDelayMs(result, attempt = 0) {
    const retryAfterMs = Number(result?.retry_after_ms);
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        return Math.min(60000, Math.max(1000, Math.ceil(retryAfterMs)));
    }
    const message = String(result?.error || '');
    if (message.includes('api failed: 429')) {
        return Math.min(30000, 3000 * (2 ** Math.max(0, attempt)));
    }
    return Math.min(5000, 1000 * (Math.max(0, attempt) + 1));
}

export async function chatgptCloudRequest(page, { method = 'GET', path, query = null, body = null, retries = 2 }) {
    if (!page) throw new Error('ChatGPT browser page unavailable');
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const pageAttempts = normalizedMethod === 'GET' ? 3 : 1;
    // Never replay a mutating website command, including after a 429.
    const requestRetries = normalizedMethod === 'GET' ? retries : 0;
    let lastResult = null;

    for (let pageAttempt = 0; pageAttempt < pageAttempts; pageAttempt += 1) {
        try {
            lastResult = await page.evaluate(async ({ method, path, query, body, retries }) => {
                const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
                try {
                    let accessToken = null;
                    let sessionKeys = [];
                    try {
                        const sessionRes = await fetch('/api/auth/session', {
                            credentials: 'include',
                            cache: 'no-store',
                            headers: { 'Cache-Control': 'no-cache' },
                        });
                        if (sessionRes.ok) {
                            const session = await sessionRes.json();
                            sessionKeys = Object.keys(session || {});
                            accessToken = session?.accessToken || null;
                        }
                    } catch { }

                    const search = query ? new URLSearchParams(query).toString() : '';
                    const url = `https://chatgpt.com/backend-api/${String(path).replace(/^\//, '')}${search ? `?${search}` : ''}`;
                    const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
                    const hasBody = body !== null && body !== undefined;
                    if (hasBody) headers['Content-Type'] = 'application/json';

                    let lastHttp = null;
                    let lastBodyText = null;
                    for (let attempt = 0; attempt <= retries; attempt += 1) {
                        const res = await fetch(url, {
                            method,
                            headers,
                            credentials: 'include',
                            body: hasBody ? JSON.stringify(body) : undefined
                        });
                        lastHttp = res.status;
                        lastBodyText = await res.text();
                        if (res.ok) {
                            const authMode = accessToken ? 'bearer-and-cookies' : 'cookies';
                            try {
                                return { ok: true, http: res.status, data: JSON.parse(lastBodyText), authMode, sessionKeys };
                            } catch {
                                return { ok: true, http: res.status, data: null, raw: lastBodyText.slice(0, 2000), authMode, sessionKeys };
                            }
                        }
                        if (res.status !== 429) break;
                        await sleep(600 * (attempt + 1));
                    }
                    return {
                        ok: false,
                        http: lastHttp,
                        body: String(lastBodyText || '').slice(0, 2000),
                        authMode: accessToken ? 'bearer-and-cookies' : 'cookies',
                        sessionKeys,
                    };
                } catch (e) {
                    return { ok: false, error: e.message };
                }
            }, { method: normalizedMethod, path, query, body, retries: requestRetries });
        } catch (error) {
            lastResult = { ok: false, error: error?.message || String(error) };
        }

        if (lastResult?.ok || !isTransientChatGptBrowserError(lastResult?.error) || pageAttempt === pageAttempts - 1) {
            return lastResult;
        }
        await page.waitForTimeout(300 * (pageAttempt + 1)).catch(() => {});
    }

    return lastResult || { ok: false, error: 'ChatGPT backend request failed' };
}

function cloudRequestError(result) {
    if (result?.error) return result.error;
    if (result?.http) return `HTTP ${result.http}: ${result.body || 'no response body'}`;
    return 'unknown backend-api error';
}

const CHATGPT_CONVERSATION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Project-scoped conversation URL: https://chatgpt.com/g/<g-p-id>[-slug]/c/<conversationId>
const CHATGPT_PROJECT_CONVERSATION_URL_RE = /^https:\/\/chatgpt\.com\/g\/(g-p-[0-9a-z]+(?:-[0-9a-z-]+)?)\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
const CHATGPT_PLAIN_CONVERSATION_URL_RE = /^https:\/\/chatgpt\.com\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/**
 * Parse one exact conversation reference: a bare UUID, a public /c/<id> URL,
 * or a project-scoped /g/<g-p-id>[-slug]/c/<id> URL. Returns the conversation
 * ID, the canonical public URL, and the project segment when the reference
 * was project-scoped. Titles and fuzzy names are rejected.
 */
export function parseChatGptConversationReference(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return null;
    if (CHATGPT_CONVERSATION_UUID_RE.test(raw)) {
        return { id: raw.toLowerCase(), url: `https://chatgpt.com/c/${raw.toLowerCase()}`, projectId: null };
    }
    let match = raw.match(CHATGPT_PLAIN_CONVERSATION_URL_RE);
    if (match) {
        return { id: match[1].toLowerCase(), url: `https://chatgpt.com/c/${match[1].toLowerCase()}`, projectId: null };
    }
    match = raw.match(CHATGPT_PROJECT_CONVERSATION_URL_RE);
    if (match) {
        return { id: match[2].toLowerCase(), url: `https://chatgpt.com/c/${match[2].toLowerCase()}`, projectId: match[1].toLowerCase() };
    }
    return null;
}

/**
 * Extract the conversation ID from a live browser page URL. Understands both
 * the public /c/<id> form and the project-scoped /g/<project>/c/<id> form.
 * Returns null when the page is not showing one exact conversation (a project
 * landing page, the home screen, search, ...).
 */
export function chatGptConversationIdFromPageUrl(value) {
    const match = String(value || '').match(CHATGPT_CONVERSATION_ID_RE);
    return match ? match[1].toLowerCase() : null;
}

/**
 * Resolve where one exact conversation actually lives (issue #18). A
 * conversation filed in a ChatGPT project is served under
 * /g/<projectId>/c/<id>, and chatgpt.com does not reliably redirect the public
 * /c/<id> URL there: it can land on the project landing page instead, whose
 * composer then silently creates a brand-new chat. Reads the conversation's
 * cloud metadata (GET /backend-api/conversation/<id>) and returns its real
 * URL: project-scoped when the conversation has a gizmo_id, public otherwise.
 * A resolution failure is reported, never guessed around.
 */
export async function resolveChatGptConversationUrl(page, conversationReference) {
    const reference = parseChatGptConversationReference(conversationReference);
    if (!reference) {
        return { ok: false, error: 'conversation_reference_invalid' };
    }
    const result = await chatgptCloudRequest(page, {
        path: `/conversation/${reference.id}`,
        retries: 1,
    });
    if (!result?.ok) {
        return { ok: false, conversationId: reference.id, error: cloudRequestError(result), http: result?.http || null };
    }
    const gizmoId = typeof result.data?.gizmo_id === 'string' ? result.data.gizmo_id.trim() : '';
    if (gizmoId) {
        return {
            ok: true,
            conversationId: reference.id,
            projectId: gizmoId.toLowerCase(),
            url: `https://chatgpt.com/g/${gizmoId}/c/${reference.id}`,
        };
    }
    return {
        ok: true,
        conversationId: reference.id,
        projectId: null,
        url: `https://chatgpt.com/c/${reference.id}`,
    };
}

/**
 * Put the page on one exact conversation and prove the target chat is the one
 * on screen. Skips navigation when the page already PASSES the composer
 * target gate (conversation id in the URL AND a rendered message thread —
 * issue #18 round 2: a URL match alone can be a fresh new-chat composer).
 * Otherwise resolves the conversation's real URL first (project chats never
 * reliably answer the public /c/<id> URL); when the resolver fails this fails
 * loudly with 'conversation_url_resolution_failed' — a guessed /c/<id> URL
 * lands on the project landing page, whose composer silently creates a
 * brand-new chat. NEVER falls back to an unverified composer: when the page
 * cannot be positively attached to the target conversation this fails loudly
 * so the caller sends nothing at all.
 */
export async function ensurePageOnExactConversation(page, conversationReference, { timeout = 60000, resolve = null, verify = null, gateTimeoutMs = 5000 } = {}) {
    const reference = parseChatGptConversationReference(conversationReference);
    if (!reference) {
        return { ok: false, error: 'conversation_reference_invalid', actualUrl: page?.url?.() || null };
    }
    const verifyTarget = verify || verifyChatGptComposerTarget;

    // Already provably on the target conversation: no resolver, no navigation.
    const current = await verifyTarget(page, reference.id);
    if (current.ok) {
        return { ok: true, conversationId: reference.id, url: current.url, resolvedUrl: current.url, projectId: null, verifiedBy: 'already_on_target' };
    }

    let resolution = null;
    const resolver = resolve || resolveChatGptConversationUrl;
    try {
        resolution = await resolver(page, reference.url);
    } catch (error) {
        resolution = { ok: false, error: error?.message || String(error) };
    }
    if (!resolution?.ok || typeof resolution.url !== 'string') {
        const resolutionError = resolution?.error || 'resolver_failed';
        logger.warn('适配器', `会话 URL 解析失败，拒绝猜测导航：目标会话 ${reference.id}，错误 ${resolutionError}，页面停留在 ${page.url()}`);
        return {
            ok: false,
            error: 'conversation_url_resolution_failed',
            conversationId: reference.id,
            resolutionError,
            resolutionHttp: resolution?.http || null,
            actualUrl: page.url(),
        };
    }
    const targetUrl = resolution.url;

    await gotoWithCheck(page, targetUrl, { timeout });
    await dismissStaleChatGptAuthDialog(page);
    await waitForChatInput(page, { click: false, timeout });

    const gate = await waitForVerifiedComposerTarget(page, reference.id, { timeoutMs: gateTimeoutMs });
    if (!gate.ok) {
        logger.warn('适配器', `拒绝在未验证的 composer 中输入：目标会话 ${reference.id}（${gate.reason}），浏览器实际位于 ${page.url()}`);
        return {
            ok: false,
            error: gate.reason === 'url_conversation_mismatch' || gate.reason === 'target_conversation_id_missing'
                ? 'conversation_navigation_mismatch'
                : 'conversation_thread_not_visible',
            conversationId: reference.id,
            resolvedUrl: targetUrl,
            actualUrl: page.url(),
        };
    }

    return { ok: true, conversationId: reference.id, url: page.url(), resolvedUrl: targetUrl, projectId: resolution?.projectId || null };
}

/**
 * Read one exact conversation's cloud metadata (title, archive state, project).
 * GET /backend-api/conversation/<id>
 */
export async function readChatGptConversationMeta(page, conversationId) {
    const result = await chatgptCloudRequest(page, {
        path: `/conversation/${conversationId}`
    });
    if (!result?.ok) {
        return { success: false, conversationId, error: cloudRequestError(result) };
    }
    return {
        success: true,
        conversationId,
        title: result.data?.title ?? null,
        isArchived: result.data?.is_archived ?? null,
        gizmoId: result.data?.gizmo_id ?? null,
        updateTime: result.data?.update_time ?? null
    };
}

// PATCH /backend-api/conversation/<id> answers {"success": true} only, so every
// mutation below reads the conversation back through the authenticated cloud API
// and returns the authoritative post-change state instead of trusting the patch.
async function patchConversationAndVerify(page, conversationId, patch, verify) {
    const result = await chatgptCloudRequest(page, {
        method: 'PATCH',
        path: `/conversation/${conversationId}`,
        body: patch
    });
    if (!result?.ok) {
        return { success: false, conversationId, error: cloudRequestError(result) };
    }
    const meta = await readChatGptConversationMeta(page, conversationId);
    if (!meta.success) {
        return { success: true, conversationId, verified: false, verifyError: meta.error };
    }
    if (verify && !verify(meta)) {
        return {
            success: false,
            conversationId,
            error: 'change was not confirmed when reading the conversation back',
            meta
        };
    }
    return { success: true, conversationId, verified: true, meta };
}

/**
 * Rename one exact conversation. PATCH /backend-api/conversation/<id> {"title": ...}
 */
export async function renameChatGptConversation(page, conversationId, title) {
    const wanted = String(title || '').slice(0, 200);
    const result = await patchConversationAndVerify(page, conversationId, { title: wanted },
        meta => (meta.title || '') === wanted);
    return {
        ...result,
        title: result.meta?.title ?? null,
        isArchived: result.meta?.isArchived ?? null
    };
}

/**
 * Archive or restore one exact conversation. PATCH /backend-api/conversation/<id>
 * {"is_archived": true|false}
 */
export async function setChatGptConversationArchived(page, conversationId, archived) {
    const result = await patchConversationAndVerify(page, conversationId, { is_archived: archived === true },
        meta => meta.isArchived === (archived === true));
    return {
        ...result,
        title: result.meta?.title ?? null,
        isArchived: result.meta?.isArchived ?? null
    };
}

/**
 * Move one exact conversation into a project, or out of any project when
 * projectId is null. Verified live: assigning gizmo_id moves the conversation
 * into the project; an empty string clears it and moves the conversation out.
 * PATCH /backend-api/conversation/<id> {"gizmo_id": "g-p-..." | ""}
 */
export async function moveChatGptConversationToProject(page, conversationId, projectId) {
    const target = projectId === null ? '' : String(projectId);
    const result = await patchConversationAndVerify(page, conversationId, { gizmo_id: target },
        meta => (meta.gizmoId || '') === target);
    return {
        ...result,
        projectId: result.meta?.gizmoId ?? null
    };
}

/**
 * List ChatGPT projects. Verified live: the web sidebar loads projects as
 * "snorlax" gizmos. GET /backend-api/gizmos/snorlax/sidebar
 */
export async function listChatGptProjects(page, { limit = 50 } = {}) {
    const result = await chatgptCloudRequest(page, {
        // Verified live: the sidebar endpoint rejects limit > 50 with HTTP 422.
        path: '/gizmos/snorlax/sidebar',
        query: { owned_only: 'true', conversations_per_gizmo: '0', limit: String(Math.min(limit, 50)) }
    });
    if (!result?.ok) {
        return { success: false, error: cloudRequestError(result) };
    }
    const items = result.data?.items || [];
    const projects = items
        .map(item => item?.gizmo?.gizmo)
        .filter(gizmo => gizmo?.id)
        .map(gizmo => ({
            id: gizmo.id,
            title: gizmo.display?.name || gizmo.display?.description || 'Untitled',
            create_time: gizmo.created_at || null,
            update_time: gizmo.updated_at || null,
            last_interacted_at: gizmo.last_interacted_at || null
        }));
    return { success: true, projects };
}

export async function listChatGptProjectConversations(page, projectId, { limit = 28 } = {}) {
    const result = await chatgptCloudRequest(page, {
        // Verified live: this endpoint rejects limit > 50 with HTTP 422.
        path: `/gizmos/${projectId}/conversations`,
        query: { cursor: '0', limit: String(Math.min(limit, 50)) }
    });
    if (!result?.ok) {
        return { success: false, projectId, error: cloudRequestError(result) };
    }
    const raw = Array.isArray(result.data) ? result.data : (result.data?.items || []);
    const conversations = raw
        .filter(conversation => conversation?.id)
        .map(conversation => ({
            id: conversation.id,
            title: conversation.title || 'Untitled',
            create_time: conversation.create_time || null,
            update_time: conversation.update_time || null,
            is_archived: conversation.is_archived === true
        }));
    return { success: true, conversations };
}

// Map one upstream snorlax gizmo to the shared project summary shape used by
// every project route and tool.
function gizmoToProject(gizmo) {
    return {
        id: gizmo.id,
        title: gizmo.display?.name || gizmo.display?.description || 'Untitled',
        instructions: gizmo.instructions ?? '',
        emoji: gizmo.display?.emoji ?? null,
        theme: gizmo.display?.theme ?? null,
        create_time: gizmo.created_at || null,
        update_time: gizmo.updated_at || null,
        last_interacted_at: gizmo.last_interacted_at || null
    };
}

// Read one project's current state from the sidebar list. The projects API has
// no GET on the detail path (verified live: 405), so the sidebar is the only
// read surface for a project's emoji/theme/instructions.
async function readProjectFromSidebar(page, projectId) {
    const result = await chatgptCloudRequest(page, {
        // Verified live: the sidebar endpoint rejects limit > 50 with HTTP 422.
        path: '/gizmos/snorlax/sidebar',
        query: { owned_only: 'true', conversations_per_gizmo: '0', limit: '50' }
    });
    if (!result?.ok) {
        return { success: false, error: cloudRequestError(result) };
    }
    const gizmo = (result.data?.items || [])
        .map(item => item?.gizmo?.gizmo)
        .find(gizmo => gizmo?.id === projectId);
    if (!gizmo) return { success: true, project: null };
    return { success: true, project: gizmoToProject(gizmo) };
}

/**
 * Create a new ChatGPT project. Verified live: POST /backend-api/projects with
 * exactly {"name", "instructions"}; both fields are required (an empty
 * instructions string is accepted) and extra body fields are rejected with
 * HTTP 422. The response carries the new gizmo under resource.gizmo.
 */
export async function createChatGptProject(page, name, { instructions = '' } = {}) {
    const wanted = String(name || '').slice(0, 200);
    const result = await chatgptCloudRequest(page, {
        method: 'POST',
        path: '/projects',
        body: { name: wanted, instructions: String(instructions || '') }
    });
    if (!result?.ok) {
        return { success: false, error: cloudRequestError(result) };
    }
    const gizmo = result.data?.resource?.gizmo || result.data?.gizmo || null;
    if (!gizmo?.id) {
        return { success: false, error: 'project creation response contained no project id' };
    }
    const readBack = await readProjectFromSidebar(page, gizmo.id);
    return {
        success: true,
        project: gizmoToProject(gizmo),
        verified: readBack.success && readBack.project !== null
    };
}

/**
 * Rename one exact ChatGPT project, preserving its emoji, theme, and
 * instructions. Verified live: PATCH /backend-api/projects/<id> requires the
 * full {"name", "emoji", "theme", "instructions"} set - missing keys are 422,
 * extra keys are rejected, and theme must be a #rgb/#rrggbb string or null -
 * and there is no GET on the project detail path, so the current values are
 * read from the sidebar list first and sent back unchanged.
 */
export async function renameChatGptProject(page, projectId, name) {
    const wanted = String(name || '').slice(0, 200);
    const current = await readProjectFromSidebar(page, projectId);
    if (!current.success) {
        return { success: false, projectId, error: current.error };
    }
    if (!current.project) {
        return { success: false, projectId, error: 'project not found in the ChatGPT sidebar list' };
    }
    const result = await chatgptCloudRequest(page, {
        method: 'PATCH',
        path: `/projects/${projectId}`,
        body: {
            name: wanted,
            emoji: current.project.emoji,
            theme: current.project.theme,
            instructions: current.project.instructions
        }
    });
    if (!result?.ok) {
        return { success: false, projectId, error: cloudRequestError(result) };
    }
    const readBack = await readProjectFromSidebar(page, projectId);
    return {
        success: true,
        projectId,
        project: readBack.project,
        verified: readBack.success && readBack.project !== null && readBack.project.title === wanted
    };
}

/**
 * Delete one exact ChatGPT project. Verified live: the projects path itself
 * has no DELETE (405); deletion goes through the gizmo path
 * DELETE /backend-api/gizmos/<id>, which answers {"deleted": true}.
 * DESTRUCTIVE BEYOND THE PROJECT: a conversation moved into a test project
 * returned 404 after the project was deleted, so every conversation inside
 * the project is deleted with it. Callers must surface this.
 */
export async function deleteChatGptProject(page, projectId) {
    const result = await chatgptCloudRequest(page, {
        method: 'DELETE',
        path: `/gizmos/${projectId}`
    });
    if (!result?.ok) {
        return { success: false, projectId, error: cloudRequestError(result) };
    }
    if (result.data?.deleted !== true) {
        return { success: false, projectId, error: 'deletion was not confirmed by the upstream response' };
    }
    const readBack = await readProjectFromSidebar(page, projectId);
    return {
        success: true,
        projectId,
        verified: readBack.success && readBack.project === null
    };
}

/**
 * Delete one exact conversation from ChatGPT cloud storage.
 * Current ChatGPT soft-delete contract: PATCH /backend-api/conversation/<id>
 * with { is_visible: false }. The deleted conversation then reads as 404.
 */
export async function deleteChatGptConversation(page, conversationUrl, _options = {}) {
    const match = String(conversationUrl || '').match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (!match) {
        return {
            success: false,
            conversationId: null,
            error: 'conversation_url must be an exact ChatGPT conversation URL'
        };
    }
    const conversationId = match[1];
    const result = await chatgptCloudRequest(page, {
        method: 'PATCH',
        path: `/conversation/${conversationId}`,
        body: { is_visible: false }
    });
    if (!result?.ok) {
        return {
            success: false,
            conversationId,
            status: result?.http ? `HTTP_${result.http}` : 'error',
            error: cloudRequestError(result)
        };
    }
    return { success: true, conversationId, status: 'deleted' };
}

/**
 * 适配器 manifest
 */
export const manifest = {
    id: 'chatgpt_text',
    displayName: 'ChatGPT (文本生成)',
    description: '使用 ChatGPT 官网生成文本，支持多模型切换和图片上传。需要已登录的 ChatGPT 账户，若需要选择模型，请使用会员账号 (包含 K12 教室认证账号)。',

    // 配置项模式
    configSchema: [
        {
            key: 'temporaryChat',
            label: '临时对话',
            type: 'boolean',
            default: false,
            note: '开启后将使用临时对话模式 (?temporary-chat=true)'
        },
        {
            key: 'conversationUrl',
            label: '固定会话 URL',
            type: 'string',
            default: '',
            note: '填写 https://chatgpt.com/c/... 后将默认在该网页会话中继续对话'
        }
    ],

    // 入口 URL
    getTargetUrl(config, workerConfig) {
        const useTemp = config?.backend?.adapter?.chatgpt_text?.temporaryChat || false;
        return useTemp ? 'https://chatgpt.com/?temporary-chat=true' : 'https://chatgpt.com/';
    },

    // 模型列表
    models: [
        { id: 'gpt-instant', codeName: 'Instant', imagePolicy: 'optional', type: 'text' },
        { id: 'gpt-thinking', codeName: 'Thinking', imagePolicy: 'optional', type: 'text' },
        { id: 'gpt-pro', codeName: 'Pro', imagePolicy: 'optional', type: 'text' }
    ],

    // 无需导航处理器
    navigationHandlers: [],

    controlsOnly: true
};
