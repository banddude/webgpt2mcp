/** Read-only snapshots of one exact new conversation; never re-submit. */
export async function confirmNewUserTurnFromCloud(page, conversationId, prompt) {
    try {
        const raw = await page.evaluate(async ({ id, expected }) => {
            const result = (reason, status = null) => JSON.stringify({ reason, status });
            try {
                const signal = AbortSignal.timeout(3000);
                const sessionRes = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store', signal });
                if (!sessionRes.ok) return result('http_status', sessionRes.status);
                const session = await sessionRes.json();
                const headers = session?.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {};
                const res = await fetch(`https://chatgpt.com/backend-api/conversation/${id}`, {
                    credentials: 'include', headers, cache: 'no-store', signal,
                });
                if (!res.ok) return result('http_status', res.status);
                const data = await res.json();
                if (data.id !== id || !data.mapping || typeof data.mapping !== 'object' || Array.isArray(data.mapping)) return result('schema_mismatch');
                const users = Object.values(data.mapping).map(node => node?.message)
                    .filter(message => message?.author?.role === 'user');
                if (users.length === 0) return result('turn_not_found');
                if (users.length !== 1) return result('schema_mismatch');
                const parts = users[0]?.content?.parts;
                if (!Array.isArray(parts) || !parts.every(part => typeof part === 'string')) return result('schema_mismatch');
                const normalizeLines = text => text.replace(/\r\n?/g, '\n');
                return result(normalizeLines(parts.join('')) === normalizeLines(expected) ? 'confirmed' : 'turn_not_found');
            } catch (error) {
                return result(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout'
                    : error?.name === 'SyntaxError' ? 'schema_mismatch' : 'read_error');
            }
        }, { id: conversationId, expected: prompt });
        const value = JSON.parse(raw);
        const allowed = ['confirmed', 'http_status', 'schema_mismatch', 'turn_not_found', 'timeout', 'read_error'];
        if (!allowed.includes(value?.reason)) return { reason: 'schema_mismatch', status: null };
        return { reason: value.reason, status: Number.isInteger(value.status) ? value.status : null };
    } catch { return { reason: 'read_error', status: null }; }
}

/** Four bounded reads, with backoff; logging is restricted to reason and status. */
export async function confirmNewUserTurnWithRetry(page, id, prompt, { sleep, log }) {
    for (const delay of [0, 2000, 4000, 8000]) {
        if (delay) await sleep(delay);
        const result = await confirmNewUserTurnFromCloud(page, id, prompt);
        if (result.reason === 'confirmed') return true;
        log(result.reason, result.status);
    }
    return false;
}
