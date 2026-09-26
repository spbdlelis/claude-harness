# ── Host-port relay ──────────────────────────────────────────────────────────
# Minimal container that socat-forwards only the ports listed in HOST_PORTS
# to the host machine. Runs on the internal network with the alias
# host.docker.internal so Claude's connection strings work unchanged.
FROM alpine:3.19 AS hostports
RUN apk add --no-cache socat
COPY scripts/hostports.sh /hostports.sh
RUN chmod +x /hostports.sh
CMD ["/hostports.sh"]


# ── Proxy ─────────────────────────────────────────────────────────────────────
FROM ubuntu:22.04 AS proxy

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-yaml \
    iproute2 \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir mitmproxy

COPY scripts/proxy_entrypoint.sh /opt/harness/entrypoint.sh
COPY scripts/proxy_addon.py /opt/harness/proxy_addon.py
COPY config/allowlist.yaml /opt/harness/config/allowlist.yaml

RUN chmod +x /opt/harness/entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/opt/harness/entrypoint.sh"]


# ─────────────────────────────────────────────────────────────────────────────

FROM ubuntu:22.04 AS claude

ARG DEBIAN_FRONTEND=noninteractive
# @anthropic-ai/claude-code now requires Node >=22; this also happens to be
# the minimum for the headless-Chromium packages installed below.
ARG NODE_VERSION=22

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    ttyd \
    gosu \
    sudo \
    tmux \
    locales \
    # Shared libs required by @sparticuz/chromium's bundled headless
    # Chromium binary (see the "Headless Chromium" block below). Pulling
    # them in here, at image build time, means they're already present —
    # no outbound-proxy allowlist dependency at container runtime.
    libnspr4 \
    libnss3 \
    && locale-gen en_US.UTF-8 \
    && update-locale LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV TERM=xterm-256color

RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# ── Headless Chromium (puppeteer-core + @sparticuz/chromium) ─────────────────
# Playwright's and puppeteer's default browser-install paths fetch from CDNs
# (cdn.playwright.dev, storage.googleapis.com) that the runtime proxy
# allowlist blocks by design. @sparticuz/chromium instead ships a compressed,
# serverless-oriented Chromium binary *inside* its npm tarball, so a plain
# `npm install` (registry.npmjs.org, already allowlisted) is enough — no
# separate browser download step, and nothing needed from the proxy at all
# since this all happens at image build time.
#
# Installed into a fixed location (not globally alongside claude-code, and
# not under /workspace, which is a bind-mounted, per-project volume) with
# NODE_PATH pointing at it, so any script anywhere in the container can
# `require('puppeteer-core')` / `require('@sparticuz/chromium')` without a
# local install. Node's CJS loader can `require()` these ESM-only packages
# directly (stable since Node 22.12), which is what NODE_PATH resolution
# below relies on.
RUN mkdir -p /opt/harness/browser-libs && cd /opt/harness/browser-libs \
    && npm init -y >/dev/null \
    && npm install puppeteer-core@25.10.0 @sparticuz/chromium@149.0.0

ENV NODE_PATH=/opt/harness/browser-libs/node_modules

# Build-time sanity check: confirms the bundled Chromium binary resolves all
# shared libs and can actually launch and render a page. Fails the image
# build (rather than surfacing as a confusing runtime error later) if the
# lib set above ever drifts from what a newer @sparticuz/chromium needs.
#
# This verification run (as root, during build) makes @sparticuz/chromium
# extract its binary into /tmp/chromium — root-owned, mode 0700. Left in
# place, that would shadow the extraction the non-root `claude` user needs
# to do on first real use (executablePath() reuses /tmp/chromium if it
# already exists) and fail with EACCES. Clean it up so the real extraction
# happens fresh, owned by whichever user triggers it at container runtime.
COPY scripts/verify-chromium.js /opt/harness/verify-chromium.js
RUN node /opt/harness/verify-chromium.js \
    && rm -f /opt/harness/verify-chromium.js \
    && rm -rf /tmp/chromium /tmp/fonts /tmp/locales /tmp/node-compile-cache \
              /tmp/lib*.so /tmp/libvulkan.so.1 /tmp/vk_swiftshader_icd.json

# Non-root user that runs Claude Code.
# uid 1000 matches the most common host user uid so workspace files
# created inside the container are owned by your host user.
RUN useradd -m -s /bin/bash -u 1000 claude \
    && mkdir -p /workspace \
    && chown claude:claude /workspace \
    && echo "claude ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/claude \
    && chmod 0440 /etc/sudoers.d/claude

COPY scripts/claude_entrypoint.sh /opt/harness/entrypoint.sh
RUN chmod +x /opt/harness/entrypoint.sh

# Custom ttyd client page (stock ttyd UI + a mic button using the browser's
# Web Speech API) served in --web mode via ttyd's -I/--index flag.
COPY web/voice-index.html /opt/harness/voice-index.html

# Voice relay: a Stop hook posts Claude's response text to a local HTTP+SSE
# server, which the browser page subscribes to and speaks aloud.
COPY scripts/voice_relay.js /opt/harness/voice_relay.js
COPY scripts/voice_hook.js /opt/harness/voice_hook.js
COPY scripts/ensure_voice_hook.js /opt/harness/ensure_voice_hook.js

# Entrypoint runs as root to install the CA cert, then drops to 'claude'
WORKDIR /workspace

ENTRYPOINT ["/opt/harness/entrypoint.sh"]
CMD ["claude"]
