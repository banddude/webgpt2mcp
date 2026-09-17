/** Exact composer input and one submission action. No response observer or retry. */
export async function fillExactPrompt(composer, prompt, readText) {
    await composer.fill(prompt, { timeout: 5000 });
    const actual = await readText(composer);
    // Textareas normalize line endings. Preserve all other whitespace and text.
    const normalizeLines = text => text.replace(/\r\n?/g, '\n');
    const p = normalizeLines(prompt);
    const a = normalizeLines(actual);
    if (a !== p) {
        let i = 0;
        while (i < Math.min(a.length, p.length) && a[i] === p[i]) i++;
        console.log(`[fillExactPrompt] diff at ${i}: expected=${JSON.stringify(p.slice(Math.max(0, i - 25), i + 25))} actual=${JSON.stringify(a.slice(Math.max(0, i - 25), i + 25))}`);
    }
    // Contenteditable composers render blank lines as block boundaries; innerText
    // shows them as spaces. Whitespace-insensitive comparison: fill() set the
    // text deterministically, verification only guards against gross corruption.
    const squash = t => t.replace(/\s+/g, ' ').trim();
    return a === p || squash(a) === squash(p);
}

export async function submitTurnOnce({ page, findSendButton, clickControl, clearModal, waitForComposer, cancelled = () => false, onAttempt = () => {} }) {
    const button = await findSendButton(page);
    if (cancelled()) return { ok: false, submitted: false, error: 'caller_disconnected' };
    let attempted = false;
    try {
        if (button) {
            attempted = true;
            onAttempt();
            const click = await clickControl(page, button);
            return { ok: true, submitted: true, method: 'button', click };
        }
        const overlay = await clearModal(page);
        if (overlay.visible) return { ok: false, submitted: false, error: 'conversation_rate_limit_modal' };
        const composer = await waitForComposer(page);
        await composer.focus();
        if (cancelled()) return { ok: false, submitted: false, error: 'caller_disconnected' };
        attempted = true;
        onAttempt();
        await page.keyboard.press('Enter');
        return { ok: true, submitted: true, method: 'keyboard' };
    } catch (error) {
        // Even a visibility error can arrive after a click reached the website.
        // Surface uncertainty; never fall back to a second click or Enter.
        return { ok: false, submitted: attempted ? null : false, submission_attempted: attempted,
            error: attempted ? 'send_outcome_unknown' : 'send_control_unavailable',
            detail: error?.message || String(error), retry_automatically: false };
    }
}
