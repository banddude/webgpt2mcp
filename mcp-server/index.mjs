#!/usr/bin/env node
/**
 * webgpt2mcp — ChatGPT Web to MCP Server
 * 将 WebAI2API 的 ChatGPT 网页端能力暴露为 MCP 工具
 * 支持会话管理：自动保存、列表查询、智能继续、Skill 注入
 */

import fs from 'fs/promises';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const API_URL = process.env.CHATGPT_API_URL || 'http://127.0.0.1:3000';
const API_KEY = process.env.CHATGPT_API_KEY;
if (!API_KEY) {
    console.error('[chatgpt-web] CHATGPT_API_KEY environment variable is required');
    process.exit(1);
}
const SESSIONS_FILE = path.join(path.dirname(import.meta.url.replace('file://', '')), 'sessions.json');

// ==========================================
// 会话存储
// ==========================================

async function loadSessions() {
    try {
        const data = await fs.readFile(SESSIONS_FILE, 'utf-8');
        return JSON.parse(data);
    } catch {
        return { sessions: [] };
    }
}

async function saveSessions(store) {
    // 只保留最近 50 个会话
    store.sessions.sort((a, b) => new Date(b.last_used) - new Date(a.last_used));
    if (store.sessions.length > 50) store.sessions = store.sessions.slice(0, 50);
    await fs.writeFile(SESSIONS_FILE, JSON.stringify(store, null, 2));
}

async function recordSession({ conversation_url, model, prompt, response_content, topic }) {
    if (!conversation_url) return;
    const store = await loadSessions();
    const existing = store.sessions.find(s => s.conversation_url === conversation_url);
    // 限制单条消息存储长度，避免 sessions.json 膨胀
    const maxLen = 4000;
    const msg = {
        role: 'user',
        content: prompt.length > maxLen ? prompt.slice(0, maxLen) + '...(truncated)' : prompt,
        time: new Date().toISOString(),
    };
    const assistantMsg = {
        role: 'assistant',
        content: (response_content || '').length > maxLen ? response_content.slice(0, maxLen) + '...(truncated)' : (response_content || ''),
        time: new Date().toISOString(),
    };
    if (existing) {
        existing.last_used = new Date().toISOString();
        existing.message_count = (existing.message_count || 0) + 1;
        if (topic) existing.topic = topic;
        if (!existing.messages) existing.messages = []; // 兼容旧格式
        existing.messages.push(msg);
        if (response_content) existing.messages.push(assistantMsg);
        // 清理旧格式字段
        delete existing.first_prompt;
        delete existing.last_response;
    } else {
        store.sessions.push({
            conversation_url,
            model: model || 'unknown',
            topic: topic || '',
            messages: [msg, ...(response_content ? [assistantMsg] : [])],
            message_count: 1,
            created_at: new Date().toISOString(),
            last_used: new Date().toISOString(),
        });
    }
    await saveSessions(store);
}

// ==========================================
// API 调用
// ==========================================

async function dispatchExactConversation({ conversation_url, prompt, timeout = 120000 }) {
    if (!conversation_url || !prompt) throw new Error('conversation_url and prompt are required');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(`${API_URL}/admin/chatgpt/dispatch`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
            },
            body: JSON.stringify({ conversation_url, prompt }),
            signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.success || !data?.submitted) {
            const rawReason = data?.error || `HTTP ${response.status}`;
            const reason = typeof rawReason === 'string' ? rawReason : (rawReason?.message || JSON.stringify(rawReason));
            const error = new Error(reason);
            error.status = response.status;
            error.data = data;
            throw error;
        }
        return data;
    } finally {
        clearTimeout(timer);
    }
}

async function callChatGPT({ model = 'gpt-instant', messages, conversation_url, timeout = 300000 }) {
    const body = { model, messages };
    if (conversation_url) body.conversation_url = conversation_url;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(`${API_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

function formatResult(data) {
    if (data.error) {
        return { content: [{ type: 'text', text: `Error: ${data.error.message || JSON.stringify(data.error)}` }], isError: true };
    }
    const content = data.choices?.[0]?.message?.content || 'No response';
    const convUrl = data.conversation_url || '';
    const model = data.model || '';
    let text = content;
    if (convUrl) text += `\n\n[conversation: ${convUrl} | model: ${model}]`;
    return { content: [{ type: 'text', text }], _meta: { conversation_url: convUrl, model } };
}

// ==========================================
// MCP Server
// ==========================================

const server = new Server(
    { name: 'webgpt2mcp', version: '2.0.0' },
    { capabilities: { tools: {} } },
);

const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONVERSATION_URL_RE = /^https:\/\/chatgpt\.com\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

function parseConversationRef(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return null;
    if (CONVERSATION_ID_RE.test(raw)) {
        return { id: raw.toLowerCase(), url: `https://chatgpt.com/c/${raw.toLowerCase()}` };
    }
    const match = raw.match(CONVERSATION_URL_RE);
    if (!match) return null;
    const id = match[1].toLowerCase();
    return { id, url: `https://chatgpt.com/c/${id}` };
}

