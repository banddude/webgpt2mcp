/**
 * @fileoverview zAI 文本生成适配器
 */

import {
    sleep,
    humanType,
    safeClick,
    pasteImages
} from '../engine/utils.js';
import {
    normalizePageError,
    normalizeHttpError,
    waitApiResponse,
    waitForPageAuth,
    lockPageAuth,
    unlockPageAuth,
    isPageAuthLocked,
    waitForInput,
    gotoWithCheck
} from '../utils/index.js';
import { logger } from '../../utils/logger.js';

// zai.is 输入框选择器
const INPUT_SELECTOR = '.tiptap.ProseMirror';

// 入口 URL
const TARGET_URL = 'https://zai.is/';

/**
 * 处理 Discord OAuth2 登录流程
 * @param {import('playwright-core').Page} page
 * @returns {Promise<boolean>} 是否处理了登录
 */
async function handleDiscordAuth(page) {
    // 防止重复处理
    if (isPageAuthLocked(page)) return false;

    const currentUrl = page.url();

    // 1. 检查是否在 zai.is/auth 页面
    if (currentUrl.includes('zai.is/auth')) {
        lockPageAuth(page);
        logger.info('适配器', '[登录器(zai)] 检测到登录页面，正在处理 Discord 登录...');

        try {
            // 等待页面加载完成，点击唯一的 button 标签
            await page.waitForSelector('button', { timeout: 30000 });
            await safeClick(page, 'button', { bias: 'button' });
            logger.info('适配器', '[登录器(zai)] 已点击登录按钮，等待跳转到 Discord...');

            // 2. 等待跳转到 Discord OAuth2 授权页面
            await page.waitForURL(url => url.href.includes('discord.com/oauth2/authorize'), { timeout: 60000 });
            logger.info('适配器', '[登录器(zai)] 已到达 Discord 授权页面');

            // 3. 使用鼠标滚轮滚动 main 元素，直到授权按钮可用
            // 授权按钮选择器: data-align="stretch" 的 div 中的最后一个按钮 (授权按钮在右边)
            const authorizeBtnSelector = 'div[data-align="stretch"] button:last-child';

            for (let i = 0; i < 15; i++) {
                const authorizeBtn = await page.$(authorizeBtnSelector);
                if (authorizeBtn) {
                    const isDisabled = await authorizeBtn.evaluate(el => el.disabled).catch(() => true);
                    if (!isDisabled) {
                        logger.info('适配器', '[登录器(zai)] 授权按钮已可用，正在点击...');
                        await sleep(300, 500);
                        await safeClick(page, authorizeBtn, { bias: 'button' });
                        break;
                    }
                }
                // 使用鼠标滚轮在 main 元素中滚动
                const mainElement = await page.$('main');
                if (mainElement) {
                    const box = await mainElement.boundingBox();
                    if (box) {
                        // 将鼠标移动到 main 元素中心并滚动
                        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                        await page.mouse.wheel(0, 200);
                    }
                }
            }

            // 4. 等待跳转回 zai.is (不包含 auth 和 discord)
            logger.info('适配器', '[登录器(zai)] 等待跳转回目标页面...');
            await page.waitForURL(url => {
                const href = url.href;
                return href.includes('zai.is') &&
                    !href.includes('/auth') &&
                    !href.includes('discord.com');
            }, { timeout: 60000 });

            logger.info('适配器', '[登录器(zai)] Discord 登录完成');
            await sleep(500, 1000);
            unlockPageAuth(page);
            return true;
        } catch (err) {
            logger.warn('适配器', `[登录器(zai)] Discord 登录处理失败: ${err.message}`);
            unlockPageAuth(page);
        }
    }


    return false;
}

/**
 * 从 content 中移除开头的 <details> 思考块
 * @param {string} content - 原始内容
 * @returns {string} 处理后的内容
 */
function extractTextContent(content) {
    if (!content) return '';

    // 匹配开头的 <details type="reasoning" ...>...</details> 块
    // 使用非贪婪匹配和 dotAll 模式 (s flag)
    const detailsPattern = /^<details\s+type="reasoning"[^>]*>[\s\S]*?<\/details>\s*/;

    // 移除开头的 details 块，返回剩余内容
    const result = content.replace(detailsPattern, '').trim();

    return result;
}


/**
 * 生成文本
 * @param {object} context - 浏览器上下文 { page, client, config }
 * @param {string} prompt - 提示词
 * @param {string[]} imgPaths - 参考图片路径数组
 * @param {string} modelId - 模型 ID
 * @param {object} meta - 日志元数据
 * @returns {Promise<{text?: string, error?: string}>} 生成结果
 */
