import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareNewChatPrompt } from '../src/server/chatgptSubmit.js';

for (const failurePoint of ['focus', 'fill']) {
    test(`reacquires the new-chat composer after a detached ${failurePoint}`, async () => {
        let lookups = 0, fills = 0;
        const prepare = async () => {
            lookups++;
            if (lookups === 1 && failurePoint === 'focus') throw new Error('textarea detached from the DOM');
            return { fill: async () => {
                fills++;
                if (lookups === 1 && failurePoint === 'fill') throw new Error('Element is not attached to the DOM');
            } };
        };
        const result = await prepareNewChatPrompt(prepare, 'synthetic prompt', async () => 'synthetic prompt');
        assert.equal(result.exact, true);
        assert.equal(lookups, 2);
        assert.equal(fills, failurePoint === 'fill' ? 2 : 1);
    });
}

test('non-detachment and repeated detachment fail closed', async () => {
    for (const message of ['permission denied', 'element detached']) {
        let lookups = 0;
        await assert.rejects(prepareNewChatPrompt(async () => { lookups++; throw new Error(message); }, 'x', async () => 'x'));
        assert.equal(lookups, message.includes('detached') ? 2 : 1);
    }
});

test('a text mismatch is not retried', async () => {
    let lookups = 0;
    const result = await prepareNewChatPrompt(async () => { lookups++; return { fill: async () => {} }; }, 'expected', async () => 'different');
    assert.equal(result.exact, false);
    assert.equal(lookups, 1);
});

test('reacquires when a detached composer yields an empty verification read', async () => {
    let lookups = 0;
    const result = await prepareNewChatPrompt(async () => {
        lookups++;
        const current = lookups;
        return { fill: async () => {}, isVisible: async () => current !== 1, current };
    }, 'x', async composer => composer.current === 1 ? '' : 'x');
    assert.equal(result.exact, true);
    assert.equal(lookups, 2);
});
