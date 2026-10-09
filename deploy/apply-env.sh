#!/usr/bin/env bash
# Apply the devstack env blocks (printed at boot) to the server/MM env files.
# Runs after every devstack boot; the systemd units read the env files.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${1:-$DEPLOY_DIR/devstack.log}"

[ -f "$LOG" ] || { echo "apply-env: no devstack log at $LOG" >&2; exit 1; }

# Everything after the LAST ready marker belongs to the current boot.
start=$(grep -n "devstack\] ready" "$LOG" | tail -1 | cut -d: -f1 || true)
[ -n "${start:-}" ] || { echo "apply-env: devstack not ready yet in $LOG" >&2; exit 1; }
seg=$(tail -n "+$start" "$LOG")

server_env=$(printf '%s\n' "$seg" | sed -n '/^# ---- fructus-server/,/^# ---- mm-bot/p' | grep -E '^[A-Z][A-Z0-9_]*=' || true)
mm_env=$(printf '%s\n' "$seg" | sed -n '/^# ---- mm-bot/,$p' | grep -E '^[A-Z][A-Z0-9_]*=' || true)

for key in RPC_URL DATABASE_PATH JWT_SECRET OPERATOR_KEYPAIR PORT FAUCET_ENABLED FAUCET_MINT FAUCET_MINT_AUTHORITY_KEYPAIR; do
  grep -q "^$key=" <<<"$server_env" || { echo "apply-env: server env missing $key" >&2; exit 1; }
done
grep -q '^MM_KEYPAIR=' <<<"$mm_env" || { echo "apply-env: mm env missing MM_KEYPAIR" >&2; exit 1; }

umask 077
printf '%s\n' "$server_env" > "$DEPLOY_DIR/server.env"
printf '%s\n' "$mm_env" > "$DEPLOY_DIR/mm.env"
echo "apply-env: wrote server.env ($(grep -c '=' <<<"$server_env") keys) + mm.env ($(grep -c '=' <<<"$mm_env") keys)"
