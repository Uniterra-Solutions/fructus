#!/usr/bin/env bash
# systemd wrapper: boot the devstack once, wait until ready, apply the printed
# env to the server/MM units, then stay alive attached to the devstack process.
set -uo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$DEPLOY_DIR/../scripts"
LOG="$DEPLOY_DIR/devstack.log"
NODE=/usr/local/bin/node
TSX="$SCRIPTS_DIR/node_modules/tsx/dist/cli.mjs"

export HOME=/root
export PATH="/root/.local/share/solana/install/active_release/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
cd "$SCRIPTS_DIR"

stamp=$(date -Is)
{ echo; echo "=== devstack boot $stamp ==="; } >>"$LOG"
before=$(wc -c <"$LOG")

"$NODE" "$TSX" devstack.mts >>"$LOG" 2>&1 &
DSPID=$!

terminate() { kill "$DSPID" 2>/dev/null || true; }
trap terminate TERM INT

ready=0
for _ in $(seq 1 600); do
  kill -0 "$DSPID" 2>/dev/null || break
  if tail -c +"$((before + 1))" "$LOG" | grep -q "devstack\] ready"; then ready=1; break; fi
  sleep 1
done

if [ "$ready" -eq 1 ]; then
  if "$DEPLOY_DIR/apply-env.sh" "$LOG"; then
    systemctl restart fructus-server.service fructus-mm.service || true
  fi
else
  echo "run-devstack: devstack never became ready (or exited early)" >&2
fi

wait "$DSPID"
exit $?
