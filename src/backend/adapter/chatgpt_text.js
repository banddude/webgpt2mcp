/**
 * @fileoverview ChatGPT 文本生成适配器
 */

import fs from 'fs/promises';
import path from 'path';
import {
    sleep,
    humanType,
    safeClick,
    uploadFilesViaChooser
} from '../engine/utils.js';
import {
    normalizePageError,
    waitForInput,
    gotoWithCheck
} from '../utils/index.js';
import { logger } from '../../utils/logger.js';

// --- 配置常量 ---
const TARGET_URL = 'https://chatgpt.com/'; // 基础URL
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
const DEBUG_DIR = path.join(process.cwd(), 'data', 'debug-chatgpt');

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

// Conversations filed in a ChatGPT project are served under
// /g/<g-p-id>[-slug]/c/<conversationId>. Canonicalize every accepted form to
// the public /c/<id> URL: the conversation ID is what identifies the chat, and
// navigation resolves the real project-scoped URL separately through the
// cloud API (issue #18).
function normalizeConversationUrl(url) {
    if (!url || typeof url !== 'string') return null;
    try {
        const parsed = new URL(url);
        if (parsed.hostname !== 'chatgpt.com') return null;
        const plain = parsed.pathname.match(/^\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i);
        if (plain) return `https://chatgpt.com/c/${plain[1].toLowerCase()}`;
        const projectScoped = parsed.pathname.match(/^\/g\/(g-p-[0-9a-z]+(?:-[0-9a-z-]+)?)\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i);
        if (projectScoped) return `https://chatgpt.com/c/${projectScoped[2].toLowerCase()}`;
        return null;
    } catch {
        return null;
    }
}

function extractVisibleText(parts) {
    if (!Array.isArray(parts)) return '';
    return parts
        .map(part => typeof part === 'string' ? part : '')
        .join('');
}

function isVisibleAssistantMessage(message) {
    if (message?.author?.role !== 'assistant') return false;
    if (!Array.isArray(message?.content?.parts)) return false;

    // Thinking models may emit analysis/commentary before the final answer.
    // Keep those out of the API response and track only user-visible text.
    const hiddenChannels = new Set(['analysis', 'commentary', 'thinking']);
    if (hiddenChannels.has(message.channel)) return false;

    const contentType = message.content?.content_type;
    return !contentType || contentType === 'text' || contentType === 'multimodal_text';
}

function isFinishedAssistantMessage(message) {
    if (!isVisibleAssistantMessage(message)) return false;
    return message.status === 'finished_successfully' ||
        message.end_turn === true ||
        message.metadata?.is_complete === true;
}

function cleanDomText(text) {
    return (text || '')
        .replace(/\n?ChatGPT can make mistakes\.[\s\S]*$/i, '')
        .replace(/^Thought for .+\n+/i, '')
        .trim();
}

function isPlaceholderDomText(text) {
    const normalized = cleanDomText(text).replace(/\s+/g, ' ').trim();
    if (!normalized) return true;
    return /^(Thinking|Thinking\.\.\.|思考中|正在思考|思考)$/i.test(normalized);
}

async function extractAssistantTextFromContainer(container) {
    const body = container.locator('.markdown, [data-testid="markdown"], [data-message-content-part="assistant"]');
    const bodyCount = await body.count().catch(() => 0);
    for (let i = bodyCount - 1; i >= 0; i--) {
        const text = cleanDomText(await body.nth(i).innerText({ timeout: 2000 }).catch(() => ''));
        if (text && !isPlaceholderDomText(text)) return text;
    }

    const fallbackText = cleanDomText(await container.innerText({ timeout: 2000 }).catch(() => ''));
    if (fallbackText && !isPlaceholderDomText(fallbackText)) return fallbackText;
    return '';
}

async function extractLatestAssistantTextFromDom(page, baselineCount = 0) {
    const assistantMessages = page.locator('[data-message-author-role="assistant"]');
    const count = await assistantMessages.count().catch(() => 0);

    for (let i = count - 1; i >= baselineCount; i--) {
        const text = await extractAssistantTextFromContainer(assistantMessages.nth(i));
        if (text) return text;
    }

    // Turns 兜底仅在 baselineCount === 0 时使用，避免会话继续时返回旧消息
    if (baselineCount === 0) {
        const turns = page.locator('[data-testid^="conversation-turn-"]');
        const turnCount = await turns.count().catch(() => 0);
        for (let i = turnCount - 1; i >= 0; i--) {
            const assistantInTurn = turns.nth(i).locator('[data-message-author-role="assistant"]');
            if ((await assistantInTurn.count().catch(() => 0)) === 0) continue;
            const text = await extractAssistantTextFromContainer(assistantInTurn.first());
            if (text) return text;
        }
    }

    return '';
}

async function waitForAssistantTextFromDom(page, baselineCount, timeoutMs, meta = {}) {
    const start = Date.now();
    let latestText = '';
    let stableSince = 0;
    let loggedOnce = false;
    let effectiveBaseline = baselineCount;
    let prevCount = -1;
    let pageRerendered = false;

    while (Date.now() - start < timeoutMs) {
        const locator = page.locator('[data-message-author-role="assistant"]');
        const count = await locator.count().catch(() => 0);

        // 检测页面重渲染：assistant 数量从 >0 降到 0（stream_handoff 后页面重建）
        if (prevCount > 0 && count === 0) {
            logger.info('适配器', `DOM 检测到页面重渲染 (assistant ${prevCount}->0)，重置 baseline 为 0`, meta);
            effectiveBaseline = 0;
            pageRerendered = true;
            latestText = '';
            stableSince = 0;
        }
        prevCount = count;

        // 诊断日志：每 15 秒输出一次 DOM 状态
        const elapsed = Date.now() - start;
        if (elapsed > 0 && elapsed % 15000 < 700) {
            const turnLocator = page.locator('[data-testid^="conversation-turn-"]');
            const turnCount = await turnLocator.count().catch(() => 0);
            const markdownLocator = page.locator('.markdown');
            const mdCount = await markdownLocator.count().catch(() => 0);
            const articleLocator = page.locator('main article');
            const articleCount = await articleLocator.count().catch(() => 0);
            logger.info('适配器', `DOM 轮询诊断 [${Math.round(elapsed / 1000)}s]: assistant=${count} baseline=${effectiveBaseline} turns=${turnCount} markdown=${mdCount} articles=${articleCount} rerendered=${pageRerendered}`, meta);

            // 首次发现新 assistant 元素时，尝试读取原始文本
            if (!loggedOnce && count > effectiveBaseline) {
                loggedOnce = true;
                const rawText = await locator.nth(count - 1).innerText({ timeout: 3000 }).catch(() => '<inner text failed>');
                logger.info('适配器', `DOM 最新 assistant 原始文本 (前200字): ${String(rawText).slice(0, 200)}`, meta);
                const bodyLocator = locator.nth(count - 1).locator('.markdown');
                const bodyCount = await bodyLocator.count().catch(() => 0);
                if (bodyCount > 0) {
                    const bodyText = await bodyLocator.first().innerText({ timeout: 3000 }).catch(() => '<body inner text failed>');
                    logger.info('适配器', `DOM .markdown 原始文本 (前200字): ${String(bodyText).slice(0, 200)}`, meta);
                } else {
                    logger.info('适配器', `DOM .markdown 子元素数量: ${bodyCount}`, meta);
                }
            }
        }

        if (count > effectiveBaseline) {
            const text = await extractLatestAssistantTextFromDom(page, effectiveBaseline);
            if (text && text !== latestText) {
                latestText = text;
                stableSince = Date.now();
                loggedOnce = false;  // 重置，以便下次诊断时记录新内容
            }

            if (latestText && Date.now() - stableSince >= 1800) {
                return latestText;
            }
        }

        await sleep(450, 650);
    }

    return latestText;
}

