#!/usr/bin/env node
// Shared helpers for the voice hooks (voice_hook.js, voice_pretool_hook.js,
// voice_permission_hook.js): reading a hook's JSON payload from stdin,
// stripping Markdown for TTS, and posting text to the local voice relay.
'use strict';

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

// Strips common Markdown syntax so TTS reads prose instead of literal
// asterisks/backticks/hashes. Not a full parser — just the constructs
// Claude's responses actually use.
function stripMarkdown(text) {
  return text
    .replace(/```[^\n]*\n?/g, '') // code fence markers (keep the code content)
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/^#{1,6}\s+/gm, '') // headers
    .replace(/^\s*>\s?/gm, '') // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '') // bullet list markers
    .replace(/^\s*\d+\.\s+/gm, '') // numbered list markers
    .replace(/^\s*-{3,}\s*$/gm, '') // horizontal rules
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links
    .replace(/(\*\*\*|___)(.*?)\1/g, '$2') // bold+italic
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
    .replace(/(\*|_)(.*?)\1/g, '$2') // italic
    .replace(/~~(.*?)~~/g, '$1'); // strikethrough
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// The relay can be momentarily unreachable right after a restart (the
// browser's EventSource takes a couple seconds to reconnect too) — retry a
// few times rather than silently dropping the one message that lands in
// that gap. `replayText`, when given, is what "repeat that" re-speaks later
// (see voice_relay.js) — distinct from `text`, which is spoken right now.
// Passing only `replayText` (no `text`) updates what "repeat that" replays
// without speaking anything live — used by the Stop hook, whose job is now
// just to make the *whole* turn replayable, since each piece of it was
// already spoken as it streamed (see voice_message_hook.js).
async function postToRelay(port, text, replayText) {
  const body = {};
  if (text) body.text = text;
  if (replayText) body.replayText = replayText;
  if (!body.text && !body.replayText) return; // nothing to send
  const json = JSON.stringify(body);
  const delays = [300, 800, 1500];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (await postOnce(port, json)) return;
    if (attempt < delays.length) await delay(delays[attempt]);
  }
}

// Every voice hook is invoked the same way: only runs in --web mode (port
// env var set), reads a JSON payload off stdin, and must never throw or
// print anything — a hook error/stdout must not interrupt or redirect the
// interactive session.
function runVoiceHook(handler) {
  (async () => {
    try {
      const port = parseInt(process.env.HARNESS_VOICE_RELAY_PORT || '', 10);
      if (!port) return; // not running in --web mode, nothing to relay to
      const raw = await readStdin();
      const payload = JSON.parse(raw || '{}');
      await handler(payload, (text, replayText) => postToRelay(port, text, replayText));
    } catch (e) {
      // swallow — a hook must never break the session
    }
  })();
}

module.exports = { readStdin, stripMarkdown, delay, postToRelay, runVoiceHook };