function exactRefError() {
    return {
        content: [{
            type: 'text',
            text: 'Error: conversation must be an exact ChatGPT conversation ID or an exact https://chatgpt.com/c/... URL. Titles, topics, and fuzzy names are not accepted for this operation.',
        }],
        isError: true,
    };
}

async function adminJson(pathname, options = {}) {
    const response = await fetch(`${API_URL}${pathname}`, {
        ...options,
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {}),
        },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const rawReason = data?.error?.message || data?.error || data?.message || `HTTP ${response.status}`;
        const reason = typeof rawReason === 'string' ? rawReason : JSON.stringify(rawReason);
        const error = new Error(reason);
        error.status = response.status;
        error.data = data;
        throw error;
    }
    return data;
}

async function listCloudConversations({ limit = 20, includeStatus = true, includeLastMessage = false } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit || 20), 50));
    const params = new URLSearchParams({ limit: String(safeLimit) });
    if (includeStatus) params.set('include_status', '1');
    if (includeLastMessage) params.set('include_last_message', '1');
    const data = await adminJson(`/admin/chatgpt/conversations?${params.toString()}`);
    return Array.isArray(data.items) ? data.items : [];
}

async function readCloudConversation(id) {
    return adminJson(`/admin/chatgpt/conversation/${id}`);
}

async function updateConversationIndex(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    const store = await loadSessions();
    const byUrl = new Map(store.sessions.map(session => [session.conversation_url, session]));
    for (const item of items) {
        if (!item?.id) continue;
        const url = `https://chatgpt.com/c/${item.id}`;
        const existing = byUrl.get(url);
        if (existing) {
            if (item.title) existing.topic = item.title;
            if (item.model) existing.model = item.model;
            if (item.update_time) existing.last_used = item.update_time;
        } else {
            const created = {
                conversation_url: url,
                model: item.model || 'unknown',
                topic: item.title || 'Untitled',
                messages: [],
                message_count: 0,
                created_at: item.create_time || new Date().toISOString(),
                last_used: item.update_time || new Date().toISOString(),
            };
            store.sessions.push(created);
            byUrl.set(url, created);
        }
    }
    await saveSessions(store);
}

function localConversationIndexItems(store) {
    return (store.sessions || []).map(session => {
        const ref = parseConversationRef(session.conversation_url);
        if (!ref) return null;
        return {
            id: ref.id,
            title: session.topic || 'Untitled',
            update_time: session.last_used || null,
            model: session.model || null,
        };
    }).filter(Boolean);
}

