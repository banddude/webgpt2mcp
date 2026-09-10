import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import yaml from 'yaml';

test('retiring model settings preserves browser instances, proxies and auth during an ordinary settings save', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'website-config-test-'));
    const config = {
        logLevel: 'info', server: { port: 3000, auth: 'fake-private-token', keepalive: { mode: 'comment' } },
        browser: { path: '/fake/browser', headless: true, proxy: { enable: true, host: '127.0.0.1', port: 8888 } },
        backend: { pool: { instances: [{ name: 'fake-instance', userDataMark: 'keep-session', workers: [{ name: 'fake-worker', type: 'chatgpt_text' }] }],
            strategy: 'least_busy', failover: { enabled: true }, waitTimeout: 120000 } },
        queue: { queueBuffer: 2, imageLimit: 5 },
    };
    try {
        await fs.mkdir(path.join(tmp, 'data'));
        await fs.writeFile(path.join(tmp, 'data/config.yaml'), yaml.stringify(config));
        const manager = new URL('../src/config/manager.js', import.meta.url).href;
        const loader = new URL('../src/config/index.js', import.meta.url).href;
        const script = `import assert from 'node:assert/strict';
            import { getServerConfig, saveServerConfig } from ${JSON.stringify(manager)};
            import { loadConfig } from ${JSON.stringify(loader)};
            const controls = getServerConfig();
            assert.deepEqual(Object.keys(controls).sort(), ['authToken','logLevel','port']);
            assert.equal(controls.authToken, 'fake-private-token');
            const loaded = loadConfig();
            assert.equal(loaded.backend.pool.instances[0].name, 'fake-instance');
            saveServerConfig({ logLevel: 'warn' });`;
        execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: tmp, stdio: 'pipe' });
        const saved = yaml.parse(await fs.readFile(path.join(tmp, 'data/config.yaml'), 'utf8'));
        assert.deepEqual(saved, { ...config, logLevel: 'warn' });
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});