async function generate(context, prompt, imgPaths, modelId, meta = {}) {
    const { page, config } = context;
    const waitTimeout = config?.backend?.pool?.waitTimeout ?? 120000;

    try {
        // 开启新对话 - 先等待可能正在进行的登录处理完成
        await waitForPageAuth(page);

        logger.info('适配器', '开启新会话', meta);
        await gotoWithCheck(page, TARGET_URL);

        // 如果触发了登录跳转，等待全局处理器完成
        await waitForPageAuth(page);

        // 1. 等待输入框加载
        logger.debug('适配器', '正在寻找输入框...', meta);
        await waitForInput(page, INPUT_SELECTOR, { click: false });

        // 2. 上传图片 (如果有多张图片，会一张一张上传，每次都是 v1/files POST 请求)
        if (imgPaths && imgPaths.length > 0) {
            const expectedUploads = imgPaths.length;
            let uploadedCount = 0;

            logger.info('适配器', `开始上传 ${expectedUploads} 张图片`, meta);
            await pasteImages(page, INPUT_SELECTOR, imgPaths, {
                uploadValidator: (response) => {
                    const url = response.url();
                    if (response.status() === 200 && url.includes('v1/files')) {
                        uploadedCount++;
                        logger.info('适配器', `图片上传进度: ${uploadedCount}/${expectedUploads}`, meta);
                        if (uploadedCount >= expectedUploads) {
                            return true;
                        }
                    }
                    return false;
                }
            }, meta);

            logger.info('适配器', '图片上传完成', meta);
        }

        // 3. 输入提示词
        logger.info('适配器', '输入提示词...', meta);
        await safeClick(page, INPUT_SELECTOR, { bias: 'input' });
        await humanType(page, INPUT_SELECTOR, prompt);

        // 4. 通过 UI 交互选择模型
        const modelConfig = manifest.models.find(m => m.id === modelId);
        const targetModel = modelConfig?.codeName || modelId;

        logger.debug('适配器', `正在选择模型: ${targetModel}`, meta);

        // 点击 "Select a models" 按钮
        const selectModelBtn = page.getByRole('button', { name: 'Select a model' });
        await selectModelBtn.waitFor({ timeout: 5000 });
        await safeClick(page, selectModelBtn, { bias: 'button' });
        await sleep(300, 500);

        // 在 "Search In Models" 文本框中输入模型名称
        const searchInput = page.getByRole('textbox', { name: 'Search In Models' });
        await searchInput.waitFor({ timeout: 5000 });
        await searchInput.fill(targetModel);
        await sleep(300, 500);

        // 按回车确认选择
        await searchInput.press('Enter');

        logger.info('适配器', `已选择模型: ${targetModel}`, meta);

        // 5. 发送提示词
        logger.debug('适配器', '发送提示词...', meta);
        await safeClick(page, 'button[type="submit"]', { bias: 'button' });

        logger.info('适配器', '等待生成结果中...', meta);

        // 6. 等待 v1/chats/new 响应 (状态码 200 且响应体中有 id)
        let chatsNewResponse;
        try {
            chatsNewResponse = await waitApiResponse(page, {
                urlMatch: 'v1/chats/new',
                method: 'POST',
                timeout: 60000,
                meta
            });
        } catch (e) {
            const pageError = normalizePageError(e, meta);
            if (pageError) return pageError;
            throw e;
        }

        // 检查 chats/new 响应
        const httpError = normalizeHttpError(chatsNewResponse);
        if (httpError) {
            logger.error('适配器', `创建对话失败: ${httpError.error}`, meta);
            return { error: `创建对话失败: ${httpError.error}` };
        }

        try {
            const chatsNewBody = await chatsNewResponse.json();
            if (!chatsNewBody.id) {
                logger.error('适配器', '创建对话响应中没有无 id', meta);
                return { error: '创建对话响应中没有 id' };
            }
            logger.debug('适配器', `对话创建成功, id: ${chatsNewBody.id}`, meta);
        } catch (e) {
            logger.error('适配器', '解析 chats/new 响应失败', { ...meta, error: e.message });
            return { error: '解析对话响应失败' };
        }

        // 7. 等待 chat/completions 响应 (状态码 200 且 status: true)
        let completionsResponse;
        try {
            completionsResponse = await waitApiResponse(page, {
                urlMatch: 'chat/completions',
                method: 'POST',
                timeout: waitTimeout,
                errorText: ['Model is unable to process your request', 'Rate limit reached'],
                meta
            });
        } catch (e) {
            const pageError = normalizePageError(e, meta);
            if (pageError) return pageError;
            throw e;
        }

        const completionsHttpError = normalizeHttpError(completionsResponse);
        if (completionsHttpError) {
            logger.error('适配器', `生成请求失败: ${completionsHttpError.error}`, meta);
            return { error: `生成请求失败: ${completionsHttpError.error}` };
        }

        try {
            const completionsBody = await completionsResponse.json();
            if (!completionsBody.status) {
                logger.error('适配器', '生成响应 status 不为 true', meta);
                return { error: '生成失败，响应状态异常' };
            }
            logger.debug('适配器', '生成请求成功', meta);
        } catch (e) {
            logger.error('适配器', '解析 completions 响应失败', { ...meta, error: e.message });
            return { error: '解析生成响应失败' };
        }

        // 8. 等待 chat/completed 响应，从中提取文本内容
        logger.debug('适配器', '正在等待完成响应...', meta);

        let completedResponse;
        try {
            completedResponse = await waitApiResponse(page, {
                urlMatch: 'chat/completed',
                method: 'POST',
                timeout: waitTimeout,
                errorText: ['Model is unable to process your request', 'Rate limit reached'],
                meta
            });
        } catch (e) {
            const pageError = normalizePageError(e, meta);
            if (pageError) {
                if (e.name === 'TimeoutError') {
                    return { error: '等待完成响应超时 (120秒)' };
                }
                return pageError;
            }
            throw e;
        }

        // 解析 chat/completed 响应
        let completedBody;
        try {
            completedBody = await completedResponse.json();
        } catch (e) {
            logger.error('适配器', '解析 chat/completed 响应失败', { ...meta, error: e.message });
            return { error: '解析完成响应失败' };
        }

        // 在 messages 数组中查找匹配的消息 (id 与响应体的 id 相同)
        const targetMessage = (completedBody.messages || []).find(msg => msg.id === completedBody.id);
        if (!targetMessage) {
            logger.error('适配器', `未找到匹配的消息`, meta);
            return { error: '未找到匹配的消息' };
        }

        // 检查 content
        const content = targetMessage.content;
        if (!content || content.trim() === '') {
            logger.warn('适配器', '回复内容为空可能触发违规/限流', meta);
            return { error: '回复内容为空可能触发违规/限流' };
        }

        // 提取文本内容 (移除开头的 <details> 思考块)
        const textContent = extractTextContent(content);
        if (!textContent) {
            logger.warn('适配器', '提取文本内容为空', meta);
            return { error: '提取文本内容为空' };
        }

        logger.info('适配器', `已提取文本内容 (${textContent.length} 字符)`, meta);
        logger.info('适配器', '文本生成完成，任务完成', meta);
        return { text: textContent };

    } catch (err) {
        // 顶层错误处理
        const pageError = normalizePageError(err, meta);
        if (pageError) return pageError;

        logger.error('适配器', '生成任务失败', { ...meta, error: err.message });
        return { error: `生成任务失败: ${err.message}` };
    } finally { }
}