async function stopExactConversation({ conversation_url, timeout = 120000 }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(`${API_URL}/admin/chatgpt/stop`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
            },
            body: JSON.stringify({ conversation_url }),
            signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.success) {
            const rawReason = data?.error || `HTTP ${response.status}`;
            const reason = typeof rawReason === 'string' ? rawReason : (rawReason?.message || JSON.stringify(rawReason));
            const error = new Error(reason);
            error.status = response.status;
            error.data = data;
            throw error;
        }
        return data;
    } finally {
        clearTimeout(timer);
    }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'conversations_list',
            description: 'List recent ChatGPT conversations. Returns exact conversation IDs and URLs, titles, last activity, and current streaming state. This is a discovery tool only and never changes a conversation.',
            inputSchema: {
                type: 'object',
                properties: {
                    limit: { type: 'number', minimum: 1, maximum: 50, default: 20, description: 'Maximum number of recent conversations to return.' },
                },
            },
        },
        {
            name: 'conversation_read',
            description: 'Read one exact ChatGPT conversation and return its metadata, current streaming state, and full visible user/assistant transcript. Requires an exact conversation ID or exact ChatGPT conversation URL. Titles and fuzzy names are rejected.',
            inputSchema: {
                type: 'object',
                properties: {
                    conversation: { type: 'string', description: 'Exact ChatGPT conversation UUID or exact https://chatgpt.com/c/... URL.' },
                },
                required: ['conversation'],
            },
        },
        {
            name: 'conversations_search',
            description: 'Search recent ChatGPT conversation titles. Returns matching exact conversation IDs and URLs for later read/send operations. Discovery only: it never selects a match automatically and never changes a conversation.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Text to search for in recent conversation titles.' },
                    limit: { type: 'number', minimum: 1, maximum: 20, default: 10, description: 'Maximum number of matches to return.' },
                },
                required: ['query'],
            },
        },
        {
            name: 'send',
            description: 'Send a message to one exact existing ChatGPT conversation. Requires an exact conversation ID or URL and never creates a new chat. If that conversation is currently generating, send automatically performs Stop, waits for the old response to stop, then sends the new message through the normal exact-send path.',
            inputSchema: {
                type: 'object',
                properties: {
                    conversation: { type: 'string', description: 'Exact ChatGPT conversation UUID or exact https://chatgpt.com/c/... URL.' },
                    message: { type: 'string', description: 'Message to send to the exact conversation.' },
                },
                required: ['conversation', 'message'],
            },
        },
        {
            name: 'create',
            description: 'Create a brand-new ChatGPT conversation and send its first message. This is the only tool in this MCP that is allowed to create a new conversation.',
            inputSchema: {
                type: 'object',
                properties: {
                    message: { type: 'string', description: 'First message for the new conversation.' },
                    model: {
                        type: 'string',
                        enum: ['gpt-instant', 'gpt-thinking', 'gpt-pro'],
                        default: 'gpt-instant',
                        description: 'ChatGPT model to use for the new conversation.',
                    },
                },
                required: ['message'],
            },
        },
        {
            name: 'stop',
            description: 'Stop the active response in one exact ChatGPT conversation without sending a replacement message. Requires an exact conversation ID or URL and never guesses by title or topic.',
            inputSchema: {
                type: 'object',
                properties: {
                    conversation: { type: 'string', description: 'Exact ChatGPT conversation UUID or exact https://chatgpt.com/c/... URL.' },
                },
                required: ['conversation'],
            },
        },
        {
            name: 'delete',
            description: 'Delete one exact ChatGPT conversation from ChatGPT cloud storage. Requires an exact conversation ID or URL and explicit confirm=true. Only use after the user explicitly approved deletion.',
            inputSchema: {
                type: 'object',
                properties: {
                    conversation: { type: 'string', description: 'Exact ChatGPT conversation UUID or exact https://chatgpt.com/c/... URL.' },
                    confirm: { type: 'boolean', description: 'Must be true to confirm the destructive deletion.' },
                },
                required: ['conversation', 'confirm'],
            },
        },
    ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
        if (name === 'conversations_list') {
            let items = await listCloudConversations({ limit: args.limit, includeStatus: true, includeLastMessage: false });
            await updateConversationIndex(items);
            const limit = Math.max(1, Math.min(Number(args.limit || 20), 50));
            items = items.slice(0, limit);

            if (!items.length) {
                return { content: [{ type: 'text', text: 'No ChatGPT conversations found.' }] };
            }

            const lines = items.map((item, index) => {
                const url = `https://chatgpt.com/c/${item.id}`;
                const title = item.title || 'Untitled';
                const status = item.stream_status || 'UNKNOWN';
                const updated = item.last_message_time || item.update_time || 'unknown';
                return `${index + 1}. ${title}\n   ID: ${item.id}\n   URL: ${url}\n   Status: ${status}\n   Last activity: ${updated}`;
            });
            return { content: [{ type: 'text', text: lines.join('\n\n') }] };
        }

        if (name === 'conversation_read') {
            const ref = parseConversationRef(args.conversation);
            if (!ref) return exactRefError();
            const data = await readCloudConversation(ref.id);
            if (!Array.isArray(data.messages)) throw new Error('Conversation transcript was unavailable.');

            const status = data.stream_status || 'UNKNOWN';
            const header = `${data.title || 'Untitled'}\nID: ${ref.id}\nURL: ${ref.url}\nStatus: ${status}\nMessages: ${data.messages.length}`;
            const transcript = data.messages.map((message, index) => {
                const role = message.role === 'user' ? 'User' : 'Assistant';
                const time = message.create_time ? new Date(message.create_time * 1000).toISOString() : '';
                const model = message.model ? ` | model: ${message.model}` : '';
                return `${index + 1}. ${role}${time ? ` | ${time}` : ''}${model}\n${message.text || ''}`;
            }).join('\n\n');
            return {
                content: [{ type: 'text', text: `${header}\n${'-'.repeat(40)}\n${transcript}` }],
                _meta: { conversation_id: ref.id, conversation_url: ref.url, stream_status: status },
            };
        }

        if (name === 'conversations_search') {
            const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
            if (!query) return { content: [{ type: 'text', text: 'Error: query is required.' }], isError: true };
            const requested = Math.max(1, Math.min(Number(args.limit || 10), 20));

            let items = [];
            let source = 'cloud';
            let cloudError = null;
            try {
                items = await listCloudConversations({ limit: 20, includeStatus: false, includeLastMessage: false });
                await updateConversationIndex(items);
            } catch (error) {
                cloudError = error;
                source = 'local-index';
                items = localConversationIndexItems(await loadSessions());
            }

            const matches = items
                .filter(item => (item.title || '').toLowerCase().includes(query))
                .slice(0, requested);

            if (!matches.length) {
                const suffix = source === 'local-index'
                    ? ' ChatGPT discovery was unavailable, and the local conversation index had no matching title.'
                    : '';
                return { content: [{ type: 'text', text: `No recent ChatGPT conversations matched "${args.query}".${suffix}` }] };
            }

            const lines = matches.map((item, index) => `${index + 1}. ${item.title || 'Untitled'}\n   ID: ${item.id}\n   URL: https://chatgpt.com/c/${item.id}\n   Last activity: ${item.update_time || 'unknown'}`);
            const prefix = source === 'local-index'
                ? `ChatGPT discovery is temporarily unavailable (${cloudError?.message || 'unknown error'}). Results below come from the local conversation index; use the returned exact ID/URL for any real operation.\n\n`
                : '';
            return { content: [{ type: 'text', text: prefix + lines.join('\n\n') }] };
        }

        if (name === 'send') {
            const ref = parseConversationRef(args.conversation);
            if (!ref) return exactRefError();
            const message = typeof args.message === 'string' ? args.message.trim() : '';
            if (!message) return { content: [{ type: 'text', text: 'Error: message is required.' }], isError: true };

            const dispatched = await dispatchExactConversation({ conversation_url: ref.url, prompt: message });
            await recordSession({ conversation_url: ref.url, model: 'unknown', prompt: message, response_content: '', topic: '' });
            const behavior = dispatched.active_before ? 'The previous active response was stopped first, then the message was sent.' : 'The message was sent to the idle conversation.';
            return {
                content: [{ type: 'text', text: `${behavior}\n\n[conversation: ${ref.url}]` }],
                _meta: {
                    conversation_id: ref.id,
                    conversation_url: ref.url,
                    active_before: !!dispatched.active_before,
                    exact_user_turn_confirmed: !!dispatched.exact_user_turn_confirmed,
                    response_started: dispatched.response_started ?? null,
                },
            };
        }

        if (name === 'create') {
            const message = typeof args.message === 'string' ? args.message.trim() : '';
            if (!message) return { content: [{ type: 'text', text: 'Error: message is required.' }], isError: true };
            const model = args.model || 'gpt-instant';
            const data = await callChatGPT({ model, messages: [{ role: 'user', content: message }] });
            const result = formatResult(data);
            const convUrl = data.conversation_url || '';
            if (convUrl && !data.error) {
                await recordSession({
                    conversation_url: convUrl,
                    model,
                    prompt: message,
                    response_content: data.choices?.[0]?.message?.content || '',
                    topic: '',
                });
            }
            return result;
        }

        if (name === 'stop') {
            const ref = parseConversationRef(args.conversation);
            if (!ref) return exactRefError();
            const stopped = await stopExactConversation({ conversation_url: ref.url });
            const text = stopped.already_idle
                ? `Conversation was already idle.\n\n[conversation: ${ref.url}]`
                : `Stopped the active ChatGPT response.\n\n[conversation: ${ref.url}]`;
            return {
                content: [{ type: 'text', text }],
                _meta: { conversation_id: ref.id, conversation_url: ref.url, already_idle: !!stopped.already_idle },
            };
        }

        if (name === 'delete') {
            const ref = parseConversationRef(args.conversation);
            if (!ref) return exactRefError();
            if (args.confirm !== true) {
                return { content: [{ type: 'text', text: 'Error: delete requires confirm=true after explicit user approval.' }], isError: true };
            }
            const deletion = await adminJson('/admin/chatgpt/conversation', {
                method: 'DELETE',
                body: JSON.stringify({ conversation_url: ref.url }),
            });
            if (deletion?.success !== true) throw new Error('ChatGPT cloud deletion failed.');

            const store = await loadSessions();
            store.sessions = store.sessions.filter(session => session.conversation_url !== ref.url);
            await saveSessions(store);
            return { content: [{ type: 'text', text: `Deleted ChatGPT conversation ${ref.id}.` }], _meta: { conversation_id: ref.id, conversation_url: ref.url } };
        }

        return { content: [{ type: 'text', text: `Error: unknown tool "${name}".` }], isError: true };
    } catch (err) {
        const detail = err?.data?.actual_url ? ` Browser URL: ${err.data.actual_url}.` : '';
        return { content: [{ type: 'text', text: `Error: ${err.message}.${detail}` }], isError: true };
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);
