#!/usr/bin/env node
// Claude Code "MessageDisplay" hook: speaks each assistant text segment as
// soon as it finishes streaming, instead of waiting for the whole turn to
// end. A turn that spans several tool calls produces one distinct message
// (and message_id) per stretch of narration between them, so this is what
// makes a multi-step turn heard step-by-step rather than as one long block
// read all at once at the end (that used to be the Stop hook's job — see
// voice_hook.js, whose job now is just to make the *whole* turn replayable
// via "repeat that", not to speak it again).
//
// This hook fires once per "flush" of a message (verified empirically: a
// short, single-shot message arrives as one flush with index 0 and final
// true, carrying the whole text as `delta`; the documented shape for a
// longer, actually-streamed message is several non-final flushes first,
// each `delta` being only the newly-completed lines since the last flush).
// Since hook invocations are separate, stateless processes, deltas for the
// same message_id are accumulated in a small per-message scratch file until
// the final flush arrives, at which point the full text is spoken and the
// scratch file is removed. A message whose final flush never arrives (e.g.
// an aborted turn) leaves a harmless leftover file in the OS temp dir.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stripMarkdown, runVoiceHook } = require('./voice_common');

function accumulatorPath(messageId) {
  return path.join(os.tmpdir(), `voice-msg-${messageId}.txt`);
}

runVoiceHook(async (payload, speak) => {
  const messageId = payload.message_id;
  if (!messageId) return;

  const file = accumulatorPath(messageId);
  const delta = typeof payload.delta === 'string' ? payload.delta : '';
  if (delta) fs.appendFileSync(file, delta);

  if (!payload.final) return;

  let full = '';
  try { full = fs.readFileSync(file, 'utf8'); } catch (e) { /* no deltas ever arrived */ }
  try { fs.unlinkSync(file); } catch (e) { /* already gone */ }

  const text = stripMarkdown(full).trim();
  if (text) await speak(text);
});
