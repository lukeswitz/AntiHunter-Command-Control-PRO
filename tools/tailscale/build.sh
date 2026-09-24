#!/usr/bin/env bash
# Build the AHCC Tailscale (tsnet) helper for the current platform (Go 1.24+); run on the deploy target.
set -euo pipefail
cd "$(dirname "$0")"
out="../../apps/backend/bin/tailscale/ahcc-tailscale"
mkdir -p "$(dirname "$out")"
go build -trimpath -ldflags="-s -w" -o "$out" .
echo "built $out"
