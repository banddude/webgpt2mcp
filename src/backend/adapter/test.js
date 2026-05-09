/**
 * @fileoverview 浏览器测试适配器
 * 提供多种浏览器测试功能，包括 Cloudflare Turnstile 验证、指纹检测等
 * 
 * 模型类型:
 * - cloudflare-turnstile: 点击验证后截屏
 * - 其他 image 类型: 加载页面后截屏
 * - text 类型: 返回页面文本内容
 */

import { sleep } from '../engine/utils.js';
import {
    gotoWithCheck,
    normalizePageError
} from '../utils/index.js';
import { clickTurnstile } from '../utils/CloudflareBypass.js';
import { logger } from '../../utils/logger.js';

/**
 * 执行 Turnstile 验证并截屏
 */
async function handleTurnstile(page, meta) {
    const TARGET_URL = 'https://nopecha.com/captcha/turnstile';
    const HOST_SELECTOR = '#example-container5';

    logger.info('适配器', '开启 Turnstile 测试...', meta);
    await gotoWithCheck(page, TARGET_URL);

    // 等待页面加载
    await sleep(3000, 4000);

    // 使用通用 Cloudflare 验证码点击器
    const result = await clickTurnstile(page, HOST_SELECTOR, {
        timeout: 10000,
        waitAfterClick: 3000,
        meta
    });

    if (!result.success) {
        return { error: result.error };
    }

    // 截屏并返回
    logger.info('适配器', '正在截屏...', meta);
    const screenshot = await page.screenshot({ type: 'png', fullPage: true });
    const base64 = screenshot.toString('base64');

    return { image: `data:image/png;base64,${base64}` };
}

/**
 * 处理普通 image 类型：加载页面后截屏
 */
async function handleImagePage(page, url, meta) {
    logger.info('适配器', `正在加载页面: ${url}`, meta);
    await gotoWithCheck(page, url);

    // 等待页面加载完成
    await sleep(3000, 5000);

    // 截屏并返回
    logger.info('适配器', '正在截屏...', meta);
    const screenshot = await page.screenshot({ type: 'png', fullPage: true });
    const base64 = screenshot.toString('base64');

    return { image: `data:image/png;base64,${base64}` };
}

/**
 * 处理 ping0.cc：检测并处理 Cloudflare 验证后截屏
 */
async function handlePing0(page, url, meta) {
    logger.info('适配器', `正在加载页面: ${url}`, meta);
    await gotoWithCheck(page, url);

    // 等待页面加载
    await sleep(2000, 3000);

    // 检测是否有 Cloudflare 验证码
    const cfElement = await page.$('#captcha-element');
    if (cfElement) {
        logger.info('适配器', '检测到 Cloudflare 验证码，正在处理...', meta);

        const result = await clickTurnstile(page, '#captcha-element', {
            timeout: 10000,
            waitAfterClick: 5000,
            meta
        });

        if (!result.success) {
            logger.warn('适配器', `Cloudflare 验证失败: ${result.error}`, meta);
            // 继续截屏，可能验证页面也有价值
        }

        // 等待页面跳转或刷新
        await sleep(3000, 5000);
    }

    // 截屏并返回
    logger.info('适配器', '正在截屏...', meta);
    const screenshot = await page.screenshot({ type: 'png', fullPage: true });
    const base64 = screenshot.toString('base64');

    return { image: `data:image/png;base64,${base64}` };
}

/**
 * 处理 text 类型：返回页面文本内容
 */
async function handleTextPage(page, url, meta) {
    logger.info('适配器', `正在加载页面: ${url}`, meta);
    await gotoWithCheck(page, url);

    // 等待页面加载完成
    await sleep(1000, 2000);

    // 获取页面文本内容
    const textContent = await page.evaluate(() => document.body.innerText);
    logger.info('适配器', `获取文本内容，长度: ${textContent.length}`, meta);

    return { text: textContent.trim() };
}

/**
 * 主生成函数
 */
async function generate(context, prompt, imgPaths, modelId, meta = {}) {
    const { page } = context;

    try {
        // 查找模型配置
        const modelConfig = manifest.models.find(m => m.id === modelId);
        if (!modelConfig) {
            return { error: `未找到模型配置: ${modelId}` };
        }

        const { url, type } = modelConfig;

        // 根据模型 ID 和类型分发处理
        switch (modelId) {
            case 'cloudflare-turnstile':
                return await handleTurnstile(page, meta);
            case 'ping0':
                return await handlePing0(page, url, meta);
            default:
                // 根据类型分发
                return type === 'text'
                    ? await handleTextPage(page, url, meta)
                    : await handleImagePage(page, url, meta);
        }

    } catch (err) {
        const pageError = normalizePageError(err, meta);
        if (pageError) return pageError;

        logger.error('适配器', '任务失败', { ...meta, error: err.message });
        return { error: `任务失败: ${err.message}` };
    } finally { }
}

/**
 * 适配器 manifest
 */
export const manifest = {
    id: 'test',
    displayName: '浏览器检测，仅供调试使用',
    description: '包含 Cloudflare Turnstile 验证测试、浏览器指纹检测、IP 纯净度查询等功能，仅供调试使用。',

    getTargetUrl(config, workerConfig) {
        return 'https://abrahamjuliot.github.io/creepjs/';
    },

    models: [
        { id: 'cloudflare-turnstile', imagePolicy: 'forbidden', type: 'image', url: 'https://nopecha.com/captcha/turnstile' },
        { id: 'creepjs', imagePolicy: 'forbidden', type: 'image', url: 'https://abrahamjuliot.github.io/creepjs/' },
        { id: 'antibot', imagePolicy: 'forbidden', type: 'image', url: 'https://bot.sannysoft.com/' },
        { id: 'browserleaks-js', imagePolicy: 'forbidden', type: 'image', url: 'https://browserleaks.com/javascript' },
        { id: 'browserleaks-ip', imagePolicy: 'forbidden', type: 'image', url: 'https://browserleaks.com/ip' },
        { id: 'ip', imagePolicy: 'forbidden', type: 'text', url: 'https://api.ip.sb/ip' },
        { id: 'webgl', imagePolicy: 'forbidden', type: 'image', url: 'https://get.webgl.org/' },
        { id: 'ping0', imagePolicy: 'forbidden', type: 'image', url: 'https://ping0.cc/' },
    ],

    navigationHandlers: [],
    generate
};
