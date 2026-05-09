/**
 * @fileoverview Cloudflare 验证绕过工具
 * 提供通用的 Cloudflare Turnstile 验证码点击功能
 */

import { sleep, safeClick } from '../engine/utils.js';
import { logger } from '../../utils/logger.js';

/**
 * 递归查找具有 shadowRootUnl 的子元素
 * @param {ElementHandle} hostHandle - 宿主元素句柄
 * @returns {Promise<ElementHandle|null>}
 */
async function findElementWithShadowRoot(hostHandle) {
    return await hostHandle.evaluateHandle(el => {
        for (const child of el.querySelectorAll('*')) {
            if (child.shadowRootUnl) {
                return child;
            }
        }
        return null;
    });
}

/**
 * 通用 Cloudflare Turnstile 验证码点击器
 * 
 * 支持穿透多层 closed shadow-root 和 iframe 找到并点击 checkbox
 * 
 * @param {Page} page - Playwright page 对象
 * @param {string} hostSelector - 宿主元素选择器，如 '#example-container5' 或 '.cf-turnstile'
 * @param {object} [options={}] - 配置选项
 * @param {number} [options.timeout=10000] - 等待超时时间
 * @param {number} [options.waitAfterClick=5000] - 点击后等待时间
 * @param {object} [options.meta={}] - 日志元数据
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function clickTurnstile(page, hostSelector, options = {}) {
    const {
        timeout = 10000,
        waitAfterClick = 5000,
        meta = {}
    } = options;

    try {
        // 1. 获取宿主元素
        logger.info('人机盾', '正在查找宿主元素...', meta);
        const hostLocator = page.locator(hostSelector).first();

        await hostLocator.waitFor({ state: 'visible', timeout });
        const hostHandle = await hostLocator.elementHandle();

        if (!hostHandle) {
            return { success: false, error: '无法获取宿主元素句柄' };
        }

        // 2. 查找有 shadowRootUnl 的子元素
        logger.info('人机盾', '正在查找 shadowRootUnl 子元素...', meta);
        const childWithShadowHandle = await findElementWithShadowRoot(hostHandle);
        const childElement = childWithShadowHandle.asElement();

        if (!childElement) {
            return { success: false, error: '未找到有 shadowRootUnl 的子元素' };
        }

        logger.debug('人机盾', '找到 shadowRootUnl 子元素', meta);

        // 3. 获取第一层 shadow-root 并找到 iframe
        const shadowRootHandle = await childElement.evaluateHandle(el => el.shadowRootUnl);
        const iframeHandle = await shadowRootHandle.evaluateHandle(root => root?.querySelector('iframe'));
        const iframeElement = iframeHandle.asElement();

        if (!iframeElement) {
            return { success: false, error: '第一层 shadow-root 内未找到 iframe' };
        }

        logger.debug('人机盾', '找到 iframe，正在进入...', meta);

        // 4. 获取 iframe 的 contentFrame
        const frame = await iframeElement.contentFrame();

        // 辅助函数：坐标点击
        const clickByCoordinates = async () => {
            const box = await iframeElement.boundingBox();
            if (!box) return false;

            const checkboxX = box.x + 28;
            const checkboxY = box.y + box.height / 2;
            await page.mouse.move(checkboxX, checkboxY, { steps: 10 });
            await sleep(300, 500);
            await page.mouse.click(checkboxX, checkboxY);
            logger.info('人机盾', '我是人类！ (坐标模式)', meta);
            return true;
        };

        if (!frame) {
            logger.warn('人机盾', '无法获取 iframe contentFrame，尝试坐标点击...', meta);
            if (await clickByCoordinates()) {
                await sleep(waitAfterClick, waitAfterClick + 3000);
                return { success: true };
            }
            return { success: false, error: '无法获取 iframe 边界框' };
        }

        // 5. 在 iframe 内查找有 shadowRootUnl 的元素
        logger.debug('人机盾', '正在查找 iframe 内的 shadow-root...', meta);
        await sleep(1000, 2000);

        const bodyWithShadowHandle = await frame.evaluateHandle(() => {
            if (document.body && document.body.shadowRootUnl) {
                return document.body;
            }
            for (const el of document.querySelectorAll('*')) {
                if (el.shadowRootUnl) {
                    return el;
                }
            }
            return null;
        });

        const bodyElement = bodyWithShadowHandle.asElement();
        if (!bodyElement) {
            logger.warn('人机盾', 'iframe 内未找到 shadowRootUnl 元素，尝试坐标点击...', meta);
            if (await clickByCoordinates()) {
                await sleep(waitAfterClick, waitAfterClick + 3000);
                return { success: true };
            }
            return { success: false, error: 'iframe 内未找到有 shadowRootUnl 的元素' };
        }

        logger.debug('人机盾', '找到 iframe 内的 shadowRootUnl 宿主', meta);

        // 6. 获取 iframe 内部的 shadow-root 并查找 checkbox
        const innerShadowRootHandle = await bodyElement.evaluateHandle(el => el.shadowRootUnl);
        const checkboxHandle = await innerShadowRootHandle.evaluateHandle(root => {
            if (!root) return null;
            const checkbox = root.querySelector('input[type="checkbox"]');
            if (checkbox) return checkbox;
            return root.querySelector('input');
        });

        const checkboxElement = checkboxHandle.asElement();
        if (!checkboxElement) {
            logger.warn('人机盾', 'shadow-root 内未找到 checkbox，尝试坐标点击...', meta);
            if (await clickByCoordinates()) {
                await sleep(waitAfterClick, waitAfterClick + 3000);
                return { success: true };
            }
            return { success: false, error: 'iframe shadow-root 内未找到 checkbox' };
        }

        // 7. 直接点击 checkbox
        logger.info('人机盾', '找到 checkbox，正在点击...', meta);
        await safeClick(page, checkboxElement, { bias: 'random' });
        logger.info('人机盾', '我是人类！(元素模式)', meta);

        await sleep(waitAfterClick, waitAfterClick + 3000);
        return { success: true };

    } catch (err) {
        logger.error('人机盾', `点击失败: ${err.message}`, meta);
        return { success: false, error: err.message };
    }
}
