//! RED acceptance tests for REQ-B-8 (D15): the devnet faucet's enable gate and
//! its 24 h caps, with the mint observed on a hermetic `solana-test-validator`
//! (harness).
//!
//! `faucet.ts` exposes no clock seam (`createFaucet({config, connection})`) and
//! no request carries an amount, so the plan-time unknown is the per-request
//! drip. The caps are therefore configured *relative to the measured drip*: a
//! first probe boot (huge caps) learns the exact per-request mint, then a second
//! boot gets a 3-drip per-wallet budget and a 5-drip global budget, making the
//! boundary arithmetic exact while every request still happens — per the
//! acceptance note — "via rapid requests within one window".
//!
//! RED on today's tree: `/faucet` answers 501 whether or not the faucet is
//! enabled (the route dispatch is stubbed) and `faucet.handle()` throws
//! `NotImplementedError` when enabled — so the expected 404/200 below come back
//! 501 and fail behaviourally.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, type PublicKey } from "@solana/web3.js";
import type { ApiResponse, FaucetResponse } from "fructus-sdk/src/api.js";
import {
  createMint,
  getAssociatedTokenAddress,
  startServer,
  startValidator,
  stopAll,
  type ServerHandle,
  type Validator,
} from "./harness.js";

after(async () => {
  await stopAll();
});

/** Caps for the probe boot: large enough that any sane drip passes. */
const DRIP_PROBE_CAP = 1_000_000_000_000n; // 1,000,000 tUSDC (6 dp)

// ---------------------------------------------------------------------------
// Helpers: HTTP + envelope
// ---------------------------------------------------------------------------

interface JsonResponse {
  status: number;
  body: ApiResponse<unknown> | null;
  text: string;
}

async function call(
  server: ServerHandle,
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown } = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${server.apiUrl}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: ApiResponse<unknown> | null = null;
  try {
    body = JSON.parse(text) as ApiResponse<unknown>;
  } catch {
    body = null; // let the caller's assertion (not a parse throw) report the failure
  }
  return { status: res.status, body, text };
}

function faucetPost(server: ServerHandle, wallet: string): Promise<JsonResponse> {
  return call(server, "POST", "/faucet", { body: { wallet } });
}

/** Assert an accepted faucet call and return the typed payload. */
function expectFaucetOk(res: JsonResponse, what: string): FaucetResponse {
  assert.equal(res.status, 200, `${what} must answer 200 (got ${res.status}: ${res.text.slice(0, 160)})`);
  const body = res.body;
  assert.ok(body !== null, `${what} must answer the unified JSON envelope (got: ${res.text.slice(0, 160)})`);
  assert.equal(body.ok, true, `${what} must use the success envelope (got: ${res.text.slice(0, 160)})`);
  const data = (body as { ok: true; data: FaucetResponse }).data;
  assert.ok(
    typeof data.amount === "string" && /^\d+$/.test(data.amount),
    `${what} must report the raw minted amount as a decimal string (got ${JSON.stringify(data.amount)})`,
  );
  assert.ok(
    typeof data.ata === "string" && data.ata.length > 0,
    `${what} must report the recipient ATA (got ${JSON.stringify(data.ata)})`,
  );
  return data;
}

/** Assert the disabled faucet's 404 `{code:"faucet_disabled"}` (D15). */
function expect404(res: JsonResponse, what: string): void {
  assert.equal(res.status, 404, `${what} must answer 404 (got ${res.status}: ${res.text.slice(0, 160)})`);
  const body = res.body;
  assert.ok(body !== null, `${what} must answer the unified JSON envelope (got: ${res.text.slice(0, 160)})`);
  assert.equal(body.ok, false, `${what} must use the failure envelope (got: ${res.text.slice(0, 160)})`);
  const failure = body as { ok: false; error: { code: string } };
  assert.equal(failure.error.code, "faucet_disabled", `${what} must report code "faucet_disabled" (got: ${res.text.slice(0, 160)})`);
}