async function getConversationUrl(page) {
    if (page.url().includes('/c/')) return page.url();
    await page.waitForURL(url => url.href.includes('/c/'), { timeout: 5000 }).catch(() => { });
    return page.url().includes('/c/') ? page.url() : null;
}

function createDebugState(meta, modelId, prompt, targetUrl) {
    return {
        id: meta?.id || `debug-${Date.now()}`,
        startedAt: new Date().toISOString(),
        modelId,
        targetUrl,
        prompt,
        events: [],
        network: [],
        sse: [],
        domSnapshots: [],
        result: null,
        error: null
    };
}

function shouldDumpDebug(config) {
    const adapterConfig = config?.backend?.adapter?.chatgpt_text || {};
    return adapterConfig.debugDump === true || process.env.CHATGPT_DEBUG_DUMP === '1';
}

function pushLimited(list, item, limit = 200) {
    list.push(item);
    if (list.length > limit) list.shift();
}

function summarizeSseData(data) {
    const message = data?.v?.message;
    const patches = Array.isArray(data?.v)
        ? data.v.slice(0, 8).map(p => ({
            o: p.o,
            p: p.p,
            valueType: typeof p.v,
            valuePreview: typeof p.v === 'string' ? p.v.slice(0, 300) : undefined,
            partsPreview: Array.isArray(p.v) ? extractVisibleText(p.v).slice(0, 300) : undefined
        }))
        : undefined;

    return {
        type: data?.type,
        o: data?.o,
        p: data?.p,
        valueType: typeof data?.v,
        valuePreview: typeof data?.v === 'string' ? data.v.slice(0, 300) : undefined,
        message: message ? {
            id: message.id,
            role: message.author?.role,
            channel: message.channel,
            contentType: message.content?.content_type,
            partsPreview: extractVisibleText(message.content?.parts).slice(0, 500),
            status: message.status
        } : undefined,
        patches
    };
}

async function captureDomSnapshot(page, label, baselineCount = 0) {
    return await page.evaluate(({ label, baselineCount }) => {
        const clean = text => (text || '').replace(/\s+/g, ' ').trim();
        const attrs = el => {
            const result = {};
            for (const name of ['data-testid', 'data-message-author-role', 'data-message-id', 'aria-label', 'role', 'class']) {
                const value = el.getAttribute(name);
                if (value) result[name] = value.slice(0, 300);
            }
            return result;
        };
        const collect = (selector, limit = 20) => Array.from(document.querySelectorAll(selector))
            .slice(-limit)
            .map((el, index) => ({
                index,
                tag: el.tagName,
                attrs: attrs(el),
                text: clean(el.innerText).slice(0, 1500),
                html: el.outerHTML.slice(0, 3000)
            }));

        return {
            label,
            at: new Date().toISOString(),
            url: location.href,
            title: document.title,
            baselineCount,
            counts: {
                assistantRole: document.querySelectorAll('[data-message-author-role="assistant"]').length,
                userRole: document.querySelectorAll('[data-message-author-role="user"]').length,
                turns: document.querySelectorAll('[data-testid^="conversation-turn-"]').length,
                markdown: document.querySelectorAll('.markdown, [data-testid="markdown"]').length,
                articles: document.querySelectorAll('article').length
            },
            assistantRole: collect('[data-message-author-role="assistant"]'),
            turns: collect('[data-testid^="conversation-turn-"]'),
            markdown: collect('.markdown, [data-testid="markdown"]'),
            articles: collect('article'),
            bodyText: clean(document.body?.innerText || '').slice(0, 8000)
        };
    }, { label, baselineCount }).catch(e => ({
        label,
        at: new Date().toISOString(),
        error: e.message
    }));
}

