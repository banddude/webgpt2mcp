import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { confirmNewUserTurnFromCloud } from '../src/server/chatgptNewTurnConfirmation.js';

const id = '12345678-1234-1234-1234-1234567890ab';
const prompt = 'exact\nmessage';
const user = text => ({ message: { author: { role: 'user' }, content: { parts: [text] } } });

for (const [name, data, expected] of [
    ['matching exact turn', { id, mapping: { one: user(prompt) } }, true],
    ['different conversation', { id: 'wrong', mapping: { one: user(prompt) } }, false],
    ['different text', { id, mapping: { one: user('different') } }, false],
    ['duplicate user turns', { id, mapping: { one: user(prompt), two: user(prompt) } }, false],
    ['missing mapping', { id }, false],
]) {
    test(`cloud snapshot confirms only ${name}`, async () => {
        const calls = [];
        const page = { evaluate: (callback, input) => vm.runInNewContext(`(${callback})(input)`, {
            input, AbortSignal,
            fetch: async url => {
                calls.push(url);
                return { ok: true, json: async () => url === '/api/auth/session' ? {} : data };
            },
        }) };
        assert.equal(await confirmNewUserTurnFromCloud(page, id, prompt), expected);
        assert.deepEqual(calls, ['/api/auth/session', `https://chatgpt.com/backend-api/conversation/${id}`]);
    });
}

test('unavailable snapshot stays unconfirmed without retries', async () => {
    let calls = 0;
    const page = { evaluate: (callback, input) => vm.runInNewContext(`(${callback})(input)`, {
        input, AbortSignal, fetch: async () => { calls++; throw new Error('offline'); },
    }) };
    assert.equal(await confirmNewUserTurnFromCloud(page, id, prompt), false);
    assert.equal(calls, 1);
});