/** Assert a unified-envelope failure in the 4xx range (over-cap rejection). */
function expect4xx(res: JsonResponse, what: string): void {
  assert.ok(
    res.status >= 400 && res.status < 500,
    `${what} must be rejected with a 4xx (got ${res.status}: ${res.text.slice(0, 160)})`,
  );
  const body = res.body;
  assert.ok(body !== null, `${what} must answer the unified JSON envelope (got: ${res.text.slice(0, 160)})`);
  assert.equal(body.ok, false, `${what} must use the failure envelope (got: ${res.text.slice(0, 160)})`);
}

// ---------------------------------------------------------------------------
// Helpers: on-chain balance observation
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The ATA's raw token amount; `null` when the account does not exist. */
async function tokenAmount(validator: Validator, ata: PublicKey): Promise<bigint | null> {
  try {
    const { value } = await validator.connection.getTokenAccountBalance(ata);
    return BigInt(value.amount);
  } catch {
    return null;
  }
}

/** Poll the ATA until it holds `expected` (bounded), returning the last observation. */
async function waitForTokenAmount(
  validator: Validator,
  ata: PublicKey,
  expected: bigint,
  timeoutMs = 10_000,
): Promise<bigint | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const amount = await tokenAmount(validator, ata);
    if (amount === expected || Date.now() >= deadline) return amount;
    await sleep(200);
  }
}

// ---------------------------------------------------------------------------
// FAUCET-CAPS-ENFORCED (REQ-B-8)
// ---------------------------------------------------------------------------