async function writeDebugDump(debug, page, meta, label, baselineCount = 0) {
    if (!debug) return null;
    try {
        await fs.mkdir(DEBUG_DIR, { recursive: true });
        debug.finishedAt = new Date().toISOString();
        debug.currentUrl = page.url();
        debug.domSnapshots.push(await captureDomSnapshot(page, label, baselineCount));

        const screenshotPath = path.join(DEBUG_DIR, `${debug.id}-${label}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => { });
        debug.screenshotPath = screenshotPath;

        const dumpPath = path.join(DEBUG_DIR, `${debug.id}.json`);
        await fs.writeFile(dumpPath, JSON.stringify(debug, null, 2));
        logger.info('适配器', `ChatGPT 调试 dump 已写入: ${dumpPath}`, meta);
        return dumpPath;
    } catch (e) {
        logger.warn('适配器', `写入 ChatGPT 调试 dump 失败: ${e.message}`, meta);
        return null;
    }
}

/**
 * 通过 UI 选择模型
 * @param {import('playwright-core').Page} page - 页面对象
 * @param {string} codeName - 模型 codeName
 * @param {object} meta - 日志元数据
 * @returns {Promise<boolean>} 是否成功选择了模型
 */
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

// Admin submit-and-detach dispatch uses the same selector implementation as
// the normal adapter, but deliberately does not call the completion-aware
// generate() path.
export { selectModel as selectChatGptModel };

/**
 * Stream no-progress watchdog.
 *
 * The completion-aware channels (SSE response waiter, stream handoff) only settle
 * when a generation finishes, so a request whose stream never produces anything
 * would otherwise hold the single browser lane for the full waitTimeout budget.
 * The watchdog samples cheap activity signals plus the authoritative cloud
 * stream_status:
 *   - firstTokenTimeoutMs: nothing at all happened since send -> dead request.
 *   - noProgressTimeoutMs: a started generation fully stalled (no text growing
 *     and the cloud no longer reports IS_STREAMING).
 * A slow-but-live answer keeps producing (or keeps reporting IS_STREAMING) and
 * retains the full waitTimeout budget; only a dead or fully stalled stream
 * rejects, which lets generate() fail the request fast and free the lane.
 *
 * @param {object} options
 * @param {number} options.firstTokenTimeoutMs - fail if no activity at all by then
 * @param {number} options.noProgressTimeoutMs - fail if activity fully stalls by then
 * @param {Function} options.sampleSignals - async () => serializable signal snapshot
 * @param {Function} options.readCloudStreamStatus - async () => stream status string or null
 * @param {Function} [options.onFail] - (reason, waitedSeconds) log hook
 * @param {number} [options.intervalMs] - sampling interval, default 5000
 * @returns {{ promise: Promise, interval: NodeJS.Timeout, stop: Function }}
 */
export function startStreamWatchdog({ firstTokenTimeoutMs, noProgressTimeoutMs, sampleSignals, readCloudStreamStatus, onFail = () => {}, intervalMs = 5000 }) {
    let failed = false;
    let firstTokenSeen = false;
    let lastProgressAt = Date.now();
    let lastSignalKey = null;
    let rejectWatchdog = null;
    const promise = new Promise((_, reject) => { rejectWatchdog = reject; });
    promise.catch(() => { /* raced by the caller; never unhandled */ });

    const interval = setInterval(async () => {
        if (failed) return;
        try {
            const signals = await sampleSignals();
            const key = JSON.stringify(signals);
            if (lastSignalKey !== null && key !== lastSignalKey) {
                lastProgressAt = Date.now();
                firstTokenSeen = true;
            }
            lastSignalKey = key;

            // Before declaring a stall, ask the cloud whether the turn is still
            // generating. IS_STREAMING is authoritative liveness and covers long
            // thinking phases whose visible text updates sparsely.
            if (Date.now() - lastProgressAt > Math.min(firstTokenTimeoutMs, noProgressTimeoutMs) / 2) {
                if (await readCloudStreamStatus() === 'IS_STREAMING') {
                    lastProgressAt = Date.now();
                    firstTokenSeen = true;
                }
            }

            const stalledFor = Date.now() - lastProgressAt;
            const budgetMs = firstTokenSeen ? noProgressTimeoutMs : firstTokenTimeoutMs;
            if (stalledFor > budgetMs) {
                failed = true;
                const reason = firstTokenSeen ? 'STREAM_STALLED' : 'STREAM_FIRST_TOKEN_TIMEOUT';
                const waitedS = Math.round(stalledFor / 1000);
                onFail(reason, waitedS);
                rejectWatchdog(new Error(`${reason}: no model output activity for ${waitedS}s`));
                clearInterval(interval);
            }
        } catch { /* sampling failures must never kill a live generation */ }
    }, intervalMs);

    return {
        promise,
        interval,
        stop: () => clearInterval(interval)
    };
}

/**
 * 执行文本生成任务
 * @param {object} context - 浏览器上下文 { page, config }
 * @param {string} prompt - 提示词
 * @param {string[]} imgPaths - 图片路径数组
 * @param {string} [modelId] - 模型 ID
 * @param {object} [meta={}] - 日志元数据
 * @returns {Promise<{text?: string, error?: string}>}
 */
async function generate(context, prompt, imgPaths, modelId, meta = {}) {
    const { page, config } = context;
    const waitTimeout = config?.backend?.pool?.waitTimeout ?? 120000;
    // Fast-fail budget for dead streams. waitTimeout deliberately stays long so a
    // genuinely slow answer can run to completion, but a request that never starts
    // producing output must not hold the single browser lane for that whole budget.
    const firstTokenTimeoutMs = Number.isFinite(Number(config?.backend?.pool?.firstTokenTimeout))
        ? Number(config.backend.pool.firstTokenTimeout) : 180000;
    const noProgressTimeoutMs = Number.isFinite(Number(config?.backend?.pool?.noProgressTimeout))
        ? Number(config.backend.pool.noProgressTimeout) : 600000;
    const sendBtnLocator = page.getByRole('button', { name: 'Send prompt' });
    let debug = null;
    let debugResponseHandler = null;
    let rawNetworkHandler = null;
    let wsHandler = null;
    let watchdogInterval = null;
    let assistantCountBefore = 0;
    let conversationUrl = null;

    try {
        const useTemp = config?.backend?.adapter?.chatgpt_text?.temporaryChat || false;
        conversationUrl = normalizeConversationUrl(meta?.conversationUrl) ||
            normalizeConversationUrl(config?.backend?.adapter?.chatgpt_text?.conversationUrl);
        const targetUrl = conversationUrl ||
            (useTemp ? 'https://chatgpt.com/?temporary-chat=true' : 'https://chatgpt.com/'); // 感谢 @zhongjianhua163 提供临时对话方案
        if (shouldDumpDebug(config)) {
            debug = createDebugState(meta, modelId, prompt, targetUrl);
            debugResponseHandler = (response) => {
                const url = response.url();
                if (!/chatgpt\.com|backend-api|conversation|stream|message|thread/i.test(url)) return;
                const req = response.request();
                pushLimited(debug.network, {
                    at: new Date().toISOString(),
                    url,
                    method: req.method(),
                    resourceType: req.resourceType(),
                    status: response.status(),
                    contentType: response.headers()['content-type'] || ''
                });
            };
            page.on('response', debugResponseHandler);
        }

        logger.info('适配器', conversationUrl ? '继续已有会话...' : '开启新会话...', meta);

        if (conversationUrl) {
            // Resolve the conversation's real URL first (a chat filed in a
            // project is served under /g/<project>/c/<id>, and the public
            // /c/<id> URL does not reliably reach it), then PROVE the target
            // conversation is the one on screen before anything is typed. A
            // navigation mismatch fails loudly and sends nothing: typing into
            // an unverified composer silently creates a brand-new chat
            // (issue #18).
            const attached = await ensurePageOnExactConversation(page, conversationUrl);
            if (!attached.ok) {
                return {
                    error: attached.error === 'conversation_navigation_mismatch'
                        ? `conversation_navigation_mismatch: browser is on ${attached.actualUrl}`
                        : `conversation attach failed: ${attached.error}`,
                    actual_url: attached.actualUrl || page.url(),
                };
            }
        } else {
            // 快速复用：如果页面已在首页且输入框可见，跳过导航（省 ~18s）
            const currentUrl = page.url();
            const inputVisible = Boolean(await findChatInput(page));
            if (inputVisible && (currentUrl === 'https://chatgpt.com/' || currentUrl === 'https://chatgpt.com')) {
                logger.info('适配器', '页面已就绪，跳过导航 (快速复用)', meta);
            } else {
                await gotoWithCheck(page, targetUrl);
            }
        }

        // 1. 等待输入框加载
        let inputLocator = await waitForChatInput(page, { click: false });

        // 2. 选择模型
        if (modelId) {
            const modelConfig = manifest.models.find(m => m.id === modelId);
            if (modelConfig && modelConfig.codeName) {
                await selectModel(page, modelConfig.codeName, meta);
            } else {
                logger.info('适配器', `未指定模型或未知模型 (${modelId})，跳过模型选择`, meta);
            }
        }

        // 用于捕获 stream_handoff 后的 conversation ID
        let capturedConversationId = null;

        // === 全量网络监控：扒所有数据，捕获每个响应的 body ===
        rawNetworkHandler = async (response) => {
            const url = response.url();
            if (!url.includes('chatgpt.com')) return;
            const req = response.request();
            const method = req.method();
            const status = response.status();
            const contentType = response.headers()['content-type'] || '';

            // 非后端 API 的静态资源跳过
            if (/\.(js|css|png|jpg|ico|woff2?|svg|gif|webp)(\?|$)/i.test(url)) return;

            // 对所有 backend-api 响应，记录 URL 和 body 预览
            if (url.includes('backend-api')) {
                logger.info('全量监控', `${method} ${status} ${url.slice(0, 150)} | ${contentType}`, meta);

                // 从任意 backend-api URL 中尽早提取 conversation ID
                if (!capturedConversationId) {
                    const convMatch = url.match(/\/conversation\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
                    if (convMatch) {
                        capturedConversationId = convMatch[1];
                        logger.info('全量监控', `★ conversation ID (URL): ${capturedConversationId}`, meta);
                    }
                }

                // 尝试读取 body
                try {
                    const body = await response.text();

                    // 捕获 stream_status 内容
                    if (url.includes('/stream_status')) {
                        const match = url.match(/\/conversation\/([0-9a-f-]+)\//);
                        if (match && !capturedConversationId) {
                            capturedConversationId = match[1];
                            logger.info('全量监控', `★ conversation ID: ${capturedConversationId}`, meta);
                        }
                        logger.info('全量监控', `★ stream_status BODY: ${body.slice(0, 1000)}`, meta);
                    }

                    // Capture the newest normal-chat conversation only as an early fallback.
                    // Never overwrite an ID once stream_status / a conversation URL has identified
                    // the actual task. Sidebar/project/gizmo conversation lists are unrelated and
                    // previously caused cross-chat response mixups.
                    if (!capturedConversationId &&
                        /\/backend-api\/conversations\?/.test(url) &&
                        method === 'GET') {
                        try {
                            const data = JSON.parse(body);
                            if (Array.isArray(data?.items) && data.items.length > 0) {
                                const c = data.items[0];
                                capturedConversationId = c.id;
                                logger.info('全量监控', `★ 从主会话列表捕获 conversation ID: ${c.id} title=${c.title}`, meta);
                            }
                        } catch {}
                    }

                    // SSE 数据详细记录
                    if (contentType.includes('text/event-stream')) {
                        const lines = body.split('\n').filter(l => l.startsWith('data: '));
                        logger.info('全量监控', `★ SSE 共 ${lines.length} 行`, meta);
                        for (let i = 0; i < Math.min(lines.length, 50); i++) {
                            const d = lines[i].slice(6).trim();
                            if (d === '[DONE]') { logger.info('全量监控', `  SSE[${i}]: [DONE]`, meta); continue; }
                            try {
                                const p = JSON.parse(d);
                                const msg = p.v?.message;
                                const s = { type: p.type, channel: msg?.channel, role: msg?.author?.role, ct: msg?.content?.content_type, op: p.o, path: p.p };
                                Object.keys(s).forEach(k => s[k] === undefined && delete s[k]);
                                // 有 parts 内容时也记录
                                if (Array.isArray(msg?.content?.parts)) {
                                    s.parts = JSON.stringify(msg.content.parts).slice(0, 200);
                                }
                                if (Array.isArray(p.v)) {
                                    s.patches = p.v.slice(0, 5).map(x => ({ o: x.o, p: x.p, v: String(x.v || '').slice(0, 100) }));
                                }
                                logger.info('全量监控', `  SSE[${i}]: ${JSON.stringify(s)}`, meta);
                            } catch {
                                logger.info('全量监控', `  SSE[${i}](raw): ${d.slice(0, 300)}`, meta);
                            }
                        }
                    } else {
                        // 非 SSE 响应：记录 body 前 500 字节
                        logger.info('全量监控', `  BODY: ${body.slice(0, 500)}`, meta);
                    }
                } catch (e) {
                    logger.info('全量监控', `  读取 body 失败: ${e.message}`, meta);
                }
            }
        };
        page.on('response', rawNetworkHandler);

        // 3. 上传图片 (双击 Add files and more 按钮)
        if (imgPaths && imgPaths.length > 0) {
            logger.info('适配器', `开始上传 ${imgPaths.length} 张图片...`, meta);
            const expectedUploads = imgPaths.length;
            let uploadedCount = 0;
            let processedCount = 0;

            logger.debug('适配器', '双击添加文件按钮...', meta);
            const addFilesBtn = page.getByRole('button', { name: 'Add files and more' });

            await uploadFilesViaChooser(page, addFilesBtn, imgPaths, {
                clickAction: 'dblclick',  // 使用双击
                uploadValidator: (response) => {
                    const url = response.url();
                    if (response.status() === 200) {
                        // 上传请求
                        if (url.includes('backend-api/files') && !url.includes('process_upload_stream')) {
                            uploadedCount++;
                            logger.debug('适配器', `图片上传进度: ${uploadedCount}/${expectedUploads}`, meta);
                            return false;
                        }
                        // 处理完成请求
                        if (url.includes('backend-api/files/process_upload_stream')) {
                            processedCount++;
                            logger.info('适配器', `图片处理进度: ${processedCount}/${expectedUploads}`, meta);

                            if (processedCount >= expectedUploads) {
                                return true;
                            }
                        }
                    }
                    return false;
                }
            }, meta);
        }

        // 3. 输入提示词
        logger.info('适配器', '输入提示词...', meta);
        inputLocator = await focusChatGptInput(page);
        await humanType(page, inputLocator, prompt, { skipFocus: true });

        // If the target conversation is already streaming, prefer ChatGPT's native
        // mid-stream steering UI. While thinking, the composer remains editable and
        // ChatGPT may expose an enabled send button alongside the active stop button.
        // If native steering is not available, interrupt the active answer first,
        // preserve the typed steering prompt, then submit it as the next turn.
        let activeSteerMode = null;
        if (conversationUrl) {
            const stopButton = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).first();
            const stopVisible = await stopButton.isVisible().catch(() => false);
            if (stopVisible) {
                const sendButton = await findChatGptSendButton(page);
                if (sendButton) {
                    activeSteerMode = 'native';
                    logger.info('适配器', '检测到正在生成的会话；使用 ChatGPT 原生中途 steer 提交新指令', meta);
                } else {
                    activeSteerMode = 'interrupt';
                    logger.info('适配器', '检测到正在生成的会话；原生 steer 按钮不可用，先 Stop answering 再提交新指令', meta);
                    await safeClick(page, stopButton, { bias: 'button' });
                    await page.waitForSelector(CHATGPT_STOP_BUTTON_SELECTOR, { state: 'hidden', timeout: 15000 }).catch(() => { });
                    await sleep(250, 450);

                    // Some ChatGPT rerenders replace the composer when stopping. Make
                    // sure the steering prompt survived before submitting it.
                    inputLocator = await waitForChatInput(page, { click: false });
                    const composerText = await readChatInputText(inputLocator);
                    if (!composerText.includes(prompt)) {
                        inputLocator = await focusChatGptInput(page);
                        await humanType(page, inputLocator, prompt, { skipFocus: true });
                    }
                }
            }
        }

        // 4. 先启动 SSE 监听，再发送提示词（避免竞态）
        logger.info('适配器', '监听 SSE 流获取文本...', meta);

        let textContent = '';
        let isComplete = false;
        let targetMessageId = null;  // 只追踪最终可见的 assistant 文本消息
        assistantCountBefore = await page.locator('[data-message-author-role="assistant"]')
            .count()
            .catch(() => 0);
        if (debug) {
            debug.assistantCountBefore = assistantCountBefore;
            debug.domSnapshots.push(await captureDomSnapshot(page, 'before-send', assistantCountBefore));
        }

        // Thinking 模型 stream_handoff 支持
        let streamHandoffDetected = false;
        let streamHandoffResolve;
        const streamHandoffPromise = new Promise(resolve => { streamHandoffResolve = resolve; });

        // WebSocket 帧监控（thinking 模型通过 WebSocket 传输内容）
        let wsCapturedText = '';
        let wsFinalTextFound = false;  // 标记是否已找到完整 parts 文本
        wsHandler = (ws) => {
            const wsUrl = ws.url();
            if (!wsUrl.includes('chatgpt.com')) return;
            logger.info('WebSocket', `连接: ${wsUrl.slice(0, 150)}`, meta);
            ws.on('framereceived', frame => {
                const text = typeof frame.payload === 'string' ? frame.payload : '';
                if (!text) return;
                logger.info('WebSocket', `帧 (${text.length} 字节): ${text.slice(0, 2000)}`, meta);

                // 从 WebSocket 帧解析 assistant 文本，支持多帧累积
                try {
                    const items = JSON.parse(text);
                    const entries = Array.isArray(items) ? items : [items];
                    for (const entry of entries) {
                        const catchups = entry?.reply?.catchups || [];
                        for (const catchup of catchups) {
                            const payload = catchup?.payload?.payload;
                            if (!payload) continue;
                            // 处理 catchup 中的 encoded_item（SSE 格式）
                            if (payload.encoded_item && !wsFinalTextFound) {
                                const lines = payload.encoded_item.split('\n');
                                for (const line of lines) {
                                    if (!line.startsWith('data: ')) continue;
                                    const d = line.slice(6).trim();
                                    if (d === '[DONE]' || !d) continue;
                                    try {
                                        const sseData = JSON.parse(d);
                                        // 查找 assistant 完整可见文本（parts 数组）
                                        if (sseData.v?.message?.author?.role === 'assistant') {
                                            const parts = sseData.v.message.content?.parts;
                                            if (Array.isArray(parts)) {
                                                const t = parts.filter(p => typeof p === 'string').join('');
                                                if (t && !isPlaceholderDomText(t)) {
                                                    wsCapturedText = t;
                                                    wsFinalTextFound = true;
                                                }
                                            }
                                        }
                                    } catch {}
                                }
                            }
                            // 处理 stream-item 中的 nested encoded_item（delta 增量）
                            const nestedItems = payload.items || [];
                            for (const ni of nestedItems) {
                                if (!ni.encoded_item) continue;
                                if (wsFinalTextFound) break;  // 已有完整文本，跳过
                                const nLines = ni.encoded_item.split('\n');
                                for (const nl of nLines) {
                                    if (!nl.startsWith('data: ')) continue;
                                    const nd = nl.slice(6).trim();
                                    if (nd === '[DONE]' || !nd) continue;
                                    try {
                                        const nsse = JSON.parse(nd);
                                        const patches = Array.isArray(nsse.v) ? nsse.v : [];
                                        for (const patch of patches) {
                                            if (patch.o === 'append' && typeof patch.v === 'string') {
                                                wsCapturedText += patch.v;
                                            } else if (patch.o === 'add' || patch.o === 'replace') {
                                                if (Array.isArray(patch.v)) {
                                                    const t = patch.v.filter(p => typeof p === 'string').join('');
                                                    if (t && !isPlaceholderDomText(t)) {
                                                        wsCapturedText = t;
                                                        wsFinalTextFound = true;
                                                    }
                                                } else if (typeof patch.v === 'string' && patch.v.trim()) {
                                                    wsCapturedText = patch.v;
                                                }
                                            }
                                        }
                                    } catch {}
                                }
                            }
                        }
                    }
                } catch {}
            });
        };
        page.on('websocket', wsHandler);

        const responsePromise = page.waitForResponse(async (response) => {
            const url = response.url();
            if (!url.includes('backend-api/f/conversation') &&
                !url.includes('backend-api/conversation')) return false;
            if (response.request().method() !== 'POST') return false;
            if (response.status() !== 200) return false;

            try {
                const body = await response.text();
                const lines = body.split('\n');

                for (const line of lines) {
                    // 跳过空行和事件行
                    if (!line.startsWith('data: ')) continue;

                    const dataStr = line.slice(6).trim();
                    if (dataStr === '[DONE]') {
                        if (streamHandoffDetected || (targetMessageId && textContent.trim())) {
                            isComplete = true;
                            if (streamHandoffDetected && streamHandoffResolve) {
                                streamHandoffResolve('handoff');
                                streamHandoffResolve = null;
                            }
                        }
                        continue;
                    }

                    try {
                        const data = JSON.parse(dataStr);

                        if (data.type === 'stream_handoff') {
                            streamHandoffDetected = true;
                            logger.info('适配器', '检测到 stream_handoff (thinking 模型)', meta);
                        }

                        if (debug) {
                            pushLimited(debug.sse, {
                                at: new Date().toISOString(),
                                url,
                                summary: summarizeSseData(data)
                            }, 500);
                        }

                        // 检测目标消息。gpt-thinking 的最终文本结构不总是
                        // channel: "final" + content_type: "text"，所以这里按
                        // “assistant 的可见文本”识别，并排除 thinking/commentary。
                        if (isVisibleAssistantMessage(data.v?.message)) {
                            targetMessageId = data.v.message.id;
                            textContent = extractVisibleText(data.v.message.content.parts);
                        }

                        // 以下所有内容累积都必须在 targetMessageId 设置之后才执行
                        // 避免误收 commentary / thinking 频道的内容
                        if (!targetMessageId) continue;

                        // 累积 delta 内容 (append 操作，顶层 path)
                        if (data.o === 'append' && data.p === '/message/content/parts/0' && data.v) {
                            textContent += data.v;
                        }

                        // patch 操作中的 append (数组格式)
                        if (Array.isArray(data.v)) {
                            for (const patch of data.v) {
                                if (patch.p === '/message/content/parts/0' && typeof patch.v === 'string') {
                                    if (patch.o === 'append') {
                                        textContent += patch.v;
                                    } else if (patch.o === 'add' || patch.o === 'replace') {
                                        textContent = patch.v;
                                    }
                                }
                                if (patch.p === '/message/content/parts' && Array.isArray(patch.v)) {
                                    if (patch.o === 'add' || patch.o === 'replace') {
                                        textContent = extractVisibleText(patch.v);
                                    }
                                }
                                // 仅在 targetMessageId 存在时检查完成
                                if (patch.p === '/message/status' && patch.v === 'finished_successfully') {
                                    isComplete = true;
                                }
                            }
                        }

                        // message_stream_complete 表示完成（仅在有内容时）
                        if (data.type === 'message_stream_complete' && targetMessageId && textContent.trim()) {
                            isComplete = true;
                        }
                    } catch {
                        // 忽略解析错误
                    }
                }

                return isComplete;
            } catch {
                return false;
            }
        }, { timeout: waitTimeout });

        // 5. 发送提示词
        logger.debug('适配器', activeSteerMode ? `发送 steer 提示词 (${activeSteerMode})...` : '发送提示词...', meta);
        const startTimeSend = Date.now();
        if (activeSteerMode === 'native') {
            const steerSendButton = await findChatGptSendButton(page);
            if (steerSendButton) {
                await safeClick(page, steerSendButton, { bias: 'button' });
            } else {
                // The control can rerender between typing and submission. Fall back to
                // the keyboard action, which is what the ChatGPT composer itself uses.
                await page.keyboard.press('Enter');
            }
        } else {
            await page.keyboard.press('Enter');
        }
        if (debug) {
            pushLimited(debug.events, {
                at: new Date().toISOString(),
                event: 'prompt-sent',
                url: page.url()
            });
        }

        logger.info('适配器', '等待生成结果...', meta);

        // No-progress watchdog. The completion-aware channels only settle when the
        // stream finishes, so a request whose stream never produced anything would
        // otherwise hold the single browser lane for the full waitTimeout. Sample
        // cheap activity signals (assistant DOM text, WebSocket text, SSE text,
        // stop button) and the authoritative cloud stream_status. A slow-but-live
        // answer keeps producing (or keeps reporting IS_STREAMING) and retains the
        // full waitTimeout budget; a dead or fully stalled stream fails fast.
        const watchdog = startStreamWatchdog({
            firstTokenTimeoutMs,
            noProgressTimeoutMs,
            sampleSignals: async () => {
                const assistantTextLen = await page.evaluate(() => {
                    let length = 0;
                    for (const node of document.querySelectorAll('[data-message-author-role="assistant"]')) {
                        length += (node.textContent || '').length;
                    }
                    return length;
                }).catch(() => null);
                const stopVisible = await page.locator(CHATGPT_STOP_BUTTON_SELECTOR).first()
                    .isVisible().catch(() => false);
                return {
                    assistantTextLen: assistantTextLen === null ? -1 : assistantTextLen,
                    stopVisible,
                    sseTextLen: textContent.length,
                    wsTextLen: wsCapturedText.length
                };
            },
            readCloudStreamStatus: async () => {
                const convId = page.url().match(/\/c\/([0-9a-f-]{36})/i)?.[1] || capturedConversationId;
                if (!convId) return null;
                return await page.evaluate(async (id) => {
                    try {
                        const res = await fetch(`/backend-api/conversation/${id}/stream_status`, {
                            credentials: 'include'
                        });
                        if (!res.ok) return `HTTP_${res.status}`;
                        return (await res.json())?.status || null;
                    } catch { return null; }
                }, convId).catch(() => null);
            },
            onFail: (reason, waitedS) => logger.warn('适配器', `Watchdog: ${reason} after ${waitedS}s without model output activity; failing fast instead of holding the browser lane`, meta)
        });
        const watchdogPromise = watchdog.promise;
        watchdogInterval = watchdog.interval;

        // 6. 并行等待 SSE、页面 DOM 和 stream_handoff 流程
        let sseError = null;
        const sseTextPromise = responsePromise
            .then(() => textContent.trim() ? textContent.trim() : new Promise(() => { }))
            .catch((e) => {
                sseError = e;
                return new Promise(() => { });
            });

        // DOM renders assistant text incrementally, so it is not an authoritative
        // completion signal. Wait for the ChatGPT response stream / handoff path to
        // finish first; only use DOM after those completion-aware paths time out.
        // This prevents returning a visibly-rendered prefix as the Codex model result.

        // stream_handoff 专用处理：并行等待 WebSocket / convId，convId 一到立即走 API
        const handoffTextPromise = streamHandoffPromise.then(async () => {
            const t0 = Date.now();
            logger.info('适配器', 'stream_handoff 流程启动，并行等待 WebSocket 和会话 ID...', meta);

            // 并行竞争：谁先到用谁
            // 通道1: WebSocket 文本（200ms 轮询，最多 3s）
            const wsPromise = new Promise(async (resolve) => {
                const deadline = Date.now() + 3000;
                while (Date.now() < deadline) {
                    if (wsCapturedText) return resolve({ type: 'ws', text: wsCapturedText });
                    await sleep(200, 200);
                }
                resolve({ type: 'ws', text: wsCapturedText || '' });
            });

            // 通道2: 会话 ID（200ms 轮询，最多 10s）
            const convIdPromise = new Promise((resolve) => {
                const start = Date.now();
                const check = () => {
                    if (capturedConversationId) return resolve(capturedConversationId);
                    if (Date.now() - start > 10000) return resolve(null);
                    setTimeout(check, 200);
                };
                check();
            });

            // 同时启动两个通道，谁先有结果就行动
            const wsRace = wsPromise.then(async (r) => {
                if (r.text) {
                    logger.info('适配器', `stream_handoff: WebSocket 解析到文本 (${r.text.length} 字符, ${Date.now() - t0}ms)`, meta);
                    return r.text;
                }
                return null;  // WS 超时无内容，等 convId 通道
            });

            const apiRace = convIdPromise.then(async (convId) => {
                if (!convId) return null;

                logger.info('适配器', `stream_handoff: convId 到达，轮询 API (${convId}, ${Date.now() - t0}ms)`, meta);
                try {
                    const apiUrl = `https://chatgpt.com/backend-api/conversation/${convId}`;
                    const hdrs = { 'Accept': 'application/json' };

                    // 轮询 API：每 2s 查一次，最多 25s（ChatGPT 思考模型可能需要 10-20s）
                    const apiDeadline = Date.now() + 25000;
                    let attempt = 0;
                    while (Date.now() < apiDeadline) {
                        attempt++;
                        const apiResponse = await page.evaluate(async ({ url, hdrs }) => {
                            const res = await fetch(url, { headers: hdrs });
                            if (!res.ok) return { error: `HTTP ${res.status}` };
                            return await res.json();
                        }, { url: apiUrl, hdrs });

                        if (apiResponse && !apiResponse.error && apiResponse.mapping) {
                            // Anchor the reply to the exact user prompt we just sent. Without this,
                            // an existing conversation can briefly return its previous assistant
                            // message while the new turn is still being written to the cloud graph.
                            let sentUserTs = 0;
                            for (const [, node] of Object.entries(apiResponse.mapping)) {
                                const msg = node?.message;
                                if (msg?.author?.role !== 'user') continue;
                                const userText = extractVisibleText(msg?.content?.parts);
                                if (userText === prompt && (msg?.create_time || 0) > sentUserTs) {
                                    sentUserTs = msg.create_time || 0;
                                }
                            }

                            let latestText = '';
                            let latestTs = 0;
                            if (sentUserTs > 0) {
                                for (const [, node] of Object.entries(apiResponse.mapping)) {
                                    const msg = node?.message;
                                    const ts = msg?.create_time || 0;
                                    if (isFinishedAssistantMessage(msg) && ts > sentUserTs && ts > latestTs) {
                                        const text = extractVisibleText(msg.content.parts);
                                        if (text && !isPlaceholderDomText(text)) {
                                            latestText = text;
                                            latestTs = ts;
                                        }
                                    }
                                }
                            }
                            if (latestText) {
                                logger.info('适配器', `stream_handoff: API 第${attempt}次获取成功 (${latestText.length} 字符, ${Date.now() - t0}ms)`, meta);
                                return latestText;
                            }
                        }
                        logger.info('适配器', `stream_handoff: API 第${attempt}次无文本，2s 后重试 (${Date.now() - t0}ms)`, meta);
                        await sleep(2000, 2000);
                    }
                    logger.info('适配器', `stream_handoff: API 轮询超时，尝试导航 (${Date.now() - t0}ms)`, meta);
                } catch (apiErr) {
                    logger.warn('适配器', `stream_handoff: API 失败: ${apiErr.message}`, meta);
                }

                // 兜底：导航到会话页面读取 DOM
                logger.info('适配器', `stream_handoff: 导航到 /c/${convId} (${Date.now() - t0}ms)`, meta);
                try {
                    await gotoWithCheck(page, `https://chatgpt.com/c/${convId}`);
                } catch (navErr) {
                    logger.warn('适配器', `stream_handoff: 导航失败: ${navErr.message}`, meta);
                    return '';
                }
                const text = await waitForAssistantTextFromDom(page, 0, 30000, meta);
                if (text) {
                    logger.info('适配器', `stream_handoff: DOM 获取到文本 (${text.length} 字符, ${Date.now() - t0}ms)`, meta);
                } else {
                    logger.warn('适配器', `stream_handoff: DOM 未找到文本 (${Date.now() - t0}ms)`, meta);
                }
                return text || '';
            });

            // WS 通道先到先返回，否则等 API 通道
            const wsResult = await wsRace;
            if (wsResult) return wsResult;

            const apiResult = await apiRace;
            return apiResult || '';
        }).catch(e => {
            logger.warn('适配器', `stream_handoff 流程异常: ${e.message}`, meta);
            return '';
        });

        const authoritativeTimeoutPromise = new Promise(resolve => {
            setTimeout(() => resolve(''), waitTimeout + 1000);
        });
        try {
            textContent = await Promise.race([
                sseTextPromise,
                handoffTextPromise,
                authoritativeTimeoutPromise,
                watchdogPromise
            ]);
        } catch (progressErr) {
            clearInterval(watchdogInterval);
            // Dead or fully stalled stream: free the browser lane immediately with a
            // retryable error so queued requests are not starved behind it.
            const waitedS = Math.round((Date.now() - startTimeSend) / 1000);
            return {
                error: `${progressErr.message} (waited ${waitedS}s). The request was failed fast so it does not hold the browser lane; retrying is safe.`,
                code: 'STREAM_NO_PROGRESS',
                retryable: true
            };
        } finally {
            clearInterval(watchdogInterval);
        }

        if (!textContent || textContent.trim() === '') {
            logger.warn('适配器', '完成感知通道未返回文本，尝试从页面 DOM 读取最后一条回复', meta);
            await page.waitForTimeout(1200);
            textContent = await extractLatestAssistantTextFromDom(page, assistantCountBefore);
        }

        // Treat the finished message stored in the authenticated ChatGPT cloud
        // conversation as authoritative. The DOM can expose a stable-looking prefix
        // before the turn is actually complete; the cloud graph carries completion
        // state and is also the transcript Mike can inspect manually.
        const pageConversationMatch = page.url().match(/\/c\/([0-9a-f-]+)/i);
        const authoritativeConversationId = pageConversationMatch?.[1] || capturedConversationId;
        if (authoritativeConversationId) {
            logger.info('适配器', `通过 API 验证已完成的最终回复: ${authoritativeConversationId}`, meta);
            try {
                const apiUrl = `https://chatgpt.com/backend-api/conversation/${authoritativeConversationId}`;
                const headers = { 'Accept': 'application/json' };

                const verifyDeadline = Date.now() + 15000;
                let verifiedFinalText = '';
                let lastApiError = null;
                while (Date.now() < verifyDeadline && !verifiedFinalText) {
                    const apiResponse = await page.evaluate(async ({ url, hdrs }) => {
                        const res = await fetch(url, { headers: hdrs });
                        if (!res.ok) return { error: `HTTP ${res.status}` };
                        return await res.json();
                    }, { url: apiUrl, hdrs: headers });

                    if (apiResponse && !apiResponse.error) {
                        const messages = apiResponse?.mapping || {};
                        let sentUserTs = 0;
                        for (const [, node] of Object.entries(messages)) {
                            const msg = node?.message;
                            if (msg?.author?.role !== 'user') continue;
                            const userText = extractVisibleText(msg?.content?.parts);
                            if (userText === prompt && (msg?.create_time || 0) > sentUserTs) {
                                sentUserTs = msg.create_time || 0;
                            }
                        }

                        let latestTimestamp = 0;
                        if (sentUserTs > 0) {
                            for (const [, node] of Object.entries(messages)) {
                                const msg = node?.message;
                                const ts = msg?.create_time || 0;
                                if (isFinishedAssistantMessage(msg) && ts > sentUserTs && ts > latestTimestamp) {
                                    const text = extractVisibleText(msg.content.parts);
                                    if (text && !isPlaceholderDomText(text)) {
                                        verifiedFinalText = text;
                                        latestTimestamp = ts;
                                    }
                                }
                            }
                        }
                        lastApiError = null;
                    } else {
                        lastApiError = apiResponse?.error || 'unknown';
                    }

                    if (!verifiedFinalText) await sleep(500, 650);
                }

                if (verifiedFinalText) {
                    textContent = verifiedFinalText;
                    logger.info('适配器', `已验证最终回复: ${textContent.length} 字符`, meta);
                } else if (lastApiError) {
                    logger.info('适配器', `最终回复验证 API 失败: ${lastApiError}`, meta);
                } else {
                    logger.info('适配器', '最终回复验证超时；保留完成感知通道的结果', meta);
                }
            } catch (apiErr) {
                logger.warn('适配器', `API 获取对话失败: ${apiErr.message}`, meta);
            }
        }

        if (!textContent || textContent.trim() === '') {
            if (sseError) {
                const pageError = normalizePageError(sseError, meta);
                if (pageError) return pageError;
            }
            logger.warn('适配器', '回复内容为空', meta);
            return { error: 'ChatGPT returned an empty response' };
        }

        logger.info('适配器', `已获取文本内容 (${textContent.length} 字符)`, meta);

        // 捕获当前会话 URL
        const convUrl = await getConversationUrl(page);
        if (convUrl) {
            logger.info('适配器', `会话 URL: ${convUrl}`, meta);
        }

        const projectRouting = await routeChatGptConversationToProject(page, convUrl, config, {
            agent: meta?.agent,
            project: meta?.project,
            source: 'completion'
        });

        logger.info('适配器', '文本生成完成，任务完成', meta);
        if (debug) {
            debug.result = {
                textLength: textContent.trim().length,
                textPreview: textContent.trim().slice(0, 1000),
                conversationUrl: convUrl
            };
            await writeDebugDump(debug, page, meta, 'success', assistantCountBefore);
        }
        return { text: textContent.trim(), conversationUrl: convUrl, projectRouting };

    } catch (err) {
        // 顶层错误处理
        const pageError = normalizePageError(err, meta);
        if (debug) {
            debug.error = {
                message: err.message,
                normalized: pageError || null
            };
            await writeDebugDump(debug, page, meta, 'error', assistantCountBefore);
        }
        if (pageError) return pageError;

        logger.error('适配器', '生成任务失败', { ...meta, error: err.message });
        return { error: `Generation failed: ${err.message}` };
    } finally {
        if (watchdogInterval) {
            clearInterval(watchdogInterval);
        }
        if (debugResponseHandler) {
            page.off('response', debugResponseHandler);
        }
        if (rawNetworkHandler) {
            page.off('response', rawNetworkHandler);
        }
        if (wsHandler) {
            page.off('websocket', wsHandler);
        }
        // 后台导航回首页，为下一个新请求预热（不阻塞当前响应）
        // 仅在新对话后预热，会话复用时保留当前页面以便继续
        const currentUrl = page.url();
        if (!conversationUrl && (currentUrl.includes('/c/') || currentUrl.includes('/codex/'))) {
            page.goto('https://chatgpt.com/', { waitUntil: 'commit', timeout: 30000 })
                .then(() => logger.info('适配器', '后台预热：已导航回首页', meta))
                .catch(() => {});  // 忽略错误，不影响响应
        }
    }
}

