#!/bin/bash
# Runs as root, drops to 'claude' user before exec-ing Claude Code.
set -euo pipefail

PROXY_HOST="${HARNESS_PROXY_HOST:-proxy}"
PROXY_PORT="${HARNESS_PROXY_PORT:-8080}"
CA_CERT="${HARNESS_CA_CERT:-/certs/mitmproxy-ca-cert.pem}"
CLAUDE_HOME=/home/claude

# ── Wait for proxy CA cert ────────────────────────────────────────────────────
echo "[harness] Waiting for proxy CA certificate..."
for i in $(seq 1 60); do
    [ -f "$CA_CERT" ] && break
    sleep 1
done
if [ ! -f "$CA_CERT" ]; then
    echo "[harness] ERROR: CA cert not found after 60s — is the proxy running?" >&2
    exit 1
fi

# ── Install CA into system trust store (requires root) ────────────────────────
cp "$CA_CERT" /usr/local/share/ca-certificates/harness-proxy-ca.crt
update-ca-certificates --fresh >/dev/null 2>&1
echo "[harness] CA certificate installed"

# ── Copy CA cert to a path the claude user can read ──────────────────────────
CLAUDE_CA_CERT="$CLAUDE_HOME/.config/harness-ca.pem"
mkdir -p "$CLAUDE_HOME/.config"
cp "$CA_CERT" "$CLAUDE_CA_CERT"
chown claude:claude "$CLAUDE_CA_CERT"
chmod 644 "$CLAUDE_CA_CERT"

# ── Proxy env vars ────────────────────────────────────────────────────────────
export http_proxy="http://$PROXY_HOST:$PROXY_PORT"
export https_proxy="http://$PROXY_HOST:$PROXY_PORT"
export HTTP_PROXY="http://$PROXY_HOST:$PROXY_PORT"
export HTTPS_PROXY="http://$PROXY_HOST:$PROXY_PORT"
export no_proxy="127.0.0.1,localhost,::1"
export NO_PROXY="127.0.0.1,localhost,::1"
export NODE_EXTRA_CA_CERTS="$CLAUDE_CA_CERT"
export SSL_CERT_FILE="$CLAUDE_CA_CERT"
export CURL_CA_BUNDLE="$CLAUDE_CA_CERT"
export GIT_SSL_CAINFO="$CLAUDE_CA_CERT"

echo "[harness] Proxy: $http_proxy"

# ── Restore Claude config from backup if main file is missing ─────────────────
CLAUDE_CONFIG="$CLAUDE_HOME/.claude.json"
BACKUP_DIR="$CLAUDE_HOME/.claude/backups"
if [ ! -f "$CLAUDE_CONFIG" ] && [ -d "$BACKUP_DIR" ]; then
    LATEST=$(ls -t "$BACKUP_DIR"/.claude.json.backup.* 2>/dev/null | head -1)
    if [ -n "$LATEST" ]; then
        echo "[harness] Restoring config from backup: $(basename "$LATEST")"
        cp "$LATEST" "$CLAUDE_CONFIG"
        chown claude:claude "$CLAUDE_CONFIG"
    fi
fi

# ── Drop to non-root 'claude' user and exec ───────────────────────────────────
if [ -n "${HARNESS_WEB_PORT:-}" ]; then
    echo "[harness] Web terminal on port $HARNESS_WEB_PORT — open http://<host-ip>:$HARNESS_WEB_PORT"
    # Write a minimal tmux config: no status bar, 256 colours, mouse support.
    # The status bar is what caused visual bugs — hiding it makes the terminal
    # look like a plain terminal window.
    TMUX_CONF=/home/claude/.tmux-harness.conf
    cat > "$TMUX_CONF" <<'EOF'
set -g status off
set -g default-terminal "xterm-256color"
set -ga terminal-overrides ",xterm-256color:Tc"
set -g mouse on
set -g utf8 on
set -g status-utf8 on
EOF
    chown claude:claude "$TMUX_CONF"

    # ── Optional TLS (needed for mic access from anything but localhost) ─────
    # Browsers only grant microphone access on a "secure context": https://,
    # or the literal loopback names localhost/127.0.0.1. A LAN hostname or IP
    # (even one resolving to this same machine, e.g. a .local mDNS name)
    # doesn't qualify, so voice input silently stays blocked there without
    # this. Self-signed — browsers show a one-time click-through warning per
    # device, but the page then loads as a genuine secure context.
    TTYD_TLS_ARGS=()
    if [ -n "${HARNESS_WEB_TLS:-}" ]; then
        TLS_DIR="$CLAUDE_HOME/.config/harness-web-tls"
        mkdir -p "$TLS_DIR"
        if [ ! -f "$TLS_DIR/cert.pem" ] || [ ! -f "$TLS_DIR/key.pem" ]; then
            echo "[harness] Generating self-signed TLS cert for the web terminal..."
            openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
                -keyout "$TLS_DIR/key.pem" -out "$TLS_DIR/cert.pem" \
                -subj "/CN=claude-harness" \
                -addext "subjectAltName=DNS:localhost,DNS:*.local,IP:127.0.0.1" \
                >/dev/null 2>&1
        fi
        chown -R claude:claude "$TLS_DIR"
        chmod 600 "$TLS_DIR/key.pem"
        TTYD_TLS_ARGS=(-S -C "$TLS_DIR/cert.pem" -K "$TLS_DIR/key.pem")
        export HARNESS_VOICE_RELAY_TLS_CERT="$TLS_DIR/cert.pem"
        export HARNESS_VOICE_RELAY_TLS_KEY="$TLS_DIR/key.pem"
        echo "[harness] TLS enabled — browsers will show a one-time self-signed-cert warning to click through"
    fi

    # ── Voice relay (Stop hook -> browser text-to-speech) ─────────────────────
    # Registers the Stop hook once (idempotent, preserves any existing
    # settings.json content) and starts the local relay it posts to.
    export HARNESS_VOICE_RELAY_PORT="${HARNESS_VOICE_RELAY_PORT:-$((HARNESS_WEB_PORT + 1))}"
    gosu claude node /opt/harness/ensure_voice_hook.js "$CLAUDE_HOME/.claude/settings.json" || \
        echo "[harness] WARNING: could not register voice-relay Stop hook (voice input still works)" >&2
    gosu claude node /opt/harness/voice_relay.js >/home/claude/.voice_relay.log 2>&1 &

    # Start Claude Code in a detached tmux session
    gosu claude tmux -f "$TMUX_CONF" new-session -d -s harness "$@"
    # ttyd attaches every browser connection to the same tmux session,
    # so all tabs share a single Claude Code instance.
    # -I serves our custom client page (stock ttyd UI + a mic button that
    # feeds Web Speech API transcripts into the terminal as pasted text, and
    # speaks Claude's responses back via the voice relay above).
    exec gosu claude ttyd --port "$HARNESS_WEB_PORT" --writable \
        -I /opt/harness/voice-index.html \
        "${TTYD_TLS_ARGS[@]}" \
        -- tmux -f "$TMUX_CONF" attach-session -t harness
fi

exec gosu claude "$@"
