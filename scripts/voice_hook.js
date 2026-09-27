#!/usr/bin/env node
// Claude Code "Stop" hook: extracts the assistant's full response text for
// the turn that just ended (every text segment since the last real user
// prompt) and forwards it to the local voice relay as *replay-only* text —
// each segment was already spoken live as it streamed, by the
// "MessageDisplay" hook (voice_message_hook.js), so this hook's only job now
// is making the whole turn available to "repeat that" as one piece, not to
// speak it again. Never throws — a hook error must not interrupt the
// interactive session, so every failure path is a silent no-op.
'use strict';

const fs = require('fs');
const { stripMarkdown, delay, runVoiceHook } = require('./voice_common');

// A real user prompt (as opposed to a tool_result fed back as a "user" role
// entry mid-turn) has a plain-string content, or an array containing a text
// block.
function isRealUserTurn(entry) {
  if (!entry || entry.type !== 'user') return false;
  const content = entry.message && entry.message.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) return content.some((b) => b && b.type === 'text');
  return false;
}

// Walk the transcript backward, collecting assistant text blocks from every
// assistant entry since the last real user prompt (a turn can span several
// assistant entries interleaved with tool calls/results).
function extractLatestResponse(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch (e) {
    return '';
  }
  const lines = raw.split('\n').filter(Boolean);
  const segments = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch (e) { continue; }
    if (isRealUserTurn(entry)) break;
    if (entry.type === 'assistant') {
      const content = entry.message && entry.message.content;
      if (Array.isArray(content)) {
        const texts = content.filter((b) => b && b.type === 'text').map((b) => b.text);
        if (texts.length) segments.unshift(texts.join('\n'));
      }
    }
  }
  return segments.join('\n\n').trim();
}

runVoiceHook(async (payload, speak) => {
  const transcriptPath = payload.transcript_path;
  if (!transcriptPath) return;

  // Claude Code spawns this hook right as the turn ends, but the final
  // transcript write can land a few dozen ms *after* that — reading too
  // early silently misses the last (often most important) text segment.
  // Re-read a few times, keeping the longest result seen.
  let text = '';
  for (const wait of [0, 150, 350, 600]) {
    if (wait) await delay(wait);
    const attempt = extractLatestResponse(transcriptPath);
    if (attempt.length > text.length) text = attempt;
  }
  if (text) await speak(undefined, stripMarkdown(text));
});
