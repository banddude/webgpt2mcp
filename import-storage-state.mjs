import fs from 'fs';
import path from 'path';
import loadConfig, { resolveUserDataDir } from './src/config/index.js';
import { initBrowserBase } from './src/backend/engine/launcher.js';

const statePath = process.argv[2];
if (!statePath) throw new Error('usage: node import-storage-state.mjs <storage-state.json>');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const config = loadConfig();
config.browser = { ...(config.browser || {}), headless: true };
const userDataDir = resolveUserDataDir();
const { context, page } = await initBrowserBase(config, { userDataDir, instanceName: 'chatgpt-state-import' });
try {
  const allowed = (state.cookies || []).filter(c =>
    /(^|\.)(chatgpt\.com|openai\.com)$/.test(String(c.domain || '').replace(/^\./, ''))
  ).map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: typeof c.expires === 'number' ? c.expires : -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: ['Strict','Lax','None'].includes(c.sameSite) ? c.sameSite : 'Lax',
  }));
  if (allowed.length) await context.addCookies(allowed);

  for (const originState of (state.origins || [])) {
    if (!/^https:\/\/(chatgpt\.com|[^/]*\.openai\.com)$/.test(originState.origin || '')) continue;
    await page.goto(originState.origin, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const entries = originState.localStorage || [];
    await page.evaluate(entries => {
      for (const { name, value } of entries) localStorage.setItem(name, value);
    }, entries);
  }

  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  const auth = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/auth/session', { credentials: 'include' });
      if (!r.ok) return false;
      const data = await r.json();
      return !!(data?.accessToken || data?.user);
    } catch { return false; }
  });
  console.log(`imported_chatgpt_cookies=${allowed.length}`);
  console.log(`authenticated=${auth}`);
} finally {
  await context.close();
}
