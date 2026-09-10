/** Browser ownership for explicit commands. There is no model task queue. */
export function createQueueManager(_queueConfig, { initBrowser, config, getCookies }) {
    let poolContext = null;
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
        initializePool: async () => { poolContext = await initBrowser(config); return poolContext; },
        getPoolContext: () => poolContext,
        getWorkerCookies: async (workerName, domain) => {
            if (!getCookies) throw new Error('Browser cookies unavailable');
            return getCookies(workerName, domain);
        },
    };
}
