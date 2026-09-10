import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, mock } from 'node:test';

// Session/HTTP fixtures must never send notifications or start real processes.
// A temporary cwd also confines any accidentally omitted dataDir to test data.
export function isolateSessionTests() {
    const originalCwd = process.cwd();
    const attempts = [];
    const stubs = [];
    let directory;
    before(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'webgpt-isolated-session-'));
        process.chdir(directory);
        for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
            stubs.push(mock.method(childProcess, method, () => {
                attempts.push(method);
                throw new Error(`Session test attempted a real child process: ${method}`);
            }));
        }
        syncBuiltinESMExports();
    });
    after(async () => {
        try {
            assert.deepEqual(attempts, [], 'session fixtures must supply fake notifiers and never launch processes');
        } finally {
            for (const stub of stubs) stub.mock.restore();
            syncBuiltinESMExports();
            process.chdir(originalCwd);
            if (directory) await fs.rm(directory, { recursive: true, force: true });
        }
    });
    return { dataRoot: () => {
        assert.ok(directory, 'test isolation must be initialized before creating session data');
        return directory;
    } };
}
