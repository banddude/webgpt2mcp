/** Browser ownership for explicit commands. There is no model task queue. */
export function createQueueManager(_queueConfig, { initBrowser, config, getCookies }) {
    let poolContext = null;
    let initPromise = null;
    let browserControlReason = null;
    function acquireControlLock(reason = 'admin-control') {
        if (browserControlReason !== null) return null;
        browserControlReason = reason;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            browserControlReason = null;
        };
    }
    return {
        acquireControlLock,
        isControlLocked: () => browserControlReason !== null,
        getStatus: () => ({ queueLength: 0, processing: 0, total: 0,
            browserControlLocked: browserControlReason !== null, browserControlReason }),
        getDetailedStatus: () => ({ processing: [], waiting: [] }),
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
