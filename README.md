# claude-harness

A secure sandbox for running Claude Code with full tool permissions inside a Docker container. Claude can freely read, write, and execute inside the container while outbound internet access is enforced by an allowlist — by hostname and HTTP verb.

## How it works

```
┌──────────────────────────────────────────────────────────────────┐
│ Host machine                                                     │
│                                                                  │
│  ┌─────────────────────────┐      ┌──────────────────────────┐  │
│  │  claude  (internal net) │─────▶│  proxy  (internal+ext)   │──┼──▶ internet
│  │                         │      │                           │  │
│  │  Claude Code            │      │  mitmproxy               │  │
│  │  user: claude (uid 1000)│      │  enforces allowlist.yaml  │  │
│  │  sudo: yes (inside only)│      │  intercepts HTTPS         │  │
│  └─────────────────────────┘      └──────────────────────────┘  │
│           │ internal network only          ▲                     │
│           │ no internet gateway            │ allowlist check     │
│           └────────────────────────────────┘                     │
└──────────────────────────────────────────────────────────────────┘
```

Two containers, two networks:

- The **proxy** container runs mitmproxy, sits on both the `internal` and `external` networks, and is the sole internet gateway.
- The **claude** container sits on the `internal` network only. There is no route to the internet from it — Docker enforces this at the kernel level with `internal: true`.
- All outbound HTTP/HTTPS traffic from Claude Code is routed through the proxy via `http_proxy`/`https_proxy` environment variables. The proxy intercepts HTTPS using a self-signed CA it generates at startup.
- Every request is checked against `config/allowlist.yaml` by hostname and HTTP verb. Requests that don't match get a `403`.

## Security features

### Network isolation
The `claude` container's Docker network has `internal: true`, which adds iptables rules that block all outbound routing — not just for processes that respect proxy env vars, but for any raw socket connection. The AI cannot reach the internet directly even if it unsets env vars, kills the proxy client, or uses raw sockets.

### Allowlist enforcement
mitmproxy intercepts all HTTP and HTTPS traffic (via SSL bump with a local CA). A Python addon checks every request against `config/allowlist.yaml`:
- Requests to unlisted hosts → `403 Blocked`
- Requests with unlisted HTTP verbs on a listed host → `403 Blocked`

This lets you express rules like "GitHub is read-only" (`methods: [GET]`) or "npm registry read-only" separately from "Anthropic API read-write" (`methods: [GET, POST]`).

### Isolated proxy config
The proxy container's filesystem is completely unreachable from the `claude` container. The allowlist is mounted read-only inside the proxy container, so the AI cannot modify its own network rules.

### Non-root execution
Claude Code runs as a non-root user (`claude`, uid 1000) inside the container, satisfying Claude Code's own requirement that `--dangerously-skip-permissions` not be used as root. The entrypoint runs as root only long enough to install the CA certificate, then uses `gosu` to drop to the `claude` user before starting Claude Code. The `claude` user has passwordless `sudo` for system-level tasks inside the container (e.g. `apt-get install`), which is safe given the network isolation is enforced at a layer the user cannot reach.

### CA certificate plumbing
The proxy generates a CA certificate on first startup and stores it in the `harness_certs` Docker volume. The claude container mounts this volume read-only and installs the cert into the system trust store and sets `NODE_EXTRA_CA_CERTS`, `CURL_CA_BUNDLE`, and `GIT_SSL_CAINFO` so that Node.js, curl, and git all trust the proxy's intercepted HTTPS connections.

### Session persistence
Claude Code's session token and configuration are stored in the `claude_config` Docker volume mounted at `/home/claude`. Login is required only once; subsequent runs reuse the persisted session.

### Headless Chromium (browser-driven testing)
`puppeteer-core` and `@sparticuz/chromium` are baked into the image at build time, along with the shared libs (`libnspr4`, `libnss3`) the bundled Chromium binary needs — no download at container runtime, so it works out of the box regardless of the allowlist. They're installed to a fixed location with `NODE_PATH` set, so any script anywhere in the container can use them without a local `npm install`:

```js
const chromium = require('@sparticuz/chromium').default;
const puppeteer = require('puppeteer-core');

const browser = await puppeteer.launch({
  args: chromium.args,
  executablePath: await chromium.executablePath(),
  headless: true,
});
```

`playwright install` and `npm install puppeteer` (its default install path) both fetch browsers from CDNs that aren't on the allowlist — use the packages above instead.

---

## Setup

**Requirements:** Docker, Docker Compose

```bash
git clone <repo>
cd claude-harness
cp .env.example .env
mkdir -p workspace
docker compose build
```

No API key is required if you use a Claude Pro subscription (the default). Add `ANTHROPIC_API_KEY` to `.env` if you prefer API key auth.

---

## Usage

### Standard session (local terminal)

```bash
claude-harness [directory]
```

`directory` is bind-mounted at the same absolute path inside the container as on the host, and set as Claude Code's working directory. Defaults to the current directory.

