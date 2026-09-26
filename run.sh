#!/bin/bash
set -euo pipefail

# Usage: claude-harness [--web [port] [--tls]] [directory] [claude-args...]
#
#   --web [port]   Expose a browser-accessible terminal on the given port
#                  (default port: 7681). Open http://localhost:<port>, or
#                  http://<machine-ip>:<port> from another device on the
#                  same network (see --tls below for that case).
#   --tls          Serve the web terminal over self-signed HTTPS. Browsers
#                  only grant microphone access on a secure context —
#                  https://, or the literal loopback names localhost/
#                  127.0.0.1 — so voice input silently stays blocked on any
#                  other hostname/IP (even one resolving to this same
#                  machine, e.g. a .local mDNS name) without this. Only
#                  needed for that case; localhost access works over plain
#                  http:// either way. Self-signed: browsers show a
#                  one-time click-through warning per device.
#   directory      Path to mount as /workspace (default: current directory)
#   claude-args    Extra args forwarded to claude
#
# Examples:
#   claude-harness .                        # local terminal, current dir
#   claude-harness ~/projects/my-app        # local terminal, specific dir
#   claude-harness --web .                  # web terminal on port 7681
#   claude-harness --web 9000 .             # web terminal on port 9000
#   claude-harness --web --tls .            # web terminal, HTTPS (for LAN access + voice)

WEB_PORT=""
PORT_ARGS=()

# Parse --web [port] [--tls] before the directory argument
if [ "${1:-}" = "--web" ]; then
    shift
    # If the next arg looks like a port number, consume it
    if [[ "${1:-}" =~ ^[0-9]+$ ]]; then
        WEB_PORT="$1"
        shift
    else
        WEB_PORT="${HARNESS_WEB_PORT:-7681}"
    fi
    if [ "${1:-}" = "--tls" ]; then
        shift
        export HARNESS_WEB_TLS=1
    fi
    # The voice relay (Stop hook -> browser text-to-speech) listens on the
    # next port up; published alongside the ttyd port so the browser can
    # reach it directly.
    VOICE_RELAY_PORT="$((WEB_PORT + 1))"
    PORT_ARGS=(-p "$WEB_PORT:$WEB_PORT" -p "$VOICE_RELAY_PORT:$VOICE_RELAY_PORT")
fi

TARGET="${1:-$(pwd)}"
shift 2>/dev/null || true   # remaining args forwarded to claude

if [ ! -d "$TARGET" ]; then
    echo "error: '$TARGET' is not a directory" >&2
    exit 1
fi

WORKSPACE_DIR="$(realpath "$TARGET")"
# Resolve symlinks so this works when called via a symlink in PATH
HARNESS_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"

export WORKSPACE_DIR
# Mount at the same absolute path inside the container as on the host,
# instead of a fixed /workspace. Claude Code's per-project memory is keyed
# off the absolute working directory, so this keeps different projects run
# through this harness from sharing one memory bucket. Trade-off: the host
# username and directory names above the project become visible inside the
# container (accepted for this setup).
export WORKSPACE_MOUNT="$WORKSPACE_DIR"
[ -n "$WEB_PORT" ] && export HARNESS_WEB_PORT="$WEB_PORT"
[ -n "$WEB_PORT" ] && export HARNESS_VOICE_RELAY_PORT="$VOICE_RELAY_PORT"

echo "Workspace: $WORKSPACE_DIR"
if [ -n "$WEB_PORT" ]; then
    WEB_SCHEME="http"
    [ -n "${HARNESS_WEB_TLS:-}" ] && WEB_SCHEME="https"
    echo "Web terminal: $WEB_SCHEME://0.0.0.0:$WEB_PORT"
fi

# Extra args are forwarded to claude, but the base command and
# --dangerously-skip-permissions must always be present.
if [ $# -gt 0 ]; then
    exec docker compose -f "$HARNESS_DIR/docker-compose.yml" \
        run --rm "${PORT_ARGS[@]}" claude \
        claude --dangerously-skip-permissions "$@"
else
    exec docker compose -f "$HARNESS_DIR/docker-compose.yml" \
        run --rm "${PORT_ARGS[@]}" claude
fi
