import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isConversationComplete,
    workerRegistryStates,
} from '../src/server/api/worker-registry.js';

const assistantMessage = { role: 'assistant', text: 'Done.' };

test('completion requires a non-streaming state and a final assistant message', () => {
    assert.equal(isConversationComplete({ stream_status: 'IS_STREAMING', messages: [assistantMessage] }), false);
    assert.equal(isConversationComplete({ stream_status: 'HTTP_429', messages: [assistantMessage] }), false);
    assert.equal(isConversationComplete({ stream_status: 'COMPLETE', messages: [{ role: 'user', text: 'Do it.' }] }), false);
    assert.equal(isConversationComplete({ stream_status: 'COMPLETE', messages: [assistantMessage] }), true);
});

test('registry close state retains the original worker attribution', () => {
    const conversationId = '12345678-1234-1234-1234-1234567890ab';
    const states = workerRegistryStates([
        {
            ts: '2026-08-31T20:00:00.000Z',
            conversation_id: conversationId,
            url: `https://chatgpt.com/c/${conversationId}`,
        spawner: 'aiva',
        task: 'detach smoke',
        model: 'gpt-thinking',
        prompt: 'Do it.',
        status: 'open',
        },
        {
            ts: '2026-08-31T20:00:05.000Z',
            conversation_id: conversationId,
            status: 'closed',
            note: 'completion poller',
        },
    ]);

    assert.deepEqual(states, [{
        ts: '2026-08-31T20:00:05.000Z',
        conversation_id: conversationId,
        url: `https://chatgpt.com/c/${conversationId}`,
        spawner: 'aiva',
        task: 'detach smoke',
        model: 'gpt-thinking',
        prompt: 'Do it.',
        status: 'closed',
        note: 'completion poller',
    }]);
});
