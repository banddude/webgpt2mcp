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

async function dispatchExactConversation({ conversation_url, prompt, agent, project, timeout = 120000 }) {
    if (!conversation_url || !prompt) throw new Error('conversation_url and prompt are required');
    const body = { conversation_url, prompt };
    if (typeof agent === 'string' && agent.trim()) body.agent = agent.trim();
    if (typeof project === 'string' && project.trim()) body.project = project.trim();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(`${API_URL}/admin/chatgpt/dispatch`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
            },
            body: JSON.stringify(body),
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

async function dispatchNewConversation({ prompt, model = 'gpt-instant', agent, project, spawner, task, timeout = 120000 }) {
    if (!prompt) throw new Error('prompt is required');
    const body = { prompt, model };
    if (typeof agent === 'string' && agent.trim()) body.agent = agent.trim();
    if (typeof project === 'string' && project.trim()) body.project = project.trim();
    if (typeof spawner === 'string' && spawner.trim()) body.spawner = spawner.trim();
    if (typeof task === 'string' && task.trim()) body.task = task.trim();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(`${API_URL}/admin/chatgpt/dispatch`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.success || !data?.submitted || !data?.detached) {
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

async function callChatGPT({ model = 'gpt-instant', messages, conversation_url, agent, project, timeout = 300000 }) {
    const body = { model, messages };
    if (conversation_url) body.conversation_url = conversation_url;
    if (typeof agent === 'string' && agent.trim()) body.agent = agent.trim();
    if (typeof project === 'string' && project.trim()) body.project = project.trim();

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

// Verified live: ChatGPT web projects are "snorlax" gizmos with g-p-* ids,
// surfaced as https://chatgpt.com/g/<g-p-id>[-slug] URLs.
const PROJECT_ID_RE = /^g-p-[0-9a-z]+$/i;
const PROJECT_URL_RE = /^https:\/\/chatgpt\.com\/g\/(g-p-[0-9a-z]+)/i;

function parseProjectRef(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return null;
    if (PROJECT_ID_RE.test(raw)) return raw;
    const match = raw.match(PROJECT_URL_RE);
    if (match) return match[1];
    return null;
}

function projectRefError() {
    return {
        content: [{
            type: 'text',
            text: 'Error: project must be an exact ChatGPT project ID (g-p-...) or an exact https://chatgpt.com/g/g-p-... URL. Project names are not accepted for this operation.',
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
            // Keep the published connector name working while clients migrate
            // to the explicit create/send surface below.
            name: 'chatgpt',
            description: 'Compatibility entry point for sending a ChatGPT message. It creates a new conversation unless an exact conversation URL is supplied.',
            inputSchema: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'Message to send to ChatGPT.' },
                    model: {
                        type: 'string',
                        enum: ['gpt-instant', 'gpt-thinking', 'gpt-pro'],
                        default: 'gpt-instant',
                        description: 'ChatGPT model to use.',
                    },
                    conversation_url: { type: 'string', description: 'Optional exact conversation URL to continue.' },
                    agent: { type: 'string', description: 'Optional project-routing agent key, such as dev or aiva.' },
                    project: { type: 'string', description: 'Optional exact project ID or project URL; use none to leave the conversation unmapped.' },
                    system_prompt: { type: 'string', description: 'Optional system instruction.' },
                    topic: { type: 'string', description: 'Optional local topic label.' },
                },
                required: ['prompt'],
            },
        },
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
                    agent: { type: 'string', description: 'Optional project-routing agent key, such as dev or aiva.' },
                    project: { type: 'string', description: 'Optional exact project ID or project URL; use none to leave the conversation unmapped.' },
                },
                required: ['conversation', 'message'],
            },
        },
        {
            name: 'dispatch',
            description: 'Create a new ChatGPT conversation, submit its first prompt, and return as soon as the user turn is confirmed. ChatGPT continues server-side after the browser handoff; use conversation_read with the returned exact conversation ID or URL to check completion. This tool does not hold a completion stream or browser lane.',
            inputSchema: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'First prompt for the new ChatGPT worker conversation.' },
                    model: {
                        type: 'string',
                        enum: ['gpt-instant', 'gpt-thinking', 'gpt-pro'],
                        default: 'gpt-instant',
                        description: 'ChatGPT model to use for the dispatched worker.',
                    },
                    agent: { type: 'string', description: 'Optional project-routing agent key, such as dev or aiva.' },
                    project: { type: 'string', description: 'Optional exact project ID or project URL; use none to leave the conversation unmapped.' },
                    spawner: { type: 'string', description: 'Optional worker-registry spawner attribution.' },
                    task: { type: 'string', description: 'Optional worker-registry task description.' },
                },
                required: ['prompt'],
            },
        },
        {
            name: 'create',
            description: 'Create a brand-new ChatGPT conversation and send its first message. This is the only tool in this MCP that is allowed to create a new conversation.',
            inputSchema: {
                type: 'object',
                properties: {
                    message: { type: 'string', description: 'First message for the new conversation.' },
                    agent: { type: 'string', description: 'Optional project-routing agent key, such as dev or aiva.' },
                    project: { type: 'string', description: 'Optional exact project ID or project URL; use none to leave the conversation unmapped.' },
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
        {
            name: 'rename',
            description: 'Rename one exact ChatGPT conversation. Requires an exact conversation ID or URL; never matches by title. The new title is read back from the ChatGPT cloud API to confirm the change.',
            inputSchema: {
                type: 'object',
                properties: {
                    conversation: { type: 'string', description: 'Exact ChatGPT conversation UUID or exact https://chatgpt.com/c/... URL.' },
                    title: { type: 'string', description: 'New title for the conversation.' },
                },
                required: ['conversation', 'title'],
            },
        },
        {
            name: 'archive',
            description: 'Archive one exact ChatGPT conversation (removes it from the active sidebar, keeps it retrievable). Requires an exact conversation ID or URL; never matches by title. The archive state is read back to confirm.',
            inputSchema: {
                type: 'object',
                properties: {
                    conversation: { type: 'string', description: 'Exact ChatGPT conversation UUID or exact https://chatgpt.com/c/... URL.' },
                },
                required: ['conversation'],
            },
        },
        {
            name: 'unarchive',
            description: 'Restore one exact archived ChatGPT conversation back to the active sidebar. Requires an exact conversation ID or URL; never matches by title. The archive state is read back to confirm.',
            inputSchema: {
                type: 'object',
                properties: {
                    conversation: { type: 'string', description: 'Exact ChatGPT conversation UUID or exact https://chatgpt.com/c/... URL.' },
                },
                required: ['conversation'],
            },
        },
        {
            name: 'projects_list',
            description: 'List ChatGPT projects with their exact project IDs and URLs. Discovery only; it never changes anything. Use the returned exact ID with project_conversations or move.',
            inputSchema: {
                type: 'object',
                properties: {
                    limit: { type: 'number', minimum: 1, maximum: 50, default: 50, description: 'Maximum number of projects to return (ChatGPT caps this at 50).' },
                },
            },
        },
        {
            name: 'project_conversations',
            description: 'List the conversations inside one exact ChatGPT project. Requires an exact project ID (g-p-...) or exact https://chatgpt.com/g/g-p-... URL. Discovery only; it never changes anything.',
            inputSchema: {
                type: 'object',
                properties: {
                    project: { type: 'string', description: 'Exact ChatGPT project ID (g-p-...) or exact https://chatgpt.com/g/g-p-... URL.' },
                    limit: { type: 'number', minimum: 1, maximum: 50, default: 28, description: 'Maximum number of conversations to return (ChatGPT caps this at 50).' },
                },
                required: ['project'],
            },
        },
        {
            name: 'move',
            description: 'Move one exact conversation into a ChatGPT project, or out of any project. Requires an exact conversation ID or URL and an exact project ID or URL (or "none" to remove it from its project). Never matches by title. The resulting project membership is read back to confirm.',
            inputSchema: {
                type: 'object',
                properties: {
                    conversation: { type: 'string', description: 'Exact ChatGPT conversation UUID or exact https://chatgpt.com/c/... URL.' },
                    project: { type: 'string', description: 'Exact project ID (g-p-...) or exact https://chatgpt.com/g/g-p-... URL to move into, or the literal string "none" to move the conversation out of any project.' },
                },
                required: ['conversation', 'project'],
            },
        },
        {
            name: 'project_create',
            description: 'Create a new ChatGPT project with the given name. Optional project instructions (the project-level custom instructions ChatGPT applies to conversations inside it) default to empty. Returns the new exact project ID and URL, confirmed against the projects list.',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Name for the new project.' },
                    instructions: { type: 'string', description: 'Optional project instructions applied to conversations inside the project. Defaults to empty.' },
                },
                required: ['name'],
            },
        },
        {
            name: 'project_rename',
            description: 'Rename one exact ChatGPT project. Requires an exact project ID (g-p-...) or exact https://chatgpt.com/g/g-p-... URL; never matches by title. The project\'s emoji, theme, and instructions are preserved. The new name is read back to confirm.',
            inputSchema: {
                type: 'object',
                properties: {
                    project: { type: 'string', description: 'Exact ChatGPT project ID (g-p-...) or exact https://chatgpt.com/g/g-p-... URL.' },
                    name: { type: 'string', description: 'New name for the project.' },
                },
                required: ['project', 'name'],
            },
        },
        {
            name: 'project_delete',
            description: 'Delete one exact ChatGPT project. DESTRUCTIVE BEYOND THE PROJECT: every conversation inside the project is deleted with it (verified live - a conversation moved into a test project returned 404 after the project was deleted). Requires an exact project ID (g-p-...) or exact https://chatgpt.com/g/g-p-... URL and explicit confirm=true. Only use after the user explicitly approved deleting the project AND its conversations. The removal is read back from the projects list to confirm.',
            inputSchema: {
                type: 'object',
                properties: {
                    project: { type: 'string', description: 'Exact ChatGPT project ID (g-p-...) or exact https://chatgpt.com/g/g-p-... URL.' },
                    confirm: { type: 'boolean', description: 'Must be true to confirm the destructive deletion.' },
                },
                required: ['project', 'confirm'],
            },
        },
    ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
        if (name === 'chatgpt') {
            const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
            if (!prompt) return { content: [{ type: 'text', text: 'Error: prompt is required.' }], isError: true };

            const allowedModels = new Set(['gpt-instant', 'gpt-thinking', 'gpt-pro']);
            const model = allowedModels.has(args.model) ? args.model : 'gpt-instant';
            const messages = [];
            if (typeof args.system_prompt === 'string' && args.system_prompt.trim()) {
                messages.push({ role: 'system', content: args.system_prompt.trim() });
            }
            messages.push({ role: 'user', content: prompt });

            const data = await callChatGPT({
                model,
                messages,
                conversation_url: typeof args.conversation_url === 'string' ? args.conversation_url.trim() : undefined,
                agent: typeof args.agent === 'string' ? args.agent.trim() : undefined,
                project: typeof args.project === 'string' ? args.project.trim() : undefined,
            });
            const result = formatResult(data);
            const convUrl = data.conversation_url || '';
            if (convUrl && !data.error) {
                await recordSession({
                    conversation_url: convUrl,
                    model,
                    prompt,
                    response_content: data.choices?.[0]?.message?.content || '',
                    topic: typeof args.topic === 'string' ? args.topic.trim() : '',
                });
            }
            return result;
        }

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

            const dispatched = await dispatchExactConversation({
                conversation_url: ref.url,
                prompt: message,
                agent: typeof args.agent === 'string' ? args.agent.trim() : undefined,
                project: typeof args.project === 'string' ? args.project.trim() : undefined,
            });
            await recordSession({ conversation_url: ref.url, model: 'unknown', prompt: message, response_content: '', topic: '' });
            const behavior = dispatched.active_before ? 'The previous active response was stopped first, then the message was sent.' : 'The message was sent to the idle conversation.';
            return {
                content: [{ type: 'text', text: `${behavior}\n\n[conversation: ${ref.url}]` }],
                _meta: {
                    conversation_id: ref.id,
                    conversation_url: ref.url,
                    detached: dispatched.detached !== false,
                    completion_polling: dispatched.completion_polling !== false,
                    active_before: !!dispatched.active_before,
                    exact_user_turn_confirmed: !!dispatched.exact_user_turn_confirmed,
                    response_started: dispatched.response_started ?? null,
                },
            };
        }

        if (name === 'dispatch') {
            const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
            if (!prompt) return { content: [{ type: 'text', text: 'Error: prompt is required.' }], isError: true };
            const allowedModels = new Set(['gpt-instant', 'gpt-thinking', 'gpt-pro']);
            const model = allowedModels.has(args.model) ? args.model : 'gpt-instant';
            const dispatched = await dispatchNewConversation({
                prompt,
                model,
                agent: typeof args.agent === 'string' ? args.agent.trim() : undefined,
                project: typeof args.project === 'string' ? args.project.trim() : undefined,
                spawner: typeof args.spawner === 'string' ? args.spawner.trim() : undefined,
                task: typeof args.task === 'string' ? args.task.trim() : undefined,
            });
            const conversationUrl = dispatched.conversation_url || '';
            if (conversationUrl) {
                await recordSession({
                    conversation_url: conversationUrl,
                    model,
                    prompt,
                    response_content: '',
                    topic: '',
                });
            }
            return {
                content: [{
                    type: 'text',
                    text: `Submitted the ChatGPT worker prompt. ChatGPT continues server-side; use conversation_read to check it.\n\n[conversation: ${conversationUrl}]`,
                }],
                _meta: {
                    conversation_id: dispatched.conversation_id,
                    conversation_url: conversationUrl,
                    detached: true,
                    completion_polling: true,
                    stream_status: dispatched.stream_status_after || null,
                },
            };
        }

        if (name === 'create') {
            const message = typeof args.message === 'string' ? args.message.trim() : '';
            if (!message) return { content: [{ type: 'text', text: 'Error: message is required.' }], isError: true };
            const model = args.model || 'gpt-instant';
            const data = await callChatGPT({
                model,
                messages: [{ role: 'user', content: message }],
                agent: typeof args.agent === 'string' ? args.agent.trim() : undefined,
                project: typeof args.project === 'string' ? args.project.trim() : undefined,
            });
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

        if (name === 'rename') {
            const ref = parseConversationRef(args.conversation);
            if (!ref) return exactRefError();
            const title = typeof args.title === 'string' ? args.title.trim() : '';
            if (!title) return { content: [{ type: 'text', text: 'Error: title is required.' }], isError: true };

            const result = await adminJson('/admin/chatgpt/rename', {
                method: 'POST',
                body: JSON.stringify({ conversation_url: ref.url, title }),
            });
            if (result?.success !== true) throw new Error(result?.error || 'ChatGPT rename failed.');

            // Keep the local index title in sync so later searches reflect reality.
            const store = await loadSessions();
            const existing = store.sessions.find(session => session.conversation_url === ref.url);
            if (existing) {
                existing.topic = result.title || title;
                await saveSessions(store);
            }
            return {
                content: [{ type: 'text', text: `Renamed conversation to "${result.title}".${result.verified === false ? ' Warning: the new title could not be verified by reading the conversation back.' : ''}\n\n[conversation: ${ref.url}]` }],
                _meta: { conversation_id: ref.id, conversation_url: ref.url, title: result.title, verified: result.verified !== false },
            };
        }

        if (name === 'archive' || name === 'unarchive') {
            const ref = parseConversationRef(args.conversation);
            if (!ref) return exactRefError();
            const archived = name === 'archive';

            const result = await adminJson('/admin/chatgpt/archive', {
                method: 'POST',
                body: JSON.stringify({ conversation_url: ref.url, archived }),
            });
            if (result?.success !== true) throw new Error(result?.error || `ChatGPT ${name} failed.`);

            const state = result.is_archived === true ? 'archived' : 'active';
            return {
                content: [{ type: 'text', text: `Conversation "${result.title || 'Untitled'}" is now ${state}.${result.verified === false ? ' Warning: the new state could not be verified by reading the conversation back.' : ''}\n\n[conversation: ${ref.url}]` }],
                _meta: { conversation_id: ref.id, conversation_url: ref.url, is_archived: result.is_archived === true, title: result.title || null, verified: result.verified !== false },
            };
        }

        if (name === 'projects_list') {
            const limit = Math.max(1, Math.min(Number(args.limit || 50), 50));
            const data = await adminJson(`/admin/chatgpt/projects?limit=${limit}`);
            const projects = Array.isArray(data.projects) ? data.projects : [];
            if (!projects.length) {
                return { content: [{ type: 'text', text: 'No ChatGPT projects found.' }] };
            }
            const lines = projects.map((project, index) =>
                `${index + 1}. ${project.title}\n   ID: ${project.id}\n   URL: ${project.url || `https://chatgpt.com/g/${project.id}`}\n   Last activity: ${project.last_interacted_at || project.update_time || 'unknown'}`);
            return {
                content: [{ type: 'text', text: lines.join('\n\n') }],
                _meta: { count: projects.length },
            };
        }

        if (name === 'project_conversations') {
            const projectId = parseProjectRef(args.project);
            if (!projectId) return projectRefError();
            const limit = Math.max(1, Math.min(Number(args.limit || 28), 50));
            const data = await adminJson(`/admin/chatgpt/projects/${encodeURIComponent(projectId)}/conversations?limit=${limit}`);
            const conversations = Array.isArray(data.conversations) ? data.conversations : [];
            if (!conversations.length) {
                return { content: [{ type: 'text', text: `Project ${projectId} has no conversations.` }] };
            }
            const lines = conversations.map((conversation, index) =>
                `${index + 1}. ${conversation.title}\n   ID: ${conversation.id}\n   URL: https://chatgpt.com/c/${conversation.id}\n   Last activity: ${conversation.update_time || 'unknown'}`);
            return {
                content: [{ type: 'text', text: lines.join('\n\n') }],
                _meta: { project_id: projectId, count: conversations.length },
            };
        }

        if (name === 'move') {
            const ref = parseConversationRef(args.conversation);
            if (!ref) return exactRefError();
            if (args.project === undefined || args.project === null) return projectRefError();

            let projectId = null;
            let movingOut = false;
            if (typeof args.project === 'string' && args.project.trim().toLowerCase() === 'none') {
                movingOut = true;
            } else {
                projectId = parseProjectRef(args.project);
                if (!projectId) return projectRefError();
            }

            const result = await adminJson('/admin/chatgpt/move', {
                method: 'POST',
                body: JSON.stringify({ conversation_url: ref.url, project: movingOut ? 'none' : projectId }),
            });
            if (result?.success !== true) throw new Error(result?.error || 'ChatGPT move failed.');

            const target = result.project_id
                ? `project ${result.project_id} (${result.moved_to})`
                : 'no project (removed from any project)';
            return {
                content: [{ type: 'text', text: `Moved conversation to ${target}.${result.verified === false ? ' Warning: the new project membership could not be verified by reading the conversation back.' : ''}\n\n[conversation: ${ref.url}]` }],
                _meta: {
                    conversation_id: ref.id,
                    conversation_url: ref.url,
                    project_id: result.project_id || null,
                    project_url: result.moved_to || null,
                    verified: result.verified !== false,
                },
            };
        }

        if (name === 'project_create') {
            const projectName = typeof args.name === 'string' ? args.name.trim() : '';
            if (!projectName) return { content: [{ type: 'text', text: 'Error: name is required.' }], isError: true };
            const instructions = typeof args.instructions === 'string' ? args.instructions : '';

            const result = await adminJson('/admin/chatgpt/projects', {
                method: 'POST',
                body: JSON.stringify({ name: projectName, instructions }),
            });
            if (result?.success !== true) throw new Error(result?.error || 'ChatGPT project creation failed.');

            const project = result.project || {};
            return {
                content: [{ type: 'text', text: `Created ChatGPT project "${project.title || projectName}".${result.verified === false ? ' Warning: the new project could not be verified against the projects list.' : ''}\n\n[project: ${project.url || `https://chatgpt.com/g/${project.id}`}]` }],
                _meta: { project_id: project.id || null, project_url: project.url || null, title: project.title || null, verified: result.verified !== false },
            };
        }

        if (name === 'project_rename') {
            const projectId = parseProjectRef(args.project);
            if (!projectId) return projectRefError();
            const projectName = typeof args.name === 'string' ? args.name.trim() : '';
            if (!projectName) return { content: [{ type: 'text', text: 'Error: name is required.' }], isError: true };

            const result = await adminJson('/admin/chatgpt/projects/rename', {
                method: 'POST',
                body: JSON.stringify({ project: projectId, name: projectName }),
            });
            if (result?.success !== true) throw new Error(result?.error || 'ChatGPT project rename failed.');

            const project = result.project || {};
            return {
                content: [{ type: 'text', text: `Renamed ChatGPT project to "${project.title || projectName}".${result.verified === false ? ' Warning: the new name could not be verified against the projects list.' : ''}\n\n[project: ${project.url || `https://chatgpt.com/g/${projectId}`}]` }],
                _meta: { project_id: projectId, project_url: project.url || null, title: project.title || null, verified: result.verified !== false },
            };
        }

        if (name === 'project_delete') {
            const projectId = parseProjectRef(args.project);
            if (!projectId) return projectRefError();
            if (args.confirm !== true) {
                return { content: [{ type: 'text', text: 'Error: project_delete requires confirm=true after explicit user approval.' }], isError: true };
            }

            const result = await adminJson('/admin/chatgpt/projects', {
                method: 'DELETE',
                body: JSON.stringify({ project: projectId }),
            });
            if (result?.success !== true) throw new Error(result?.error || 'ChatGPT project deletion failed.');

            return {
                content: [{ type: 'text', text: `Deleted ChatGPT project ${projectId}. All conversations that were inside it have been deleted with it.${result.verified === false ? ' Warning: the project may still appear in the projects list; re-check with projects_list.' : ''}` }],
                _meta: { project_id: projectId, verified: result.verified !== false },
            };
        }

        return { content: [{ type: 'text', text: `Error: unknown tool "${name}".` }], isError: true };
    } catch (err) {
        const detail = err?.data?.actual_url ? ` Browser URL: ${err.data.actual_url}.` : '';
        return { content: [{ type: 'text', text: `Error: ${err.message}.${detail}` }], isError: true };
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);
