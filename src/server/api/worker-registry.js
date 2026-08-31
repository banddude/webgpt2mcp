/**
 * @fileoverview Dispatched ChatGPT worker registry
 * @description Append-only JSONL journal of spawned worker chats so spawners can
 *              be tracked and workers closed when they respond. One JSON object
 *              per line; for a given conversation the latest line wins, and
 *              history is never rewritten. Registry failures must never fail a
 *              dispatch, so every write error is reported on the console only.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data');
const REGISTRY_PATH = path.join(REGISTRY_DIR, 'worker-registry.jsonl');
const DEFAULT_POLL_INTERVAL_MS = 5000;

// Matches plain https://chatgpt.com/c/<id> and project-scoped
// https://chatgpt.com/g/<project>/c/<id> URLs alike.
const CONVERSATION_URL_RE = /chatgpt\.com\/(?:g\/[0-9a-z-]+\/)?c\/([0-9a-f][0-9a-f-]*)/i;

export function workerRegistryPath() {
    return REGISTRY_PATH;
}

export function conversationIdFromUrl(url) {
    const match = typeof url === 'string' ? url.match(CONVERSATION_URL_RE) : null;
    return match ? match[1].toLowerCase() : null;
}

function cleanText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

// Keep append operations ordered. A completion poll can run at the same time as
// a newly accepted dispatch, and the append-only journal must never put the
// close line ahead of the corresponding open line.
let appendTail = Promise.resolve();

function appendLine(entry) {
    const write = appendTail.then(async () => {
        try {
            await mkdir(REGISTRY_DIR, { recursive: true });
            await appendFile(REGISTRY_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
        } catch (err) {
            console.error(`[worker-registry] append failed: ${err?.message || err}`);
        }
    });
    appendTail = write.catch(() => {});
    return write;
}

function normalizeConversationId(conversationId, url) {
    return cleanText(conversationId).toLowerCase() || conversationIdFromUrl(url);
}

function normalizeMessageText(value) {
    return cleanText(value).replace(/\s+/g, ' ');
}

function registryEntryUrl(id, url) {
    return `https://chatgpt.com/c/${id}`;
}

/**
 * Record a spawned (or re-activated) worker chat as open. Fire-and-forget:
 * callers do not await this, and a failed write only reaches the console.
 */
export function recordWorkerSpawn({ conversationId, url, spawner, task, model, prompt } = {}) {
    const id = normalizeConversationId(conversationId, url);
    if (!id) return;
    void appendLine({
        ts: new Date().toISOString(),
        conversation_id: id,
        url: registryEntryUrl(id, url),
        spawner: cleanText(spawner) || 'unknown',
        task: cleanText(task),
        model: cleanText(model),
        prompt: cleanText(prompt).slice(0, 4000),
        status: 'open',
    });
}

/**
 * Record that a dispatched worker's conversation has completed. Like spawn
 * records, close records are append-only and deliberately cannot fail the
 * caller that observed completion.
 */
export function recordWorkerClose({ conversationId, url, note = '' } = {}) {
    const id = normalizeConversationId(conversationId, url);
    if (!id) return;
    void appendLine({
        ts: new Date().toISOString(),
        conversation_id: id,
        url: registryEntryUrl(id, url),
        status: 'closed',
        note: cleanText(note),
    });
}

