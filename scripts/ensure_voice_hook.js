#!/usr/bin/env node
// Idempotently registers the voice-relay Stop hook in the persisted Claude
// Code settings.json (the claude_config volume) without touching anything
// else the user may have configured there. Safe to run on every container
// start.
'use strict';

const fs = require('fs');
const path = require('path');

const HOOK_COMMAND = 'node /opt/harness/voice_hook.js';
// gosu doesn't reset $HOME when dropping privileges, so this can't rely on
// process.env.HOME — the caller passes the real settings.json path explicitly.
const settingsPath = process.argv[2] || path.join('/home/claude', '.claude', 'settings.json');

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch (e) {
  settings = {};
}

if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];

const alreadyRegistered = settings.hooks.Stop.some(
  (group) => Array.isArray(group && group.hooks) && group.hooks.some((h) => h && h.command === HOOK_COMMAND)
);

if (!alreadyRegistered) {
  settings.hooks.Stop.push({
    matcher: '',
    hooks: [{ type: 'command', command: HOOK_COMMAND }],
  });
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log('[harness] Registered voice-relay Stop hook in', settingsPath);
}
