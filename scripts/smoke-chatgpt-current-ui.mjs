#!/usr/bin/env node
import fs from 'node:fs/promises';

const base = process.env.CHATGPT_API_URL || 'http://127.0.0.1:17841';
const dispatch = process.argv.includes('--dispatch');
let apiKey = process.env.CHATGPT_API_KEY || '';
if (!apiKey) {
    try { apiKey = (await fs.readFile(new URL('../data/api.key', import.meta.url), 'utf8')).trim(); } catch { }
}
if (!apiKey) throw new Error('CHATGPT_API_KEY is required');

async function api(path, options = {}) {
    const response = await fetch(`${base}${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${apiKey}`,
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {}),
        },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${data?.error?.message || data?.error || data?.message || 'request failed'}`);
    return data;
}

const status = await api('/admin/chatgpt/status');
if (!status.loggedIn) throw new Error(`ChatGPT bridge is not authenticated: ${status.reason || status.state || 'unknown'}`);
const list = await api('/admin/chatgpt/conversations?limit=1');
console.log(JSON.stringify({
    status: 'ok',
    authMode: status.authMode || null,
    sessionKeys: status.sessionKeys || [],
    conversationsList: 'ok',
    conversationsReturned: Array.isArray(list.items) ? list.items.length : null,
    dispatch: dispatch ? 'pending' : 'skipped',
}, null, 2));

if (!dispatch) process.exit(0);

const marker = `BRIDGE_SMOKE_${Date.now()}`;
let conversationUrl = null;
try {
    const submitted = await api('/admin/chatgpt/dispatch', {
        method: 'POST',
        body: JSON.stringify({
            prompt: `Bridge smoke test. Reply exactly: ${marker}`,
            model: 'gpt-instant',
            spawner: 'smoke-test',
            task: 'webgpt2mcp current UI acceptance',
        }),
    });
    if (!submitted.success || !submitted.submitted || !submitted.conversation_url) {
        throw new Error(`dispatch did not confirm submission: ${JSON.stringify(submitted)}`);
    }
    conversationUrl = submitted.conversation_url;
    const id = conversationUrl.match(/\/c\/([0-9a-f-]{36})/i)?.[1];
    let replySeen = false;
    if (id) {
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
            const conv = await api(`/admin/chatgpt/conversation/${id}`);
            replySeen = Array.isArray(conv.messages) && conv.messages.some(message => message.role === 'assistant' && String(message.text || '').includes(marker));
            if (replySeen) break;
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
    }
    console.log(JSON.stringify({ dispatch: 'ok', conversationUrl, replySeen }, null, 2));
    if (!replySeen) process.exitCode = 2;
} finally {
    if (conversationUrl) {
        try {
            const deleted = await api('/admin/chatgpt/conversation', {
                method: 'DELETE',
                body: JSON.stringify({ conversation_url: conversationUrl }),
            });
            const cleanup = deleted.success ? 'ok' : 'failed';
            console.log(JSON.stringify({ cleanup, conversationUrl }, null, 2));
            if (!deleted.success) {
                console.error(`cleanup was not confirmed for ${conversationUrl}: ${JSON.stringify(deleted.cloud || deleted)}`);
                process.exitCode = process.exitCode || 3;
            }
        } catch (error) {
            console.error(`cleanup failed for ${conversationUrl}: ${error.message}`);
            process.exitCode = process.exitCode || 3;
        }
    }
}
