#!/usr/bin/env node
// Claude Code "Stop" hook: extracts the assistant's final response text for
// the turn that just ended and forwards it to the local voice relay, which
// the browser page speaks via speechSynthesis. Never throws — a hook error
// must not interrupt the interactive session, so every failure path is a
// silent no-op.
'use strict';

const fs = require('fs');

// Mirrors voice_relay.js's own TLS switch: with --tls, the relay listens
// over HTTPS, so a plain http.request() here just times out silently
// against the TLS handshake it doesn't speak (self-signed, so also needs
// rejectUnauthorized: false — this is a loopback-only connection).
const useTls = !!(process.env.HARNESS_VOICE_RELAY_TLS_CERT && process.env.HARNESS_VOICE_RELAY_TLS_KEY);
const transport = useTls ? require('https') : require('http');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 2000).unref();
  });
}

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

function postOnce(port, body) {
  return new Promise((resolve) => {
    const req = transport.request(
      {
        host: '127.0.0.1',
        port,
        path: '/speak',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 2000,
        rejectUnauthorized: false,
      },
      (res) => { res.resume(); resolve(true); }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The relay can be momentarily unreachable right after a restart (the
// browser's EventSource takes a couple seconds to reconnect too) — retry a
// few times rather than silently dropping the one message that lands in
// that gap.
async function post(port, text) {
  const body = JSON.stringify({ text });
  const delays = [300, 800, 1500];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (await postOnce(port, body)) return;
    if (attempt < delays.length) await delay(delays[attempt]);
  }
}

(async () => {
  try {
    const port = parseInt(process.env.HARNESS_VOICE_RELAY_PORT || '', 10);
    if (!port) return; // not running in --web mode, nothing to relay to

    const raw = await readStdin();
    const payload = JSON.parse(raw || '{}');
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
    if (text) await post(port, text);
  } catch (e) {
    // swallow — a hook must never break the session
  }
})();
