import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    cleanupStaleFirefoxProfileLock,
    parseFirefoxProfileLockPid
} from '../src/backend/engine/profile-lock.js';

function withTempProfile(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webgpt-profile-lock-'));
    try {
        return fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('parses Firefox lock targets with trailing +pid', () => {
    assert.equal(parseFirefoxProfileLockPid('100.64.0.1:+12345'), 12345);
    assert.equal(parseFirefoxProfileLockPid('host:+7'), 7);
    assert.equal(parseFirefoxProfileLockPid('host:12345'), null);
    assert.equal(parseFirefoxProfileLockPid('host:+not-a-pid'), null);
});

test('removes a stale lock and its parentlock only when owner pid is dead', () => {
    withTempProfile((dir) => {
        fs.symlinkSync('100.64.0.1:+424242', path.join(dir, 'lock'));
        fs.writeFileSync(path.join(dir, '.parentlock'), '');
        const result = cleanupStaleFirefoxProfileLock(dir, {
            isPidAlive: (pid) => {
                assert.equal(pid, 424242);
                return false;
            }
        });
        assert.equal(result.removed, true);
        assert.equal(result.removedParentLock, true);
        assert.equal(fs.existsSync(path.join(dir, 'lock')), false);
        assert.equal(fs.existsSync(path.join(dir, '.parentlock')), false);
    });
});

test('preserves an active lock and parentlock', () => {
    withTempProfile((dir) => {
        fs.symlinkSync('100.64.0.1:+123', path.join(dir, 'lock'));
        fs.writeFileSync(path.join(dir, '.parentlock'), '');
        const result = cleanupStaleFirefoxProfileLock(dir, { isPidAlive: () => true });
        assert.equal(result.removed, false);
        assert.equal(result.reason, 'owner-alive');
        assert.equal(fs.readlinkSync(path.join(dir, 'lock')), '100.64.0.1:+123');
        assert.equal(fs.existsSync(path.join(dir, '.parentlock')), true);
    });
});

test('does not delete malformed or non-symlink locks', () => {
    withTempProfile((dir) => {
        const lock = path.join(dir, 'lock');
        fs.symlinkSync('unexpected-target', lock);
        let result = cleanupStaleFirefoxProfileLock(dir, { isPidAlive: () => false });
        assert.equal(result.removed, false);
        assert.equal(result.reason, 'unrecognized-lock-target');
        assert.equal(fs.existsSync(lock), true);

        fs.unlinkSync(lock);
        fs.writeFileSync(lock, 'not-a-firefox-symlink');
        result = cleanupStaleFirefoxProfileLock(dir, { isPidAlive: () => false });
        assert.equal(result.removed, false);
        assert.equal(result.reason, 'lock-not-symlink');
        assert.equal(fs.existsSync(lock), true);
    });
});
