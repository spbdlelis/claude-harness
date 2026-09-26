#!/usr/bin/env node
// Tiny local relay: the Stop hook (voice_hook.js) POSTs the assistant's final
// response text to /speak; the browser page subscribes to /events (SSE) and
// speaks whatever arrives with speechSynthesis. No dependencies — built-in
// http module only.
'use strict';

const fs = require('fs');

const PORT = parseInt(process.env.HARNESS_VOICE_RELAY_PORT || '', 10);
if (!PORT) {
  console.error('[voice_relay] HARNESS_VOICE_RELAY_PORT not set, exiting');
  process.exit(1);
}

// Mirrors ttyd's own TLS state: an https:// page can't subscribe to a plain
// http:// EventSource (mixed content is blocked), so when ttyd is serving
// the terminal over TLS this must too, using the same self-signed cert.
const TLS_CERT = process.env.HARNESS_VOICE_RELAY_TLS_CERT;
const TLS_KEY = process.env.HARNESS_VOICE_RELAY_TLS_KEY;
const useTls = !!(TLS_CERT && TLS_KEY);
const transport = useTls ? require('https') : require('http');

const clients = new Set();

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

const requestHandler = (req, res) => {
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    const drop = () => clients.delete(res);
    req.on('close', drop);
    res.on('close', drop);
    return;
  }

  if (req.method === 'POST' && req.url === '/speak') {
    // Only the hook (running inside this same container) is allowed to push text.
    if (!isLoopback(req.socket.remoteAddress || '')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let text = '';
      try { text = String(JSON.parse(body).text || ''); } catch (e) { /* ignore malformed body */ }
      text = text.trim();
      if (text) {
        const payload = 'data: ' + JSON.stringify({ text }) + '\n\n';
        for (const client of clients) {
          if (client.destroyed || client.writableEnded) { clients.delete(client); continue; }
          try { client.write(payload); } catch (e) { clients.delete(client); }
        }
      }
      res.writeHead(204).end();
    });
    return;
  }

  res.writeHead(404).end('not found');
};

const server = useTls
  ? transport.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, requestHandler)
  : transport.createServer(requestHandler);

// Periodic heartbeat: SSE comment lines are ignored by EventSource but force
// a real write to each socket, so a connection that died without a clean
// close event gets pruned quickly instead of silently "succeeding" into a
// black hole on the next real broadcast.
setInterval(() => {
  for (const client of clients) {
    if (client.destroyed || client.writableEnded) { clients.delete(client); continue; }
    try { client.write(': heartbeat\n\n'); } catch (e) { clients.delete(client); }
  }
}, 3000).unref();

server.listen(PORT, () => {
  console.log('[voice_relay] listening on', PORT, useTls ? '(https)' : '(http)');
});
