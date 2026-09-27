#!/usr/bin/env node
// Idempotently registers the voice-relay hooks (MessageDisplay, Stop,
// PreToolUse, PermissionRequest) in the persisted Claude Code settings.json
// (the claude_config volume) without touching anything else the user may
// have configured there. Safe to run on every container start.
'use strict';

const fs = require('fs');
const path = require('path');

// gosu doesn't reset $HOME when dropping privileges, so this can't rely on
// process.env.HOME — the caller passes the real settings.json path explicitly.
const settingsPath = process.argv[2] || path.join('/home/claude', '.claude', 'settings.json');

// Each entry mirrors one hook registration this feature needs:
// - MessageDisplay: speaks each assistant text segment as it streams, so a
//   multi-step turn is heard step-by-step (voice_message_hook.js).
// - Stop: makes the whole turn's text available to "repeat that" — it no
//   longer speaks anything live, since MessageDisplay already did (voice_hook.js).
// - PreToolUse (matched to AskUserQuestion/ExitPlanMode only): speaks a
//   summary of the question/plan being presented, since that content lives
//   in tool_input, not assistant text, so neither of the above ever sees it.
// - PermissionRequest: speaks a summary of what's about to be requested,
//   since a pending permission dialog pauses the turn before Stop fires.
const HOOKS = [
  { event: 'MessageDisplay', matcher: '', command: 'node /opt/harness/voice_message_hook.js' },
  { event: 'Stop', matcher: '', command: 'node /opt/harness/voice_hook.js' },
  { event: 'PreToolUse', matcher: 'AskUserQuestion|ExitPlanMode', command: 'node /opt/harness/voice_pretool_hook.js' },
  { event: 'PermissionRequest', matcher: '', command: 'node /opt/harness/voice_permission_hook.js' },
];

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch (e) {
  settings = {};
}

if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};

let changed = false;
for (const { event, matcher, command } of HOOKS) {
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];

  const alreadyRegistered = settings.hooks[event].some(
    (group) => Array.isArray(group && group.hooks) && group.hooks.some((h) => h && h.command === command)
  );

  if (!alreadyRegistered) {
    settings.hooks[event].push({ matcher, hooks: [{ type: 'command', command }] });
    changed = true;
    console.log('[harness] Registered', event, 'voice hook in', settingsPath);
  }
}

if (changed) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}
