#!/bin/bash
set -euo pipefail

# Usage: claude-harness [--web [port]] [directory] [claude-args...]
#
#   --web [port]   Expose a browser-accessible terminal on the given port
#                  (default port: 7681). Open http://<host-ip>:<port> from
#                  any device on the same network.
#   directory      Path to mount as /workspace (default: current directory)
#   claude-args    Extra args forwarded to claude
#
# Examples:
#   claude-harness .                        # local terminal, current dir
#   claude-harness ~/projects/my-app        # local terminal, specific dir
#   claude-harness --web .                  # web terminal on port 7681
#   claude-harness --web 9000 .             # web terminal on port 9000

WEB_PORT=""
PORT_ARGS=()

# Parse --web [port] before the directory argument
if [ "${1:-}" = "--web" ]; then
    shift
    # If the next arg looks like a port number, consume it
    if [[ "${1:-}" =~ ^[0-9]+$ ]]; then
        WEB_PORT="$1"
        shift
    else
        WEB_PORT="${HARNESS_WEB_PORT:-7681}"
    fi
    PORT_ARGS=(-p "$WEB_PORT:$WEB_PORT")
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

echo "Workspace: $WORKSPACE_DIR"
[ -n "$WEB_PORT" ] && echo "Web terminal: http://0.0.0.0:$WEB_PORT"

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
