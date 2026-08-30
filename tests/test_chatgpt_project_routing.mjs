import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveChatGptProjectTarget } from '../src/backend/adapter/chatgpt_text.js';

const config = {
    projects: {
        default: 'g-p-default123',
        byAgent: {
            dev: 'g-p-dev123',
            aiva: 'g-p-aiva123'
        }
    }
};

test('agent routing wins over the default project', () => {
    assert.deepEqual(resolveChatGptProjectTarget(config, { agent: 'Dev' }), {
        agent: 'dev',
        projectId: 'g-p-dev123',
        defaultProjectId: 'g-p-default123',
        source: 'agent',
        explicitNone: false,
        invalidProjectHint: null,
        invalidAgentMapping: null
    });
});

test('an exact project hint wins over agent routing', () => {
    const result = resolveChatGptProjectTarget(config, {
        agent: 'dev',
        project: 'g-p-explicit123'
    });
    assert.equal(result.projectId, 'g-p-explicit123');
    assert.equal(result.source, 'explicit');
});

test('none is an explicit request to remove project membership', () => {
    const result = resolveChatGptProjectTarget(config, { project: 'none' });
    assert.equal(result.projectId, null);
    assert.equal(result.explicitNone, true);
    assert.equal(result.source, 'explicit-none');
});

test('invalid hints fall back to the configured default', () => {
    const result = resolveChatGptProjectTarget(config, { project: 'Dev project' });
    assert.equal(result.projectId, 'g-p-default123');
    assert.equal(result.source, 'default');
    assert.equal(result.invalidProjectHint, 'Dev project');
});
