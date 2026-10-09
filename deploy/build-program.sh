#!/usr/bin/env bash
# Build the fructus SBF program (platform-tools v1.52, SBPFv0 — same flags as CI).
#
# WHY --no-rustup-override: cargo-build-sbf 4.1.0 normally links a rustup
# toolchain named `{rust}-sbpf-solana-v1.52` (e.g. 1.89.0-sbpf-solana-v1.52).
# rustup 1.26 (this box) refuses that name ("invalid custom toolchain name"),
# and its `rustup toolchain list -v` output is tab-separated while
# cargo-build-sbf splits on spaces, so the existing-link fast path also fails.
# Bypassing the rustup override and pointing directly at the platform-tools
# rustc/cargo produces the same artifact without touching rustup.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

TOOLS_DIR=/root/.cache/solana/v1.52/platform-tools
CBS=/root/.local/share/solana/install/active_release/bin/cargo-build-sbf

[ -x "$TOOLS_DIR/rust/bin/rustc" ] || { echo "missing platform-tools v1.52 at $TOOLS_DIR" >&2; exit 1; }

PATH="$TOOLS_DIR/rust/bin:$PATH" \
RUSTC="$TOOLS_DIR/rust/bin/rustc" \
"$CBS" --manifest-path programs/fructus/Cargo.toml \
  --tools-version v1.52 --arch v0 --no-rustup-override \
  --sbf-out-dir target/deploy-v0
cp target/deploy-v0/fructus.so target/deploy/fructus.so
sha256sum target/deploy/fructus.so
