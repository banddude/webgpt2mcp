/**
 * @fileoverview NanoBananaFree 图片生成适配器
 */

import {
    sleep,
    humanType,
    safeClick,
    pasteImages
} from '../engine/utils.js';
import {
    waitApiResponse,
    normalizePageError,
    normalizeHttpError,
    waitForInput,
    gotoWithCheck
} from '../utils/index.js';
import { logger } from '../../utils/logger.js';

// --- 配置常量 ---
const TARGET_URL = 'https://nanobananafree.ai/';


/**
 * 执行生图任务
 * @param {object} context - 浏览器上下文 { page, client }
 * @param {string} prompt - 提示词
 * @param {string[]} imgPaths - 图片路径数组 (仅取第一张)
 * @param {string} [modelId] - 指定的模型 ID (可选，目前未使用)
 * @param {object} [meta={}] - 日志元数据
 * @returns {Promise<{image?: string, text?: string, error?: string}>} 生成结果
 */
async function generate(context, prompt, imgPaths, modelId, meta = {}) {
    const { page, config } = context;
    const waitTimeout = config?.backend?.pool?.waitTimeout ?? 120000;
    const textareaSelector = 'textarea';

    try {
        logger.info('适配器', '开启新会话', meta);
        await gotoWithCheck(page, TARGET_URL);

        // 1. 等待输入框加载
        await waitForInput(page, textareaSelector, { click: false });
        //await sleep(1500, 2500);

        // 2. 上传图片 (仅取第一张)
        if (imgPaths && imgPaths.length > 0) {
            logger.info('适配器', `开始上传 ${imgPaths.length} 张图片`, meta);
            const singleImage = [imgPaths[0]];
            if (imgPaths.length > 1) {
                logger.warn('适配器', `此后端仅支持1张图片, 已丢弃 ${imgPaths.length - 1} 张`, meta);
            }
            await pasteImages(page, textareaSelector, singleImage, {}, meta);
            logger.info('适配器', '图片上传完成', meta);
        }

        // 3. 输入提示词
        logger.info('适配器', '输入提示词...', meta);
        await safeClick(page, textareaSelector, { bias: 'input' });
        await humanType(page, textareaSelector, prompt);

        // 4. 先启动 API 监听
        logger.debug('适配器', '启动 API 监听...', meta);
        const responsePromise = waitApiResponse(page, {
            urlMatch: 'v1/generateContent',
            method: 'POST',
            timeout: waitTimeout,
            meta
        });

        // 5. 发送提示词
        logger.info('适配器', '发送提示词...', meta);
        await safeClick(page, 'div[class*="_sendButton_"]', { bias: 'button' });

        logger.info('适配器', '等待生成结果...', meta);

        // 6. 等待 API 响应
        let response;
        try {
            response = await responsePromise;
        } catch (e) {
            // 使用公共错误处理
            const pageError = normalizePageError(e, meta);
            if (pageError) return pageError;
            throw e;
        }

        // 6. 解析响应结果
        // 先尝试获取响应内容用于错误解析
        let content = null;
        try {
            content = await response.text();
        } catch (e) { }

        // 检查 HTTP 错误
        const httpError = normalizeHttpError(response, content);
        if (httpError) {
            logger.error('适配器', `请求生成时返回错误: ${httpError.error}`, meta);
            return { error: `请求生成时返回错误: ${httpError.error}` };
        }

        // 解析成功响应（使用已读取的 content）
        let body;
        try {
            body = JSON.parse(content);
        } catch (e) {
            logger.error('适配器', '解析响应JSON时出错', meta);
            return { error: '解析响应JSON时出错' };
        }

        // 7. 提取 base64 图片
        const inlineData = body?.data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

        if (inlineData) {
            logger.info('适配器', '已获取生结果, 且已获取图片数据', meta);
            return { image: `data:image/png;base64,${inlineData}` };
        } else {
            logger.info('适配器', 'AI 返回非图片响应', { ...meta, preview: JSON.stringify(body).substring(0, 150) });
            return { text: JSON.stringify(body) };
        }

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
    id: 'nanobananafree_ai',
    displayName: 'NanoBananaFree (图片生成)',
    description: '使用 NanoBananaFree 平台生成图片，仅支持上传单张图片。需要已登录的 Google 账户。',

    // 入口 URL
    getTargetUrl(config, workerConfig) {
        return TARGET_URL;
    },

    // 模型列表
    models: [
        { id: 'gemini-2.5-flash-image', imagePolicy: 'optional' }
    ],

    // 无需导航处理器
    navigationHandlers: [],

    // 核心生图方法
    generate
};
