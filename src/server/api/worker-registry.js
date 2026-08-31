/**
 * @fileoverview Dispatched ChatGPT worker registry
 * @description Append-only JSONL journal of spawned worker chats so spawners can
 *              be tracked and workers closed when they respond. One JSON object
 *              per line; for a given conversation the latest line wins, and
 *              history is never rewritten. Registry failures must never fail a
 *              dispatch, so every write error is reported on the console only.
 */

import { appendFile, mkdir } from 'node:fs/promises';
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

async function appendLine(entry) {
    try {
        await mkdir(REGISTRY_DIR, { recursive: true });
        await appendFile(REGISTRY_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (err) {
        console.error(`[worker-registry] append failed: ${err?.message || err}`);
    }
}

/**
 * Record a spawned (or re-activated) worker chat as open. Fire-and-forget:
 * callers do not await this, and a failed write only reaches the console.
 */
export function recordWorkerSpawn({ conversationId, url, spawner, task, model } = {}) {
    const id = cleanText(conversationId).toLowerCase() || conversationIdFromUrl(url);
    if (!id) return;
    appendLine({
        ts: new Date().toISOString(),
        conversation_id: id,
        url: `https://chatgpt.com/c/${id}`,
        spawner: cleanText(spawner) || 'unknown',
        task: cleanText(task),
        model: cleanText(model),
        status: 'open',
    });
}
