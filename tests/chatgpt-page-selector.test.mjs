import assert from 'node:assert/strict';
import test from 'node:test';

import {
    scoreChatGptPageState,
    selectChatGptControlPage,
} from '../src/server/chatgptPageSelector.js';

function fakePage(state) {
    return {
        isClosed: () => false,
        evaluate: async () => state,
    };
}

test('page scoring strongly prefers authenticated state and penalizes auth modal', () => {
    const healthy = scoreChatGptPageState({
        authenticated: true,
        urlIsChatGpt: true,
        desktopComposerVisible: true,
        mobileComposerVisible: false,
        authDialogVisible: false,
    });
    const stale = scoreChatGptPageState({
        authenticated: true,
        urlIsChatGpt: true,
        desktopComposerVisible: false,
        mobileComposerVisible: true,
        authDialogVisible: true,
    });
    const loggedOutDesktop = scoreChatGptPageState({
        authenticated: false,
        urlIsChatGpt: true,
        desktopComposerVisible: true,
        mobileComposerVisible: false,
        authDialogVisible: false,
    });
    assert.ok(healthy > stale);
    assert.ok(stale > loggedOutDesktop);
});

test('control page selection chooses signed-in desktop worker instead of worker zero mobile auth page', async () => {
    const staleFirst = fakePage({
        authenticated: true,
        urlIsChatGpt: true,
        desktopComposerVisible: false,
        mobileComposerVisible: true,
        authDialogVisible: true,
    });
    const healthySecond = fakePage({
        authenticated: true,
        urlIsChatGpt: true,
        desktopComposerVisible: true,
        mobileComposerVisible: false,
        authDialogVisible: false,
    });
    const poolContext = {
        poolManager: {
            workers: [{ name: 'worker-0', page: staleFirst }, { name: 'worker-1', page: healthySecond }],
            getFirstPage: () => staleFirst,
        },
    };

    const selected = await selectChatGptControlPage(poolContext);
    assert.equal(selected, healthySecond);
});

test('control page selection falls back to first page when worker metadata is unavailable', async () => {
    const fallback = fakePage({});
    const selected = await selectChatGptControlPage({
        poolManager: { workers: [], getFirstPage: () => fallback },
    });
    assert.equal(selected, fallback);
});
