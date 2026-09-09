#!/bin/sh
# Forwards each port listed in HOST_PORTS to the same port on the host machine.
# HOST_PORTS is a comma-separated list: HOST_PORTS=5432,5672,6379
set -e

if [ -z "${HOST_PORTS:-}" ]; then
    echo "[hostports] HOST_PORTS not set — no host ports exposed"
    exec sleep infinity
fi

echo "[hostports] Forwarding: $HOST_PORTS"

for port in $(echo "$HOST_PORTS" | tr ',' ' '); do
    echo "[hostports]   :$port -> host.docker.internal:$port"
    socat TCP-LISTEN:"$port",fork,reuseaddr TCP:host.docker.internal:"$port" &
done

exec sleep infinity
