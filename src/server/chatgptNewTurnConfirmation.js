/** One read-only snapshot of the exact new conversation, never a submit retry. */
export async function confirmNewUserTurnFromCloud(page, conversationId, prompt) {
    try {
        return await page.evaluate(async ({ id, expected }) => {
            try {
                const signal = AbortSignal.timeout(3000);
                const sessionRes = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store', signal });
                if (!sessionRes.ok) return false;
                const session = await sessionRes.json();
                const headers = session?.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {};
                const res = await fetch(`https://chatgpt.com/backend-api/conversation/${id}`, {
                    credentials: 'include', headers, cache: 'no-store', signal,
                });
                if (!res.ok) return false;
                const data = await res.json();
                if (data.id !== id || !data.mapping || typeof data.mapping !== 'object') return false;
                const users = Object.values(data.mapping).map(node => node?.message)
                    .filter(message => message?.author?.role === 'user');
                if (users.length !== 1) return false;
                const parts = users[0]?.content?.parts;
                if (!Array.isArray(parts) || !parts.every(part => typeof part === 'string')) return false;
                const normalizeLines = text => text.replace(/\r\n?/g, '\n');
                return normalizeLines(parts.join('')) === normalizeLines(expected);
            } catch { return false; }
        }, { id: conversationId, expected: prompt });
    } catch { return false; }
}
