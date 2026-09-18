/** Browser ownership for explicit commands. There is no model task queue. */
const DEFAULT_CONTROL_WAIT_MS = 120 * 1000;

export function createQueueManager(_queueConfig, { initBrowser, config, getCookies } = {}) {
    let poolContext = null;
    let initPromise = null;
    let browserControlReason = null;
    // Mike (2026-09-17): this used to be a plain boolean — a second browser-control caller
    // was refused outright ("I can't take over the browser right now because another
    // ChatGPT Web task is using it"). It is now an awaitable FIFO mutex: callers line up
    // in arrival order and take the browser as soon as the previous holder releases, so
    // overlapping tool calls stagger themselves instead of failing. A wait cap (default
    // 120s, env WEBGPT2MCP_CONTROL_WAIT_MS) keeps a stuck line from hanging callers
    // forever; past the cap the acquire rejects with BROWSER_CONTROL_WAIT_TIMEOUT so the
    // route can still answer 409 with queue_position/waited_ms.
    const rawWaitMs = Number(process.env.WEBGPT2MCP_CONTROL_WAIT_MS);
    const controlWaitMsDefault = Number.isFinite(rawWaitMs) && rawWaitMs >= 0 ? rawWaitMs : DEFAULT_CONTROL_WAIT_MS;
    const controlWaiters = [];

    function controlWaitTimeoutError(waiter, position) {
        const waitedMs = Date.now() - waiter.enqueuedAt;
        const error = new Error(`browser control still busy after ${waitedMs}ms (reason: ${waiter.reason})`);
        error.code = 'BROWSER_CONTROL_WAIT_TIMEOUT';
        error.queuePosition = position;
        error.waitedMs = waitedMs;
        return error;
    }

    function controlWaitAbortedError() {
        const error = new Error('browser control wait cancelled: the HTTP client went away');
        error.code = 'BROWSER_CONTROL_WAIT_ABORTED';
        return error;
    }

    // Remove a queued waiter (its cap passed, or its client hung up). A granted holder is
    // not in the list anymore, so a late timer or abort for one is a no-op.
    function dropControlWaiter(waiter, error) {
        const index = controlWaiters.indexOf(waiter);
        if (index === -1) return;
        controlWaiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener('abort', waiter.onAbort);
        waiter.reject(error);
    }

    function grantNextControlWaiter() {
        const waiter = controlWaiters.shift();
        if (!waiter) return;
        clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener('abort', waiter.onAbort);
        browserControlReason = waiter.reason;
        let released = false;
        waiter.resolve(() => {
            if (released) return;
            released = true;
            browserControlReason = null;
            grantNextControlWaiter();
        });
    }

    function acquireControlLock(reason = 'admin-control', { waitMs, signal } = {}) {
        const cap = Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : controlWaitMsDefault;
        return new Promise((resolve, reject) => {
            if (signal?.aborted) { reject(controlWaitAbortedError()); return; }
            const waiter = {
                reason,
                enqueuedAt: Date.now(),
                resolve,
                reject,
                signal,
                timer: null,
                onAbort: () => dropControlWaiter(waiter, controlWaitAbortedError()),
            };
            signal?.addEventListener('abort', waiter.onAbort, { once: true });
            waiter.timer = setTimeout(() => {
                dropControlWaiter(waiter, controlWaitTimeoutError(waiter, controlWaiters.indexOf(waiter) + 1));
            }, cap);
            // Mike: stopping a conversation should not queue behind unrelated dispatches,
            // so a chatgpt-stop skips ahead of non-stop waiters. Only the wait line is
            // reordered — a holder already mid-turn is never preempted — and stops keep
            // their own arrival order among themselves.
            const firstNonStop = controlWaiters.findIndex((queued) => queued.reason !== 'chatgpt-stop');
            if (reason === 'chatgpt-stop' && firstNonStop !== -1) controlWaiters.splice(firstNonStop, 0, waiter);
            else controlWaiters.push(waiter);
            if (browserControlReason === null) grantNextControlWaiter();
        });
    }

    return {
        acquireControlLock,
        // True while anyone holds the browser or is lined up for it.
        isControlLocked: () => browserControlReason !== null || controlWaiters.length > 0,
        getStatus: () => ({ queueLength: 0, processing: 0, total: 0,
            browserControlLocked: browserControlReason !== null || controlWaiters.length > 0,
            browserControlReason, browserControlQueued: controlWaiters.length }),
        getDetailedStatus: () => ({ processing: [browserControlReason].filter(Boolean),
            waiting: controlWaiters.map((waiter) => waiter.reason) }),
        // ONESHOT: single-flight. Concurrent first calls used to each launch a browser and the
        // later one overwrote poolContext, orphaning the earlier browser (5 camoufox on 9/17).
        initializePool: async () => {
            if (poolContext) return poolContext;
            if (!initPromise) {
                initPromise = initBrowser(config)
                    .then((ctx) => { poolContext = ctx; return ctx; })
                    .finally(() => { initPromise = null; });
            }
            return initPromise;
        },
        isInitializing: () => initPromise !== null,
        getPoolContext: () => poolContext,
        resetPool: async () => {
            if (initPromise) { try { await initPromise; } catch { /* init failed; nothing to close */ } }
            const pm = poolContext?.poolManager; poolContext = null;
            if (pm?.closeAll) await pm.closeAll();
        },
        getWorkerCookies: async (workerName, domain) => {
            if (!getCookies) throw new Error('Browser cookies unavailable');
            return getCookies(workerName, domain);
        },
    };
}
