import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

const CHATGPT_ORIGIN = 'https://chatgpt.com';
const DEFAULT_LOGIN_URL = `${CHATGPT_ORIGIN}/auth/login`;

function decodeJwtPayload(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    try {
        const raw = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = raw.padEnd(Math.ceil(raw.length / 4) * 4, '=');
        return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    } catch {
        return null;
    }
}

function tokenTimes(token, nowMs = Date.now()) {
    const payload = decodeJwtPayload(token) || {};
    const issuedAt = Number.isFinite(payload.iat) ? payload.iat * 1000 : null;
    const expiresAt = Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
    return {
        tokenIssuedAt: issuedAt ? new Date(issuedAt).toISOString() : null,
        tokenExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        tokenAgeSeconds: issuedAt ? Math.max(0, Math.floor((nowMs - issuedAt) / 1000)) : null,
        tokenExpiresInSeconds: expiresAt ? Math.floor((expiresAt - nowMs) / 1000) : null,
    };
}

async function defaultNotifier(message) {
    const bin = process.env.WEBGPT2MCP_NOTIFY_BIN || 'notify';
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(bin, ['aiva', message], { stdio: 'ignore' });
        } catch {
            resolve(false);
            return;
        }
        child.once('error', () => resolve(false));
        child.once('exit', (code) => resolve(code === 0));
    });
}

export function createChatGptSessionManager({
    queueManager,
    dataDir = path.join(process.cwd(), 'data'),
    notifier = defaultNotifier,
    now = () => Date.now(),
} = {}) {
    const storageStatePath = path.join(dataDir, 'chatgpt-storage-state.json');
    const healthStatePath = path.join(dataDir, 'chatgpt-session-health.json');

    async function getPage() {
        let poolContext = queueManager?.getPoolContext?.();
        if (!poolContext) poolContext = await queueManager?.initializePool?.();
        return poolContext?.poolManager?.getFirstPage?.() || poolContext?.getFirstPage?.() || null;
    }

    async function readHealthState() {
        try {
            return JSON.parse(await fs.readFile(healthStatePath, 'utf8'));
        } catch {
            return {};
        }
    }

    async function writeHealthState(state) {
        await fs.mkdir(dataDir, { recursive: true });
        const temp = `${healthStatePath}.${process.pid}.tmp`;
        await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temp, healthStatePath);
    }

    async function persistStorageState(page) {
        const context = page?.context?.();
        if (!context?.storageState) return false;
        await fs.mkdir(dataDir, { recursive: true });
        const temp = `${storageStatePath}.${process.pid}.tmp`;
        await context.storageState({ path: temp });
        await fs.chmod(temp, 0o600).catch(() => {});
        await fs.rename(temp, storageStatePath);
        return true;
    }

    async function restoreCookies(page) {
        const context = page?.context?.();
        if (!context?.addCookies) return 0;
        let state;
        try {
            state = JSON.parse(await fs.readFile(storageStatePath, 'utf8'));
        } catch {
            return 0;
        }
        const cookies = (state.cookies || []).filter((cookie) => {
            const domain = String(cookie.domain || '').replace(/^\./, '');
            return domain === 'chatgpt.com' || domain.endsWith('.chatgpt.com') || domain === 'openai.com' || domain.endsWith('.openai.com');
        });
        if (!cookies.length) return 0;
        await context.addCookies(cookies);
        return cookies.length;
    }

    async function readBrowserSession(page) {
        return page.evaluate(async () => {
            try {
                const response = await fetch('https://chatgpt.com/api/auth/session', {
                    credentials: 'include',
                    cache: 'no-store',
                    headers: { 'Cache-Control': 'no-cache' },
                });
                if (!response.ok) {
                    return { ok: false, httpStatus: response.status, sessionKeys: [] };
                }
                const session = await response.json();
                return {
                    ok: !!session?.accessToken,
                    accessToken: session?.accessToken || null,
                    sessionKeys: Object.keys(session || {}),
                    userPresent: !!session?.user,
                };
            } catch (error) {
                return { ok: false, error: error?.message || String(error), sessionKeys: [] };
            }
        });
    }

    async function alertLoggedOutOnce(state, detail) {
        if (state.loggedOutAlerted) return state;
        const message = 'webgpt2mcp needs Mike to log in to ChatGPT. The persisted browser session is logged out, so steerable/readable ChatGPT web agents are unavailable until login is restored. Run the bridge login command to open the login page, then complete the sign-in once.';
        const notified = await notifier(message);
        if (notified === false) return state;
        const next = {
            ...state,
            loggedOutAlerted: true,
            loggedOutDetectedAt: new Date(now()).toISOString(),
            loggedOutDetail: detail || null,
        };
        await writeHealthState(next);
        return next;
    }

    async function inspect({ allowRestore = true, alert = true, persist = true } = {}) {
        const page = await getPage();
        if (!page) {
            return { loggedIn: false, state: 'browser-unavailable', restoredCookies: 0, persisted: false };
        }

        let session = await readBrowserSession(page);
        let restoredCookies = 0;
        if (!session.ok && allowRestore) {
            restoredCookies = await restoreCookies(page);
            if (restoredCookies > 0) {
                session = await readBrowserSession(page);
            }
        }

        let health = await readHealthState();
        if (session.ok && session.accessToken) {
            const persisted = persist ? await persistStorageState(page).catch(() => false) : false;
            health = {
                ...health,
                loggedOutAlerted: false,
                loggedOutDetectedAt: null,
                loggedOutDetail: null,
                lastAuthenticatedAt: new Date(now()).toISOString(),
            };
            await writeHealthState(health);
            return {
                loggedIn: true,
                state: 'logged-in',
                restoredCookies,
                persisted,
                lastAuthenticatedAt: health.lastAuthenticatedAt,
                ...tokenTimes(session.accessToken, now()),
            };
        }

        const detail = session.error || (session.httpStatus ? `session HTTP ${session.httpStatus}` : `session keys: ${(session.sessionKeys || []).join(',') || 'none'}`);
        if (alert) health = await alertLoggedOutOnce(health, detail);
        return {
            loggedIn: false,
            state: 'logged-out',
            restoredCookies,
            persisted: false,
            reason: detail,
            loginRequired: true,
            alertSent: !!health.loggedOutAlerted,
            loggedOutDetectedAt: health.loggedOutDetectedAt || null,
        };
    }

    async function persistAfterSuccess() {
        const page = await getPage();
        if (!page) return false;
        return persistStorageState(page);
    }

    async function openLogin({ waitSeconds = 0 } = {}) {
        const page = await getPage();
        if (!page) return { opened: false, error: 'ChatGPT browser page unavailable' };
        await page.goto(DEFAULT_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const deadline = now() + Math.max(0, Math.min(Number(waitSeconds || 0), 300)) * 1000;
        do {
            const status = await inspect({ allowRestore: false, alert: false, persist: true });
            if (status.loggedIn) return { opened: true, authenticated: true, status };
            if (now() >= deadline) break;
            await page.waitForTimeout(1000);
        } while (true);
        return { opened: true, authenticated: false, loginRequired: true, url: page.url() };
    }

    return {
        inspect,
        openLogin,
        persistAfterSuccess,
        storageStatePath,
        healthStatePath,
    };
}

export { decodeJwtPayload, tokenTimes };
