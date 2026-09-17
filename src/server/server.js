/** HTTP server for explicit authenticated website controls and saved history. */

import http from 'http';

// ==================== 启动前自检 ====================
import { runPreflight } from './preflight.js';
runPreflight();
// ==================== 加载其他依赖 ====================
const { getBackend } = await import('../backend/index.js');
const { logger } = await import('../utils/logger.js');
const { createQueueManager, createGlobalRouter } = await import('./index.js');
const { isUnderSupervisor } = await import('../utils/ipc.js');
const { loadTodayStats } = await import('../utils/stats.js');
const { initHistoryDb } = await import('../utils/history.js');

// ==================== 初始化配置 ====================

/**
 * 从统一后端获取配置和函数
 */
let backend;
try {
    backend = getBackend();
} catch (err) {
    logger.error('服务器', '配置加载失败', { error: err.message });
    logger.error('服务器', '请先初始化配置：复制 config.example.yaml 为 config.yaml');
    process.exit(78);  // 使用 78 退出码，supervisor 不会自动重启
}

const { config, initBrowser, TEMP_DIR } = backend;

/** @type {number} 服务器端口 */
const PORT = config.server?.port || 3000;

/** @type {string} 认证令牌 */
const AUTH_TOKEN = config.server?.auth;

// Browser initialization and exclusive ownership, with no generation queue.
const queueManager = createQueueManager({}, {
    initBrowser, config,
    getCookies: backend.getCookies ? (workerName, domain) => backend.getCookies(workerName, domain) : null,
});

// ==================== 创建路由 ====================

/**
 * 检测是否为登录模式
 */
const isLoginMode = process.argv.some(arg => arg.startsWith('-login'));

/**
 * 安全模式状态
 * 当 Pool 初始化失败时进入安全模式，此时：
 * - HTTP 服务器正常启动
 * - Admin API 和 WebUI 可用
 * - Browser commands report unavailable
 */
let safeMode = false;
let safeModeReason = null;

const routedRequest = createGlobalRouter({
    authToken: AUTH_TOKEN,
    tempDir: TEMP_DIR,
    queueManager,
    config,
    loginMode: isLoginMode,
    getSafeMode: () => ({ enabled: safeMode, reason: safeModeReason })
});
// ONESHOT: after any browser-facing request finishes, close the browser (debounced so a
// burst of calls, e.g. dispatch then conversation_read, does not relaunch between them).
const ONESHOT_CLOSE_DELAY_MS = Number(process.env.WEBGPT2MCP_CLOSE_DELAY_MS || 3000);
let oneshotCloseTimer = null;
function oneshotScheduleClose(pathname) {
    // Only browser-facing calls: the MCP tools go through /admin/chatgpt/* and the OpenAI-style /v1/*.
    if (!pathname || !(pathname.startsWith('/admin/chatgpt/') || pathname.startsWith('/v1/'))) return;
    if (oneshotCloseTimer) clearTimeout(oneshotCloseTimer);
    oneshotCloseTimer = setTimeout(async () => {
        oneshotCloseTimer = null;
        try { await queueManager.resetPool?.(); logger.info('服务器', 'ONESHOT: browser closed after call'); }
        catch (e) { logger.warn('服务器', `ONESHOT close failed: ${e.message}`); }
    }, ONESHOT_CLOSE_DELAY_MS);
}
function handleRequest(req, res) {
    let pathname = '';
    try { pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname; } catch (e) { /* ignore */ }
    if (oneshotCloseTimer && pathname && (pathname.startsWith('/admin/chatgpt/') || pathname.startsWith('/v1/'))) { clearTimeout(oneshotCloseTimer); oneshotCloseTimer = null; }
    res.on('finish', () => oneshotScheduleClose(pathname));
    return routedRequest(req, res);
}

// ==================== 启动服务器 ====================

/**
 * 启动 HTTP 服务器
 * @returns {Promise<void>}
 */
async function startServer() {
    // 加载今日统计
    await loadTodayStats();

    // 初始化历史记录数据库
    try {
        await initHistoryDb();
    } catch (err) {
        logger.warn('服务器', '历史记录数据库初始化失败，功能可能不可用', { error: err.message });
    }

    // 登录模式提示
    if (isLoginMode) {
        logger.info('服务器', '登录模式已就绪，请在浏览器中完成登录操作');
        logger.info('服务器', '完成后可直接关闭浏览器窗口或按 Ctrl+C 退出');
    }

    // ONESHOT (Mike, 2026-09-17): the browser is launched on the first tool call and
    // closed after each call, so nothing runs between calls. Eager launch only if asked.
    try {
        if (process.env.WEBGPT2MCP_EAGER_BROWSER === '1') await queueManager.initializePool();
    } catch (err) {
        logger.error('服务器', '工作池初始化失败', { error: err.message });
        logger.warn('服务器', '进入安全模式：WebUI and Admin API remain available; browser commands require recovery');
        logger.warn('服务器', '请通过 配置文件或者 WebUI 修改正确的配置后重启服务');
        safeMode = true;
        safeModeReason = err.message;
    }

    // 创建并启动 HTTP 服务器
    const server = http.createServer(handleRequest);

    // 处理 WebSocket 升级请求（VNC 代理）
    server.on('upgrade', async (req, socket, head) => {
        const url = new URL(req.url, `http://${req.headers.host}`);

        // 只处理 /admin/vnc 路径
        if (url.pathname === '/admin/vnc') {
            const { handleVncUpgrade } = await import('./api/admin/vncProxy.js');
            await handleVncUpgrade(req, socket, head, AUTH_TOKEN);
        } else {
            socket.destroy();
        }
    });

    server.listen(PORT, () => {
        const mode = isUnderSupervisor() ? 'Supervisor 托管' : '独立运行';
        const modeExtra = isLoginMode ? ' (登录模式)' : '';
        logger.info('服务器', `HTTP 服务器已启动，端口: ${PORT}${modeExtra}`);
        logger.info('服务器', `运行模式: ${mode}`);

    });
}

// 启动服务器
startServer();
