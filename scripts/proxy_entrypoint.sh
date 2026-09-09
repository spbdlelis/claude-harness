#!/bin/bash
set -euo pipefail

ALLOWLIST="${HARNESS_ALLOWLIST:-/opt/harness/config/allowlist.yaml}"
PORT="${HARNESS_PROXY_PORT:-8080}"

echo "[proxy] Starting on 0.0.0.0:$PORT"
echo "[proxy] Allowlist: $ALLOWLIST"

exec mitmdump \
    --mode regular \
    --listen-host 0.0.0.0 \
    --listen-port "$PORT" \
    --set confdir=/root/.mitmproxy \
    --set termlog_verbosity=warn \
    --set flow_detail=1 \
    -s /opt/harness/proxy_addon.py