Mounting at the real host path (rather than a fixed `/workspace`) keeps Claude Code's per-project memory — which is keyed off the absolute working directory — scoped correctly: each project gets its own memory instead of every project run through this harness sharing one bucket. The trade-off is that the host username and directory names above the project become visible inside the container (e.g. as `pwd`, in stack traces, in anything Claude writes). Direct `docker compose up`/`run` without `run.sh` (i.e. without `WORKSPACE_DIR`/`WORKSPACE_MOUNT` set) falls back to the old fixed `/workspace` mount.

```bash
claude-harness .                    # current directory
claude-harness ~/projects/my-app    # specific project
claude-harness ../other-project     # relative paths work
```

### Web terminal (browser-accessible)

```bash
claude-harness --web [port] [--tls] [directory]
```

Starts a browser-accessible terminal via ttyd. Open `http://localhost:<port>` (or `http://<machine-ip>:<port>` from another device on the same network) to interact with Claude Code.

```bash
claude-harness --web .              # default port 7681
claude-harness --web 9000 .         # custom port
claude-harness --web --tls .        # self-signed HTTPS (needed for voice input from anything but localhost)
```

#### Voice input

The web terminal has a mic button (top-right) that uses the browser's built-in Web Speech API to transcribe speech. The status/preview bubble it shows appears just below the button, not over the terminal's prompt line.

Two modes (toggle checkbox next to the mic):
- **Auto (default)** — say the wake phrase **"hey claude"**, then your command, then **"send it"**. The command is inserted and submitted automatically (Enter included) — nothing is spoken to the terminal until the stop phrase is heard, so ambient conversation before the wake word is ignored. Say **"scratch that"** at any point while capturing to clear what's been captured so far without leaving capture mode — useful if you misspoke partway through. Edit `WAKE_WORD`/`STOP_WORD`/`DISCARD_WORD` near the top of the `harness-voice-script` block in `web/voice-index.html` to change the phrases (that block is the hand-written harness code; the rest of the file is ttyd's vendored client bundle).
- **Manual** — every recognized phrase is inserted as pasted text without pressing Enter, so you review/edit before running it yourself.

Say **"repeat that"** (or "say that again"/"say it again"/"repeat it"/"what did you say") at any time, in either mode, to have the last response read aloud again — useful if you missed part of it. This is a reserved control phrase like the wake word: it's matched before dictation is processed and never reaches the terminal or Claude, so it can't accidentally submit a prompt. It works by asking the local relay to re-broadcast the last response text it holds (see "Reading responses aloud" below), so it needs "speak responses" enabled and the relay reachable; if nothing has been spoken yet it just says so. Edit `REPLAY_SYNONYMS` in the same script block to change the phrases.

**Spoken punctuation** (both modes) — since the Web Speech API doesn't insert punctuation on its own, say the word for it: "comma", "period" (or "full stop"), "question mark", "exclamation mark"/"point", "colon", "semicolon", "hyphen"/"dash", "open/close paren(thesis)", or "new line". These are substituted into real punctuation (with spacing cleaned up) right before the command is inserted. Edit `PUNCTUATION_RULES` in the same script block to add more.