// ==========================================
// Cloud conversation/project management (backend-api)
// ==========================================

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
            }, { method: normalizedMethod, path, query, body, retries });
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
 * on screen. Resolves the conversation's real URL first (project chats never
 * reliably answer the public /c/<id> URL), skips navigation when the page
 * already shows the target conversation ID, and hard-verifies the page URL
 * after the composer is ready. NEVER falls back to an unverified composer:
 * when the page cannot be positively attached to the target conversation this
 * fails loudly so the caller sends nothing at all. Typing a steering message
 * into whatever composer is open silently spawns a new chat (issue #18).
 */
export async function ensurePageOnExactConversation(page, conversationReference, { timeout = 60000, resolve = null } = {}) {
    const reference = parseChatGptConversationReference(conversationReference);
    if (!reference) {
        return { ok: false, error: 'conversation_reference_invalid', actualUrl: page?.url?.() || null };
    }

    // Resolve the real URL; on failure fall back to the canonical public URL.
    let targetUrl = reference.url;
    let resolution = null;
    const resolver = resolve || resolveChatGptConversationUrl;
    try {
        resolution = await resolver(page, reference.url);
    } catch (error) {
        resolution = { ok: false, error: error?.message || String(error) };
    }
    if (resolution?.ok && typeof resolution.url === 'string') {
        targetUrl = resolution.url;
    }

    const alreadyThere = chatGptConversationIdFromPageUrl(page.url()) === reference.id;
    if (!alreadyThere) {
        await gotoWithCheck(page, targetUrl, { timeout });
    }
    await dismissStaleChatGptAuthDialog(page);
    await waitForChatInput(page, { click: false, timeout });

    const pageConversationId = chatGptConversationIdFromPageUrl(page.url());
    if (pageConversationId !== reference.id) {
        logger.warn('适配器', `拒绝在未验证的 composer 中输入：目标会话 ${reference.id}，浏览器实际位于 ${page.url()}`);
        return {
            ok: false,
            error: 'conversation_navigation_mismatch',
            conversationId: reference.id,
            resolvedUrl: targetUrl,
            actualUrl: page.url(),
            resolutionError: resolution?.ok ? null : (resolution?.error || 'unavailable'),
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

const CHATGPT_PROJECT_ID_RE = /^g-p-[0-9a-z]+$/i;
const CHATGPT_PROJECT_URL_RE = /^https:\/\/chatgpt\.com\/g\/(g-p-[0-9a-z]+)/i;
const CHATGPT_CONVERSATION_ID_RE = /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;
const projectRoutingWarnings = new Set();

function normalizeProjectReference(value) {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (CHATGPT_PROJECT_ID_RE.test(raw)) return raw.toLowerCase();
    const match = raw.match(CHATGPT_PROJECT_URL_RE);
    return match ? match[1].toLowerCase() : null;
}

function normalizeAgentHint(value) {
    return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function configuredAgentProject(byAgent, agent) {
    if (!byAgent || typeof byAgent !== 'object' || !agent) return undefined;
    const entry = Object.entries(byAgent).find(([key]) => String(key).trim().toLowerCase() === agent);
    return entry ? entry[1] : undefined;
}

/**
 * Resolve the configured target without contacting ChatGPT. The caller still
 * validates the selected project against the live sidebar before moving.
 */
export function resolveChatGptProjectTarget(config, { agent = null, project = undefined } = {}) {
    const routing = config?.projects && typeof config.projects === 'object' ? config.projects : {};
    const byAgent = routing.byAgent || routing.by_agent || {};
    const normalizedAgent = normalizeAgentHint(agent);
    const defaultProjectId = normalizeProjectReference(routing.default || routing.defaultProject);
    const hasProjectHint = typeof project === 'string' && project.trim() !== '';

    if (hasProjectHint) {
        const rawProject = project.trim();
        if (rawProject.toLowerCase() === 'none') {
            return {
                agent: normalizedAgent,
                projectId: null,
                defaultProjectId,
                source: 'explicit-none',
                explicitNone: true,
                invalidProjectHint: null
            };
        }
        const explicitProjectId = normalizeProjectReference(rawProject);
        if (explicitProjectId) {
            return {
                agent: normalizedAgent,
                projectId: explicitProjectId,
                defaultProjectId,
                source: 'explicit',
                explicitNone: false,
                invalidProjectHint: null
            };
        }
        return {
            agent: normalizedAgent,
            projectId: defaultProjectId,
            defaultProjectId,
            source: defaultProjectId ? 'default' : 'none',
            explicitNone: false,
            invalidProjectHint: rawProject
        };
    }

    const mappedValue = configuredAgentProject(byAgent, normalizedAgent);
    const mappedProjectId = normalizeProjectReference(mappedValue);
    if (mappedProjectId) {
        return {
            agent: normalizedAgent,
            projectId: mappedProjectId,
            defaultProjectId,
            source: 'agent',
            explicitNone: false,
            invalidProjectHint: null,
            invalidAgentMapping: null
        };
    }

    return {
        agent: normalizedAgent,
        projectId: defaultProjectId,
        defaultProjectId,
        source: defaultProjectId ? 'default' : 'none',
        explicitNone: false,
        invalidProjectHint: null,
        invalidAgentMapping: mappedValue === undefined ? null : String(mappedValue)
    };
}

function warnProjectRoutingOnce(key, message, meta = {}) {
    if (projectRoutingWarnings.has(key)) return;
    projectRoutingWarnings.add(key);
    logger.warn('Project routing', message, meta);
}

/**
 * Apply the configured project after a conversation has been created or
 * dispatched. This helper deliberately swallows routing failures: project
 * organization is auxiliary and must never turn a usable ChatGPT response
 * into a failed bridge request.
 */
export async function routeChatGptConversationToProject(page, conversationUrl, config, {
    agent = null,
    project = undefined,
    source = 'completion'
} = {}) {
    const conversationMatch = typeof conversationUrl === 'string'
        ? conversationUrl.match(CHATGPT_CONVERSATION_ID_RE)
        : null;
    if (!conversationMatch) {
        return { success: true, moved: false, skipped: true, reason: 'conversation_url_unavailable' };
    }

    const resolved = resolveChatGptProjectTarget(config, { agent, project });
    const meta = { conversationId: conversationMatch[1], agent: resolved.agent, source };
    if (resolved.invalidProjectHint) {
        warnProjectRoutingOnce(
            `invalid-project-hint:${resolved.invalidProjectHint}`,
            `Ignoring invalid ChatGPT project hint "${resolved.invalidProjectHint}"; using the configured fallback`,
            meta
        );
    }
    if (resolved.invalidAgentMapping) {
        warnProjectRoutingOnce(
            `invalid-agent-mapping:${resolved.agent || 'unknown'}:${resolved.invalidAgentMapping}`,
            `ChatGPT project mapping for agent ${resolved.agent || 'unknown'} is invalid; using the configured default`,
            meta
        );
    }
    if (!resolved.explicitNone && !resolved.projectId) {
        return { success: true, moved: false, skipped: true, reason: 'no_project_configured', ...meta };
    }

    try {
        let availableProjects = null;
        if (!resolved.explicitNone) {
            const catalog = await listChatGptProjects(page);
            if (catalog.success) {
                availableProjects = new Set(catalog.projects.map(item => item.id.toLowerCase()));
            } else {
                logger.warn('Project routing', `Could not validate ChatGPT project mapping: ${catalog.error}`, meta);
            }
        }

        let targetProjectId = resolved.projectId;
        let fallbackUsed = false;
        if (targetProjectId && availableProjects && !availableProjects.has(targetProjectId)) {
            warnProjectRoutingOnce(
                `missing-project:${targetProjectId}`,
                `Configured ChatGPT project ${targetProjectId} does not exist; falling back to the default project`,
                meta
            );
            if (resolved.defaultProjectId && resolved.defaultProjectId !== targetProjectId &&
                availableProjects.has(resolved.defaultProjectId)) {
                targetProjectId = resolved.defaultProjectId;
                fallbackUsed = true;
            } else {
                if (resolved.defaultProjectId && resolved.defaultProjectId !== targetProjectId) {
                    warnProjectRoutingOnce(
                        `missing-project:${resolved.defaultProjectId}`,
                        `Configured default ChatGPT project ${resolved.defaultProjectId} does not exist; leaving the conversation unmapped`,
                        meta
                    );
                }
                return {
                    success: false,
                    moved: false,
                    skipped: true,
                    reason: 'configured_project_missing',
                    projectId: null,
                    requestedProjectId: resolved.projectId,
                    fallbackUsed,
                    ...meta
                };
            }
        }

        const move = async (projectId) => moveChatGptConversationToProject(page, conversationMatch[1], projectId);
        let result = await move(targetProjectId);
        if (result.success) {
            logger.info('Project routing', `Moved ChatGPT conversation to project ${targetProjectId || 'none'}`, meta);
            return {
                success: true,
                moved: true,
                skipped: false,
                projectId: targetProjectId,
                requestedProjectId: resolved.projectId,
                fallbackUsed,
                ...meta
            };
        }

        if (targetProjectId && resolved.defaultProjectId && targetProjectId !== resolved.defaultProjectId) {
            if (!availableProjects || availableProjects.has(resolved.defaultProjectId)) {
                logger.warn('Project routing', `Moving ChatGPT conversation to project ${targetProjectId} failed; trying the default project`, {
                    ...meta,
                    error: result.error
                });
                result = await move(resolved.defaultProjectId);
                if (result.success) {
                    logger.info('Project routing', `Moved ChatGPT conversation to default project ${resolved.defaultProjectId}`, meta);
                    return {
                        success: true,
                        moved: true,
                        skipped: false,
                        projectId: resolved.defaultProjectId,
                        requestedProjectId: resolved.projectId,
                        fallbackUsed: true,
                        ...meta
                    };
                }
            }
        }

        logger.warn('Project routing', `Could not move ChatGPT conversation to project ${targetProjectId || 'none'}; continuing without project routing`, {
            ...meta,
            error: result.error
        });
        return {
            success: false,
            moved: false,
            skipped: false,
            projectId: null,
            requestedProjectId: resolved.projectId,
            fallbackUsed,
            error: result.error,
            ...meta
        };
    } catch (error) {
        logger.warn('Project routing', `ChatGPT project routing failed; continuing without project routing: ${error.message}`, meta);
        return {
            success: false,
            moved: false,
            skipped: false,
            projectId: null,
            requestedProjectId: resolved.projectId,
            error: error.message,
            ...meta
        };
    }
}

/**
 * List conversations inside one project. Verified live:
 * GET /backend-api/gizmos/<project-id>/conversations?cursor=0&limit=N
 */
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

    // 核心文本生成方法
    generate
};
