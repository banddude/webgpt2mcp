import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { confirmNewUserTurnFromCloud, confirmNewUserTurnWithRetry } from '../src/server/chatgptNewTurnConfirmation.js';

const id = '12345678-1234-1234-1234-1234567890ab';
const prompt = 'exact\nmessage';
const user = text => ({ message: { author: { role: 'user' }, content: { parts: [text] } } });

for (const [name, data, expected] of [
    ['matching exact turn', { id, mapping: { one: user(prompt) } }, 'confirmed'],
    ['real snapshot shape with conversation_id and no id', { conversation_id: id, mapping: { one: user(prompt) } }, 'confirmed'],
    ['wrong conversation_id without id', { conversation_id: 'wrong', mapping: { one: user(prompt) } }, 'schema_mismatch'],
    ['wrong id even with matching conversation_id', { id: 'wrong', conversation_id: id, mapping: { one: user(prompt) } }, 'schema_mismatch'],
    ['matching id with conflicting conversation_id', { id, conversation_id: 'wrong', mapping: { one: user(prompt) } }, 'schema_mismatch'],
    ['conversation_id with different user turn', { conversation_id: id, mapping: { one: user('different') } }, 'turn_not_found'],
    ['different conversation', { id: 'wrong', mapping: { one: user(prompt) } }, 'schema_mismatch'],
    ['different text', { id, mapping: { one: user('different') } }, 'turn_not_found'],
    ['no user turn', { id, mapping: {} }, 'turn_not_found'],
    ['duplicate user turns', { id, mapping: { one: user(prompt), two: user(prompt) } }, 'schema_mismatch'],
    ['missing mapping', { id }, 'schema_mismatch'],
]) {
    test(`classifies ${name}`, async () => {
        const calls = [];
        const page = { evaluate: (callback, input) => vm.runInNewContext(`(${callback})(input)`, {
            input, AbortSignal,
            fetch: async url => {
                calls.push(url);
                return { ok: true, json: async () => url === '/api/auth/session' ? {} : data };
            },
        }) };
        assert.deepEqual(await confirmNewUserTurnFromCloud(page, id, prompt), { reason: expected, status: null });
        assert.deepEqual(calls, ['/api/auth/session', `https://chatgpt.com/backend-api/conversation/${id}`]);
    });
}

test('classifies HTTP status and timeout without exposing errors or content', async () => {
    for (const [response, expected] of [
        [{ ok: false, status: 429 }, { reason: 'http_status', status: 429 }],
        [new DOMException('private details', 'TimeoutError'), { reason: 'timeout', status: null }],
        [new Error('private details'), { reason: 'read_error', status: null }],
    ]) {
        let calls = 0;
        const page = { evaluate: (callback, input) => vm.runInNewContext(`(${callback})(input)`, {
            input, AbortSignal, fetch: async () => { calls++; if (response instanceof Error) throw response; return response; },
        }) };
        assert.deepEqual(await confirmNewUserTurnFromCloud(page, id, prompt), expected);
        assert.equal(calls, 1);
    }
});

test('retries delayed read-only persistence and logs only the failure reason', async () => {
    const results = ['turn_not_found', 'http_status', 'confirmed'];
    const calls = [], delays = [], logs = [];
    const page = { evaluate: async () => {
        calls.push('read');
        const reason = results.shift();
        return JSON.stringify({ reason, status: reason === 'http_status' ? 404 : null });
    } };
    assert.equal(await confirmNewUserTurnWithRetry(page, id, prompt, {
        sleep: async delay => delays.push(delay), log: (reason, status) => logs.push([reason, status]),
    }), true);
    assert.equal(calls.length, 3);
    assert.deepEqual(delays, [2000, 4000]);
    assert.deepEqual(logs, [['turn_not_found', null], ['http_status', 404]]);
});

for (const reason of ['http_status', 'schema_mismatch', 'timeout', 'turn_not_found', 'read_error']) {
    test(`logs bounded ${reason} failures and remains unconfirmed`, async () => {
        const delays = [], logs = [];
        const page = { evaluate: async () => JSON.stringify({ reason, status: reason === 'http_status' ? 503 : null }) };
        assert.equal(await confirmNewUserTurnWithRetry(page, id, prompt, {
            sleep: async delay => delays.push(delay), log: (r, status) => logs.push([r, status]),
        }), false);
        assert.deepEqual(delays, [2000, 4000, 8000]);
        assert.equal(logs.length, 4);
        assert.ok(logs.every(([r, status]) => r === reason && status === (reason === 'http_status' ? 503 : null)));
    });
}
