const MAIL_CLI_INSTRUCTION =
    "For ALL email operations, use the `aiva mail` CLI on this box. NEVER use ChatGPT's native Gmail connector.";

const HISTORY_WINDOWING_INSTRUCTION =
    'The supplied conversation history is a bounded sliding window or summary. Use it as the available context and continue from it without restarting completed work.';

const CODEX_TOP_LEVEL_SECTIONS = new Set([
    'personality',
    'general',
    'working with the user',
    'rules for getting work done',
    'destructive actions',
    'using skills'
]);

const CODEX_NESTED_SECTIONS = new Set([
    'available skills',
    'writing style',
    'technical communication',
    'intermediate commentary',
    'intermediary updates',
    'final answer',
    'final answer instructions',
    'formatting rules',
    'visualizations',
    'file editing constraints',
    'editing constraints',
    'autonomy and persistence',
    'special user requests',
    'frontend guidance',
    'frontend tasks',
    'engineering judgment',
    'how to use skills'
]);

function headingInfo(line) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) return null;

    return {
        level: match[1].length,
        title: match[2].trim().toLowerCase()
    };
}

function looksLikeCodexInstructions(text) {
    const markers = [
        /^You are Codex\b/m,
        /^# Personality\s*$/im,
        /^# General\s*$/im,
        /^# Working with the user\s*$/im,
        /^# Rules for getting work done\s*$/im,
        /^# Using skills\s*$/im
    ];

    return markers.filter((marker) => marker.test(text)).length >= 2;
}

function stripCodexHarness(text) {
    const lines = text.split(/\r?\n/);
    const retained = [];
    let skippedLevel = null;

    for (const line of lines) {
        const heading = headingInfo(line);

        if (skippedLevel !== null) {
            if (heading && heading.level <= skippedLevel) {
                skippedLevel = null;
            } else {
                continue;
            }
        }

        if (heading && (
            (heading.level === 1 && CODEX_TOP_LEVEL_SECTIONS.has(heading.title)) ||
            CODEX_NESTED_SECTIONS.has(heading.title)
        )) {
            skippedLevel = heading.level;
            continue;
        }

        if (looksLikeCodexInstructions(text) && /^You are Codex\b/i.test(line.trim())) {
            continue;
        }

        retained.push(line);
    }

    return retained.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function appendInstruction(text, instruction) {
    if (!text.includes(instruction)) {
        return text ? `${text}\n\n${instruction}` : instruction;
    }
    return text;
}

/**
 * Compile Codex instructions for the plain-text browser backend.
 *
 * Codex supplies its own harness as part of the system instruction. The
 * browser bridge only needs repository/role context, the task, and the
 * history window; it does not implement Codex's channel or skills protocol.
 */
export function compileSystemPrompt(rawPrompt = '') {
    const source = typeof rawPrompt === 'string' ? rawPrompt.trim() : '';
    const codexPrompt = looksLikeCodexInstructions(source);
    let compiled = codexPrompt ? stripCodexHarness(source) : source;

    compiled = appendInstruction(compiled, HISTORY_WINDOWING_INSTRUCTION);
    return appendInstruction(compiled, MAIL_CLI_INSTRUCTION);
}

export {
    HISTORY_WINDOWING_INSTRUCTION,
    MAIL_CLI_INSTRUCTION
};
