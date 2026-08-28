import assert from 'node:assert/strict';
import test from 'node:test';
import {
    compileSystemPrompt,
    HISTORY_WINDOWING_INSTRUCTION,
    MAIL_CLI_INSTRUCTION
} from '../src/server/api/openai/prompt.js';

test('trims Codex harness sections while preserving repository context', () => {
    const prompt = [
        'You are Codex, a coding agent.',
        '',
        '# Personality',
        'Discard this presentation guidance.',
        '',
        '# Working with the user',
        'Discard commentary and final-channel behavior.',
        '',
        '# Rules for getting work done',
        'Discard the Codex harness rules.',
        '',
        '# Destructive Actions',
        'Discard the harness-only safety section.',
        '',
        '# Using skills',
        'Discard the skills discovery catalog.',
        '',
        '# AGENTS.md context',
        'Keep this repository instruction.',
        '## Deployment notes',
        'Keep this nested repository context.'
    ].join('\n');

    const compiled = compileSystemPrompt(prompt);

    assert.doesNotMatch(compiled, /You are Codex/);
    assert.doesNotMatch(compiled, /Discard this presentation guidance/);
    assert.doesNotMatch(compiled, /Discard commentary/);
    assert.doesNotMatch(compiled, /Discard the Codex harness rules/);
    assert.doesNotMatch(compiled, /Discard the harness-only safety section/);
    assert.doesNotMatch(compiled, /Discard the skills discovery catalog/);
    assert.match(compiled, /# AGENTS\.md context/);
    assert.match(compiled, /Keep this repository instruction/);
    assert.match(compiled, /Keep this nested repository context/);
    assert.match(compiled, new RegExp(HISTORY_WINDOWING_INSTRUCTION));
    assert.match(compiled, new RegExp(MAIL_CLI_INSTRUCTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('does not strip an unrelated system prompt', () => {
    const prompt = '# Repository context\nKeep this role-specific instruction.';
    const compiled = compileSystemPrompt(prompt);

    assert.match(compiled, /# Repository context/);
    assert.match(compiled, /Keep this role-specific instruction/);
    assert.match(compiled, new RegExp(HISTORY_WINDOWING_INSTRUCTION));
    assert.equal(compiled.split(MAIL_CLI_INSTRUCTION).length - 1, 1);
});

test('does not duplicate the standing mail rule', () => {
    const compiled = compileSystemPrompt(`${MAIL_CLI_INSTRUCTION}\n\nTask context`);

    assert.equal(compiled.split(MAIL_CLI_INSTRUCTION).length - 1, 1);
    assert.match(compiled, /Task context/);
});
