# Fructus local stack (VPS) — deploy notes

Local **devstack** on the Uniterra VPS: `solana-test-validator` + the fructus
program (genesis-loaded, no keypair needed) + backend server + MM bot +
trading terminal at `https://fructus.uniterra-solutions.com` (tailnet-only,
nginx `100.64.0.1:443`).

## Units

| Unit | What | Port |
| --- | --- | --- |
| `fructus-devstack.service` | `run-devstack.sh` → `scripts/devstack.mts` (validator + market init + env printing) | RPC 8899 |
| `fructus-server.service` | `server` REST + WS (env from `server.env`) | 127.0.0.1:8787 |
| `fructus-mm.service` | market-maker bot (env from `mm.env`) | — |
| nginx `internal/fructus` | static `/var/www/fructus` + `/api` `/ws` `/rpc` proxies | 100.64.0.1:443 |

The devstack regenerates all keys/ledger on every boot and prints an env block;
`run-devstack.sh` writes it (via `apply-env.sh`) to `server.env` / `mm.env` and
restarts the dependent units — so a devstack restart re-provisions everything.

## Operations

```bash
systemctl status fructus-devstack fructus-server fructus-mm
journalctl -u fructus-devstack -n 50          # boot log (also deploy/devstack.log)
bash deploy/publish-frontend.sh               # rebuild + publish terminal to /var/www/fructus
bash deploy/build-program.sh                  # rebuild target/deploy/fructus.so (v1.52/v0)
systemctl restart fructus-devstack            # fresh chain, keys, market
```

## Pitfalls

- **rustup 1.26 vs cargo-build-sbf**: see `build-program.sh` header — build with
  `--no-rustup-override` + platform-tools rustc, not a plain `cargo build-sbf`.
- Each devstack boot = new ledger + new keys; the server must use the matching
  env (handled automatically). `JWT_SECRET` changes per boot: sessions expire.
- nginx workers can't read `/root` (mode 700) → frontend is served from
  `/var/www/fructus`, not from the repo.
- `deploy/*.env` and `deploy/devstack.log` are gitignored (keys/secrets).
