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
claude-harness --web [port] [directory]
```

Starts a browser-accessible terminal via ttyd. Open `http://localhost:<port>` (or `http://<machine-ip>:<port>` from another device on the same network) to interact with Claude Code.

```bash
claude-harness --web .              # default port 7681
claude-harness --web 9000 .         # custom port
```

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
