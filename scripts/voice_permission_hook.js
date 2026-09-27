#!/usr/bin/env node
// Claude Code "PermissionRequest" hook: speaks a short, tool-specific summary
// of what Claude wants to do right as a permission dialog is about to be
// shown, since that moment previously produced no audio at all — the Stop
// hook only fires once the whole turn finishes, well after (or instead of)
// the pause for approval. Approval itself always still happens the normal
// way (keyboard/mouse); this only announces what's being asked, it never
// grants or denies anything.
//
// ExitPlanMode and AskUserQuestion are skipped here — they're summarized by
// voice_pretool_hook.js (PreToolUse) instead, so this avoids announcing them
// twice.
'use strict';

const { runVoiceHook } = require('./voice_common');

const MAX_DETAIL_LEN = 150;

function truncate(text) {
  const collapsed = String(text || '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_DETAIL_LEN) return collapsed;
  return collapsed.slice(0, MAX_DETAIL_LEN) + '...';
}

// Per-tool phrasing: pull out whichever field actually says what's about to
// happen, rather than reading the tool name back verbatim.
function summarize(toolName, toolInput) {
  const input = toolInput || {};
  switch (toolName) {
    case 'Bash':
      return `Claude wants permission to run: ${truncate(input.command)}`;
    case 'Write':
      return `Claude wants permission to write to ${input.file_path || 'a file'}`;
    case 'Edit':
      return `Claude wants permission to edit ${input.file_path || 'a file'}`;
    case 'NotebookEdit':
      return `Claude wants permission to edit notebook ${input.notebook_path || 'a file'}`;
    case 'Read':
      return `Claude wants permission to read ${input.file_path || 'a file'}`;
    case 'WebFetch':
      return `Claude wants permission to fetch ${input.url || 'a URL'}`;
    case 'WebSearch':
      return `Claude wants permission to search the web for ${truncate(input.query)}`;
    case 'Glob':
      return `Claude wants permission to search files matching ${truncate(input.pattern)}`;
    case 'Grep':
      return `Claude wants permission to search file contents for ${truncate(input.pattern)}`;
    default:
      return `Claude wants permission to use the ${toolName} tool`;
  }
}

runVoiceHook(async (payload, speak) => {
  const toolName = payload.tool_name;
  if (!toolName || toolName === 'ExitPlanMode' || toolName === 'AskUserQuestion') return;
  await speak(summarize(toolName, payload.tool_input));
});