test("FAUCET-CAPS-ENFORCED: requests beyond the per-wallet budget are rejected; accepted calls move exactly the minted amount once.", async (t) => {
  // Holder object (not bare `let`s): closure assignments behind t.test() are
  // not visible to the outer control-flow analysis, which would over-narrow.
  const shared: {
    validator: Validator | null;
    mint: PublicKey | null;
    drip: bigint;
    capsServer: ServerHandle | null;
  } = { validator: null, mint: null, drip: 0n, capsServer: null };

  try {
    await t.test("FAUCET_ENABLED unset: POST /faucet answers 404", async () => {
      const wallet = Keypair.generate().publicKey.toBase58();
      // harness default is FAUCET_ENABLED="0"; "" is the unset equivalent
      // (config.optional maps "" to null).
      const off = await startServer({ env: { FAUCET_ENABLED: "" } });
      try {
        expect404(await faucetPost(off, wallet), "POST /faucet with FAUCET_ENABLED unset");
      } finally {
        await off.stop();
      }
    });

    await t.test("FAUCET_ENABLED=1 without the mint keys: POST /faucet answers 404", async () => {
      const wallet = Keypair.generate().publicKey.toBase58();
      const half = await startServer({ env: { FAUCET_ENABLED: "1" } });
      try {
        expect404(await faucetPost(half, wallet), "POST /faucet with FAUCET_ENABLED=1 but no FAUCET_MINT/authority");
      } finally {
        await half.stop();
      }
    });

    await t.test("an accepted call mints exactly the returned amount into the wallet's ATA (drip probe)", async () => {
      const v = await startValidator();
      shared.validator = v;
      const m = await createMint(v);
      shared.mint = m;

      const probe = await startServer({
        validator: v,
        env: {
          FAUCET_ENABLED: "1",
          FAUCET_MINT: m.toBase58(),
          FAUCET_MINT_AUTHORITY_KEYPAIR: v.authorityKeypairPath,
          FAUCET_PER_WALLET_CAP: String(DRIP_PROBE_CAP),
          FAUCET_GLOBAL_CAP: String(DRIP_PROBE_CAP),
        },
      });
      try {
        const wallet = Keypair.generate();
        const data = expectFaucetOk(
          await faucetPost(probe, wallet.publicKey.toBase58()),
          "the first faucet request for a fresh wallet",
        );
        const drip = BigInt(data.amount);
        shared.drip = drip;
        assert.ok(drip > 0n, `an accepted call must mint a positive amount (got ${data.amount})`);

        const ata = await getAssociatedTokenAddress(m, wallet.publicKey);
        assert.equal(data.ata, ata.toBase58(), "the mint must land in the wallet's canonical ATA");

        const balance = await waitForTokenAmount(v, ata, drip);
        assert.equal(balance, drip, "one accepted call must move exactly the returned amount (once) into the ATA");
      } finally {
        await probe.stop();
      }
    });

    await t.test("requests beyond the per-wallet 24 h budget are rejected; each accepted call mints once", async () => {
      const v = shared.validator;
      const m = shared.mint;
      const drip = shared.drip;
      assert.ok(drip > 0n, "needs the measured drip from the probe subtest");
      assert.ok(v !== null && m !== null, "needs the validator + mint from the probe subtest");

      const perWalletCap = 3n * drip;
      const globalCap = 5n * drip;
      const caps = await startServer({
        validator: v,
        env: {
          FAUCET_ENABLED: "1",
          FAUCET_MINT: m.toBase58(),
          FAUCET_MINT_AUTHORITY_KEYPAIR: v.authorityKeypairPath,
          FAUCET_PER_WALLET_CAP: String(perWalletCap),
          FAUCET_GLOBAL_CAP: String(globalCap),
        },
      });
      shared.capsServer = caps;

      const wallet = Keypair.generate();
      const walletAddress = wallet.publicKey.toBase58();
      const ata = await getAssociatedTokenAddress(m, wallet.publicKey);

      let minted = 0n;
      for (let i = 0; i < 3; i++) {
        const data = expectFaucetOk(
          await faucetPost(caps, walletAddress),
          `accepted call ${i + 1} within the per-wallet budget`,
        );
        assert.equal(BigInt(data.amount), drip, `accepted call ${i + 1} must mint exactly one drip`);
        assert.equal(data.ata, ata.toBase58(), `accepted call ${i + 1} must mint into the wallet's ATA`);
        minted += BigInt(data.amount);
      }
      assert.equal(minted, perWalletCap, "the accepted ladder must have spent the per-wallet budget exactly");

      expect4xx(await faucetPost(caps, walletAddress), "a request that would exceed the per-wallet budget");
      expect4xx(await faucetPost(caps, walletAddress), "a repeated over-budget request");

      const balance = await waitForTokenAmount(v, ata, minted);
      assert.equal(balance, minted, "the ATA must hold exactly the accepted drips — no double-mint, nothing over the cap");
    });

    await t.test("the global 24 h budget rejects a fresh wallet once exhausted", async () => {
      const v = shared.validator;
      const m = shared.mint;
      const caps = shared.capsServer;
      const drip = shared.drip;
      assert.ok(drip > 0n, "needs the measured drip from the probe subtest");
      assert.ok(v !== null && m !== null, "needs the validator + mint from the probe subtest");
      assert.ok(caps !== null, "needs the caps server from the per-wallet subtest");

      // The per-wallet subtest spent exactly 3 of the 5 drip global budget.
      const wallet = Keypair.generate();
      const walletAddress = wallet.publicKey.toBase58();
      const ata = await getAssociatedTokenAddress(m, wallet.publicKey);

      let minted = 0n;
      for (let i = 0; i < 2; i++) {
        const data = expectFaucetOk(
          await faucetPost(caps, walletAddress),
          `accepted call ${i + 1} against the remaining global budget`,
        );
        assert.equal(BigInt(data.amount), drip, `accepted call ${i + 1} must mint exactly one drip`);
        minted += BigInt(data.amount);
      }
      assert.equal(minted, 2n * drip, "the second wallet must have consumed exactly the remaining global budget");

      expect4xx(await faucetPost(caps, walletAddress), "a request that would exceed the global budget");

      // The decisive case: a wallet whose own budget is untouched is still
      // rejected once the global budget is spent.
      const fresh = Keypair.generate();
      expect4xx(
        await faucetPost(caps, fresh.publicKey.toBase58()),
        "a fresh wallet's first request when the global budget is exhausted",
      );

      const balance = await waitForTokenAmount(v, ata, minted);
      assert.equal(balance, minted, "the second wallet's ATA must hold exactly its accepted drips");
      const freshAta = await getAssociatedTokenAddress(m, fresh.publicKey);
      const freshBalance = await tokenAmount(v, freshAta);
      assert.equal(freshBalance ?? 0n, 0n, "the rejected fresh wallet must not have received any tUSDC");
    });
  } finally {
    if (shared.capsServer !== null) await shared.capsServer.stop();
    if (shared.validator !== null) shared.validator.stop();
  }
});