function parseRegistryLines(content) {
    return String(content || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .flatMap(line => {
            try {
                const entry = JSON.parse(line);
                return entry && typeof entry === 'object' && entry.conversation_id ? [entry] : [];
            } catch {
                return [];
            }
        });
}

/**
 * Collapse the append-only registry to the latest state for each conversation.
 * Close lines intentionally carry only status/timestamp/note, so spawn
 * attribution is retained across the state transition.
 */
export function workerRegistryStates(entries = []) {
    const states = new Map();
    for (const entry of entries) {
        const id = cleanText(entry?.conversation_id).toLowerCase();
        if (!id) continue;
        const state = states.get(id) || {
            conversation_id: id,
            url: entry.url || `https://chatgpt.com/c/${id}`,
            spawner: entry.spawner || 'unknown',
            task: entry.task || '',
            model: entry.model || '',
            prompt: entry.prompt || '',
            status: entry.status || 'open',
            ts: entry.ts || '',
            note: entry.note || '',
        };
        for (const key of ['url', 'spawner', 'task', 'model', 'prompt', 'status', 'ts', 'note']) {
            if (entry[key] !== undefined && entry[key] !== null && entry[key] !== '') {
                state[key] = entry[key];
            }
        }
        states.set(id, state);
    }
    return [...states.values()];
}

export async function openWorkerRegistryStates() {
    let content = '';
    try {
        content = await readFile(REGISTRY_PATH, 'utf8');
    } catch (err) {
        if (err?.code !== 'ENOENT') {
            console.error(`[worker-registry] read failed: ${err?.message || err}`);
        }
    }
    return workerRegistryStates(parseRegistryLines(content))
        .filter(state => state.status === 'open');
}

/**
 * A conversation is complete only when its cloud read is authoritative,
 * reports a non-streaming state, and the visible transcript ends in an
 * assistant turn. This prevents a transient 429/unknown state or a prompt
 * that has not started yet from being closed prematurely.
 */
export function isConversationComplete(conversation, expectedPrompt = '') {
    if (!conversation || conversation.error) return false;
    const streamStatus = String(conversation.stream_status || conversation.streamStatus || '').toUpperCase();
    if (!streamStatus || streamStatus === 'IS_STREAMING' || streamStatus.startsWith('HTTP_')) return false;
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role !== 'assistant' || typeof lastMessage.text !== 'string' || !lastMessage.text.trim()) return false;
    const expected = normalizeMessageText(expectedPrompt);
    if (!expected) return true;
    const latestUser = [...messages].reverse().find(message => message?.role === 'user');
    return normalizeMessageText(latestUser?.text) === expected;
}

/**
 * Start a best-effort, unref'd completion poller. It performs periodic cloud
 * conversation reads through the supplied existing conversation endpoint; it
 * never opens a stream or holds a browser control lock.
 */
export function startWorkerRegistryPoller({
    readConversation,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    logger = console,
} = {}) {
    if (typeof readConversation !== 'function') {
        return { pollNow: async () => ({ checked: 0, closed: 0 }), stop: () => {} };
    }

    const parsedInterval = Number(intervalMs);
    const delay = Number.isFinite(parsedInterval) && parsedInterval > 0
        ? parsedInterval
        : DEFAULT_POLL_INTERVAL_MS;
    let polling = false;
    let stopped = false;

    const log = (level, message, meta) => {
        if (typeof logger?.[level] === 'function') {
            logger[level]('Worker registry', message, meta);
        }
    };

    const pollNow = async () => {
        if (stopped || polling) return { checked: 0, closed: 0, skipped: true };
        polling = true;
        let checked = 0;
        let closed = 0;
        try {
            const workers = await openWorkerRegistryStates();
            for (const worker of workers) {
                checked += 1;
                let conversation = null;
                try {
                    conversation = await readConversation(worker.conversation_id);
                } catch (err) {
                    log('warn', `Completion read failed for ${worker.conversation_id}: ${err?.message || err}`);
                    continue;
                }
                if (!isConversationComplete(conversation, worker.prompt)) continue;
                recordWorkerClose({
                    conversationId: worker.conversation_id,
                    url: worker.url,
                    note: 'completion poller',
                });
                closed += 1;
                log('info', `Closed completed worker ${worker.conversation_id}`);
            }
            return { checked, closed };
        } catch (err) {
            log('warn', `Completion poll failed: ${err?.message || err}`);
            return { checked, closed, error: err?.message || String(err) };
        } finally {
            polling = false;
        }
    };

    const timer = setInterval(() => { void pollNow(); }, delay);
    timer.unref?.();
    const initialTimer = setTimeout(() => { void pollNow(); }, Math.min(delay, 1000));
    initialTimer.unref?.();

    return {
        pollNow,
        stop: () => {
            stopped = true;
            clearInterval(timer);
            clearTimeout(initialTimer);
        },
    };
}
