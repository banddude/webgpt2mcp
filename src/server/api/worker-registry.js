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

// Keep explicit journal writes ordered; no completion observer runs here.
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