/**
 * 适配器 manifest
 */
export const manifest = {
    id: 'zai_is_text',
    displayName: 'zAI (文本生成)',
    description: '使用 zAI 平台生成文本，支持多种大语言模型。需要 Discord 账户登录授权。',

    // 入口 URL
    getTargetUrl(config, workerConfig) {
        return TARGET_URL;
    },

    // 模型列表 - 文本生成模型
    models: [
        { id: 'glm-4.6', codeName: 'GLM 4.6', imagePolicy: 'optional' },
        { id: 'gemini-3-pro-preview', codeName: 'Gemini 3 Pro Preview', imagePolicy: 'optional' },
        { id: 'gemini-2.5-pro', codeName: 'Gemini 2.5 Pro', imagePolicy: 'optional' },
        { id: 'gemini-3-flash-preview', codeName: 'Gemini 3 Flash Preview', imagePolicy: 'optional' },
        { id: 'claude-sonnet-4.5', codeName: 'Claude Sonnet 4.5', imagePolicy: 'optional' },
        { id: 'claude-sonnet-4', codeName: 'Claude Sonnet 4', imagePolicy: 'optional' },
        { id: 'claude-haiku-4.5', codeName: 'Claude Haiku 4.5', imagePolicy: 'optional' },
        { id: 'gpt-5.1', codeName: 'GPT-5.1', imagePolicy: 'optional' },
        { id: 'gpt-5', codeName: 'GPT-5', imagePolicy: 'optional' },
        { id: 'gpt-4.1', codeName: 'GPT-4.1', imagePolicy: 'optional' },
        { id: 'gpt-5.2', codeName: 'GPT-5.2 Chat', imagePolicy: 'optional' },
        { id: 'o3-high', codeName: 'o3-high', imagePolicy: 'optional' },
        { id: 'o3-mini', codeName: 'o3-mini', imagePolicy: 'optional' },
        { id: 'o4-mini', codeName: 'o4-mini', imagePolicy: 'optional' },
        { id: 'grok-4.1-fast', codeName: 'Grok 4.1 Fast', imagePolicy: 'optional' },
        { id: 'grok-4', codeName: 'Grok 4', imagePolicy: 'optional' },
        { id: 'kimi-k2-thinking', codeName: 'Kimi K2 Thinking', imagePolicy: 'optional' },
    ],

    // 导航处理器
    navigationHandlers: [handleDiscordAuth],

    // 核心文本生成方法
    generate
};