- **Browser support**: Chrome/Edge (Web Speech API isn't supported in Firefox, and only partially in Safari).
- **Audio goes to Google's servers**, not through this container's network sandbox — recognition happens in your browser, which talks directly to Google, bypassing the proxy/allowlist entirely (nothing to configure, but worth knowing if audio privacy matters to you).
- **Secure-context requirement**: browsers only grant microphone access on `https://` or the literal loopback names `localhost`/`127.0.0.1` — not even a `.local` mDNS hostname resolving to the same machine qualifies. Voice input works out of the box over `http://localhost:<port>`; for `http://<machine-ip-or-hostname>:<port>` from another device (or from this machine under a non-`localhost` name), start with `--tls` instead:

  ```bash
  claude-harness --web --tls .
  ```

  This generates a self-signed cert on first run (persisted in the `claude_config` volume, so it's stable across restarts) and serves both the terminal and the voice relay over HTTPS. Browsers show a one-time "connection is not private" warning per device since the cert isn't from a trusted CA — click through it (Chrome: Advanced → Proceed) and the page then loads as a genuine secure context.

#### Reading responses aloud

The "🔊 speak responses" checkbox (on by default) reads Claude's replies back through your speakers, using the browser's built-in text-to-speech.

How it works: a Claude Code `Stop` hook (registered automatically into the persisted `settings.json` on container start) extracts just the assistant's final response text — not tool calls, code, or diffs — strips common Markdown syntax (bold/italic, inline code, headers, links, list markers, etc.) so it reads as plain prose instead of literal symbols, and posts it to a small local relay process running in the container. The web terminal page subscribes to that relay over Server-Sent Events and speaks whatever arrives. Speech recognition auto-pauses while a response is being read, so the mic doesn't pick up and re-transcribe your own speakers.

This needs a second port published alongside the ttyd port (`run.sh` publishes `<port>+1` automatically) for the browser to reach the relay directly — e.g. `--web 7681` also publishes `7682`. The relay only accepts pushes (`POST /speak`) from inside the container (loopback-only); the `/events` stream it broadcasts to has no auth, same trust model as ttyd itself. With `--tls`, the relay automatically serves `/events` over HTTPS too (using the same self-signed cert as ttyd) — an `https://` page can't subscribe to a plain `http://` stream, so this isn't optional once TLS is on.

The relay also keeps the last text it broadcast in memory and exposes `POST /replay`, which re-broadcasts it to every `/events` subscriber on request — this is what the "repeat that" voice command above calls. It's deliberately *not* loopback-restricted like `/speak`: it can only ever replay text that was already sent to every subscriber, so it grants a browser client no capability `/events` didn't already give it.

**Background-tab audio**: Chrome throttles background tabs' timers, which lets speechSynthesis's own long-standing ~15s-idle stall bug resurface the moment you switch away from this tab — responses would otherwise go silent until you tab back in. Chrome exempts tabs it considers "audible" from that throttling, but only for genuinely non-silent audio, so the page loops a ~1s, low-amplitude (but not muted) white-noise clip whenever "speak responses" is checked, purely to keep the tab in that exempt state. Side effect: the browser shows its speaker/audio icon on this tab while armed, and the loop isn't perfectly silent (a very faint hiss) — this is an unsupported browser quirk, not a documented API, and Chrome could change this behavior in a future release. The clip is embedded as `KEEPALIVE_AUDIO_SRC` (a base64 WAV) near the top of the `harness-voice-script` block; regenerate it with:

```js
node -e '
const sampleRate = 8000, seconds = 1, amplitude = 700; // ~-33 dBFS peak, faint but non-zero
const numSamples = sampleRate * seconds, dataSize = numSamples * 2;
const buf = Buffer.alloc(44 + dataSize);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write("WAVE", 8);
buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write("data", 36); buf.writeUInt32LE(dataSize, 40);
let seed = 12345;
function rand() { seed ^= seed << 13; seed |= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed |= 0; return ((seed >>> 0) / 4294967295) * 2 - 1; }
for (let i = 0; i < numSamples; i++) {
  const fadeLen = 200;
  let env = 1;
  if (i < fadeLen) env = i / fadeLen; else if (i > numSamples - fadeLen) env = (numSamples - i) / fadeLen;
  buf.writeInt16LE(Math.round(rand() * amplitude * env), 44 + i * 2);
}
console.log("data:audio/wav;base64," + buf.toString("base64"));
'
```

**Files**: `web/voice-index.html` (the custom ttyd client page — mic button, wake-word logic, TTS playback), `scripts/voice_hook.js` (the Stop hook), `scripts/voice_relay.js` (the local relay), `scripts/ensure_voice_hook.js` (registers the hook into `settings.json` on container start).

#### Known limitations

This is a first pass, not a polished feature — works well enough for hands-free use, but has rough edges worth knowing about:

- **Speech recognition accuracy** is inherently limited by the browser's built-in engine — wake/stop-word matching is fuzzy (checks multiple recognition alternatives and tolerates common mishearings of "claude"), but general dictation still sometimes gets words wrong, especially with accents or background noise. Not fixable from this codebase; the fix would be swapping in a different ASR service entirely.

Addressed since the first pass:
- ~~No punctuation support~~ — see "Spoken punctuation" above.
- ~~TTS reads raw Markdown literally~~ — the Stop hook now strips Markdown before speaking (see above).
- ~~No mid-dictation correction~~ — see the "scratch that" discard command above.

### First run — login

On first run Claude Code will prompt you to log in:

```
> /login
```

Follow the URL it prints, sign in with your Claude Pro account in a browser, and paste the code back. The session is saved in the `claude_config` volume and reused on subsequent runs.

### Pass extra flags to Claude Code

Any arguments after the directory are forwarded to `claude`:

```bash
claude-harness . -p "write a readme"          # non-interactive prompt
claude-harness . --model claude-opus-5        # override model
```

---

## Configuring the allowlist

Edit `config/allowlist.yaml`. Changes take effect on the next container start — no rebuild needed (the file is volume-mounted read-only into the proxy).

```yaml
default_methods:
  - GET              # applied to hosts that don't specify their own methods

allowlist:
  - host: "api.example.com"
    methods: [GET, POST, PUT, DELETE]   # full read-write
    comment: "Internal API"

  - host: "files.example.com"
    methods: [GET]                       # read-only
    comment: "File downloads only"

  - host: "*.example.com"               # wildcard subdomain
    methods: [GET]
```

### Watch the proxy log

```bash
docker compose -f ~/projects/pessoal/claude-harness/docker-compose.yml logs -f proxy
```

Every request is logged as `ALLOW` or `BLOCK` with the method and hostname, making it easy to spot missing rules.

---

## Useful commands

| Command | Description |
|---|---|
| `docker compose build` | Rebuild both images |
| `claude-harness .` | Start a session in the current directory |
| `claude-harness --web .` | Start a browser-accessible session |
| `docker compose logs -f proxy` | Tail proxy allow/block log |
| `docker compose down` | Stop all containers |
| `docker compose down -v` | Stop and delete all volumes (resets login + certs) |
