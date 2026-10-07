//! RED acceptance tests for REQ-B-4 (D14): the SIWS challenge/verify round-trip
//! with its rejection hostiles, and the JWT gate on every private route.
//!
//! Both propositions drive the real HTTP surface through `harness.startServer()`
//! (the server child process against its own temp SQLite). ed25519 signatures
//! come from `node:crypto` only — the raw 32-byte seed is wrapped in the standard
//! PKCS8 DER prefix, the raw public key in the SPKI prefix — and every vector is
//! verified locally before it is sent, so a failing vector is a test bug, never
//! an environment artifact.
//!
//! RED on today's tree: `auth.verify()` is a stub and `api.ts` answers 501 for
//! every route except `/healthz`, so the assertions below fail behaviourally
//! (expected 200/401, got 501).

import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import { Keypair } from "@solana/web3.js";
import type {
  ApiResponse,
  ChallengeResponse,
  MarketView,
  SessionResponse,
  UserPortfolio,
} from "fructus-sdk/src/api.js";
import { ROUTES } from "../src/api.js";
import { openDb } from "../src/db.js";
import { startServer, stopAll, type ServerHandle } from "./harness.js";

after(async () => {
  await stopAll();
});

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
  opts: { body?: unknown; token?: string } = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
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
    body = null; // keep the caller's assertion (not a parse throw) as the failure
  }
  return { status: res.status, body, text };
}

/** Assert the success envelope and return `data`. */
function expectOk<T>(res: JsonResponse, what: string): T {
  assert.equal(res.status, 200, `${what} must answer 200 (got ${res.status}: ${res.text.slice(0, 160)})`);
  const body = res.body;
  assert.ok(body !== null, `${what} must answer the unified JSON envelope (got: ${res.text.slice(0, 160)})`);
  assert.equal(body.ok, true, `${what} must use the success envelope (got: ${res.text.slice(0, 160)})`);
  return (body as { ok: true; data: T }).data;
}

/** Assert a unified-envelope failure in the 4xx range. */
function expect4xx(res: JsonResponse, what: string): void {
  assert.ok(
    res.status >= 400 && res.status < 500,
    `${what} must be rejected with a 4xx (got ${res.status}: ${res.text.slice(0, 160)})`,
  );
  const body = res.body;
  assert.ok(body !== null, `${what} must answer the unified JSON envelope (got: ${res.text.slice(0, 160)})`);
  assert.equal(body.ok, false, `${what} must use the failure envelope (got: ${res.text.slice(0, 160)})`);
}

/** Assert a 401 `{code:"unauthorized"}` (REQ-B-4: invalid/expired token ⇒ 401). */
function expect401(res: JsonResponse, what: string): void {
  assert.equal(res.status, 401, `${what} must answer 401 (got ${res.status}: ${res.text.slice(0, 160)})`);
  const body = res.body;
  assert.ok(body !== null, `${what} must answer the unified JSON envelope (got: ${res.text.slice(0, 160)})`);
  assert.equal(body.ok, false, `${what} must use the failure envelope (got: ${res.text.slice(0, 160)})`);
  const failure = body as { ok: false; error: { code: string } };
  assert.equal(failure.error.code, "unauthorized", `${what} must report code "unauthorized" (got: ${res.text.slice(0, 160)})`);
}

// ---------------------------------------------------------------------------
// Helpers: ed25519 signing (node:crypto only)
// ---------------------------------------------------------------------------

// Standard RFC 8410 DER prefixes for raw ed25519 keys (seed / public point).
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

interface SiwsSigner {
  keypair: Keypair;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

function makeSigner(): SiwsSigner {
  const keypair = Keypair.generate();
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(keypair.secretKey.subarray(0, 32))]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(keypair.publicKey.toBytes())]),
    format: "der",
    type: "spki",
  });
  return { keypair, privateKey, publicKey };
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Minimal dependency-free base58 encoder (no bn.js/bs58 import). */
function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = BASE58_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out; // leading zero bytes
  }
  return out;
}

/** Sign `message` with the signer's ed25519 key; base58 the signature. Verifies locally first. */
function signSiws(signer: SiwsSigner, message: string): string {
  const bytes = Buffer.from(message, "utf8");
  const signature = edSign(null, bytes, signer.privateKey);
  assert.ok(
    edVerify(null, bytes, signer.publicKey, signature),
    "test-vector sanity: the locally produced ed25519 signature must verify against the locally derived key",
  );
  return base58Encode(signature);
}

// ---------------------------------------------------------------------------
// Helpers: SIWS challenge + session
// ---------------------------------------------------------------------------

const SIWS_SUFFIX = " wants you to sign in with your Solana account:";

/** POST /auth/challenge and return the challenge payload. */
async function challengeFor(server: ServerHandle, wallet: string): Promise<ChallengeResponse> {
  const res = await call(server, "POST", "/auth/challenge", { body: { wallet } });
  const data = expectOk<ChallengeResponse>(res, `POST /auth/challenge for ${wallet}`);
  assert.ok(typeof data.signInInput === "string" && data.signInInput.length > 0, "challenge must carry a signInInput");
  assert.ok(typeof data.nonce === "string" && data.nonce.length > 0, "challenge must carry the nonce");
  assert.ok(typeof data.expiresAt === "string" && data.expiresAt.length > 0, "challenge must carry expiresAt");
  return data;
}

/**
 * Pin the exact 6-line message shape `auth.ts` emits:
 *   `<domain> wants you to sign in with your Solana account:`
 *   `<wallet>`
 *   ``
 *   `Nonce: <nonce>`
 *   `Issued At: <iso>`
 *   `Expiration Time: <iso>`
 */
function assertCanonicalSiwsMessage(wallet: string, challenge: ChallengeResponse): void {
  const lines = challenge.signInInput.split("\n");
  assert.equal(
    lines.length,
    6,
    `the SIWS signInInput must have the 6-line shape auth.ts emits (got ${JSON.stringify(challenge.signInInput)})`,
  );
  assert.ok(
    lines[0].endsWith(SIWS_SUFFIX),
    `line 1 must be "<domain>${SIWS_SUFFIX}" (got ${JSON.stringify(lines[0])})`,
  );
  const domain = lines[0].slice(0, -SIWS_SUFFIX.length);
  assert.ok(domain.length > 0 && !/\s/.test(domain), `the SIWS domain must be a non-empty host token (got ${JSON.stringify(domain)})`);
  assert.equal(lines[1], wallet, "line 2 must be the wallet address");
  assert.equal(lines[2], "", "line 3 must be the blank separator");
  assert.equal(lines[3], `Nonce: ${challenge.nonce}`, "line 4 must embed the response nonce");
  assert.ok(lines[4].startsWith("Issued At: "), `line 5 must be "Issued At: <iso>" (got ${JSON.stringify(lines[4])})`);
  assert.equal(
    lines[5],
    `Expiration Time: ${challenge.expiresAt}`,
    "line 6 must match the response expiresAt",
  );
  const issuedAt = Date.parse(lines[4].slice("Issued At: ".length));
  const expiresAt = Date.parse(challenge.expiresAt);
  assert.ok(Number.isFinite(issuedAt), `Issued At must be an ISO timestamp (got ${JSON.stringify(lines[4])})`);
  assert.ok(Number.isFinite(expiresAt), `expiresAt must be an ISO timestamp (got ${JSON.stringify(challenge.expiresAt)})`);
  assert.ok(expiresAt > issuedAt, "the challenge expiry must be after issuance");
  assert.ok(
    expiresAt - issuedAt <= 5 * 60_000,
    `challenge TTL must be <= 5 min (REQ-B-4; got ${expiresAt - issuedAt} ms)`,
  );
  assert.ok(expiresAt > Date.now(), "a freshly issued challenge must not already be expired");
  assert.ok(/^[0-9a-f]{16,}$/i.test(challenge.nonce), `the nonce must be a random hex string (got ${JSON.stringify(challenge.nonce)})`);
}

/** Standard HS256 JWT, signed with a secret the harness booted the server with. */
function craftHs256Jwt(payload: Record<string, unknown>, secret: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const claims = encode(payload);
  const signature = createHmac("sha256", secret).update(`${header}.${claims}`).digest("base64url");
  return `${header}.${claims}.${signature}`;
}

// ---------------------------------------------------------------------------
// AUTH-SIWS-ROUNDTRIP-AND-REJECTIONS (REQ-B-4)
// ---------------------------------------------------------------------------

test("AUTH-SIWS-ROUNDTRIP-AND-REJECTIONS: correct signatures yield sessions; wrong keys, tampered messages, replayed nonces, expired challenges are rejected.", async (t) => {
  const server = await startServer();

  try {
    await t.test("challenge: the signInInput is the canonical SIWS message", async () => {
      const wallet = Keypair.generate().publicKey.toBase58();
      const challenge = await challengeFor(server, wallet);
      assertCanonicalSiwsMessage(wallet, challenge);
    });

    await t.test("verify: a correct signature yields the wallet's session", async () => {
      const signer = makeSigner();
      const wallet = signer.keypair.publicKey.toBase58();
      const challenge = await challengeFor(server, wallet);
      const signature = signSiws(signer, challenge.signInInput);

      const res = await call(server, "POST", "/auth/verify", {
        body: { wallet, signature, signInInput: challenge.signInInput },
      });
      const session = expectOk<SessionResponse>(res, "POST /auth/verify with a valid signature");
      assert.equal(session.wallet, wallet, "the session must belong to the signing wallet");
      assert.equal(
        session.token.split(".").length,
        3,
        `the session token must be a JWT (three dot-separated segments; got ${JSON.stringify(session.token)})`,
      );

      // Positive control: the issued token clears the route gate below.
      const me = await call(server, "GET", "/me", { token: session.token });
      const portfolio = expectOk<UserPortfolio>(me, "GET /me with the fresh session token");
      assert.equal(portfolio.wallet, wallet, "GET /me must serve the session's wallet (JWT sub)");
    });

    await t.test("verify: a signature from the wrong key is rejected", async () => {
      const walletSigner = makeSigner();
      const impostor = makeSigner();
      const wallet = walletSigner.keypair.publicKey.toBase58();
      const challenge = await challengeFor(server, wallet);
      const signature = signSiws(impostor, challenge.signInInput); // valid signature, wrong key

      const res = await call(server, "POST", "/auth/verify", {
        body: { wallet, signature, signInInput: challenge.signInInput },
      });
      expect4xx(res, "POST /auth/verify with a signature from a key that is not the wallet's");
    });

    await t.test("verify: a tampered message is rejected", async () => {
      const signer = makeSigner();
      const wallet = signer.keypair.publicKey.toBase58();
      const challenge = await challengeFor(server, wallet);
      const tampered = challenge.signInInput.replace(/Issued At: [^\n]+/, "Issued At: 1999-01-01T00:00:00.000Z");
      assert.notEqual(tampered, challenge.signInInput, "the tamper must change the signed text");
      const signature = signSiws(signer, challenge.signInInput); // over the ORIGINAL text

      const res = await call(server, "POST", "/auth/verify", {
        body: { wallet, signature, signInInput: tampered },
      });
      expect4xx(res, "POST /auth/verify whose signature is bound to a different message");
    });

    await t.test("verify: a replayed nonce is rejected", async () => {
      const signer = makeSigner();
      const wallet = signer.keypair.publicKey.toBase58();
      const challenge = await challengeFor(server, wallet);
      const signature = signSiws(signer, challenge.signInInput);
      const body = { wallet, signature, signInInput: challenge.signInInput };

      expectOk<SessionResponse>(
        await call(server, "POST", "/auth/verify", { body }),
        "the first verify of the challenge",
      );
      expect4xx(
        await call(server, "POST", "/auth/verify", { body }),
        "a replay of the consumed nonce (same wallet/signature/signInInput)",
      );
    });

    await t.test("verify: an expired challenge is rejected", async () => {
      const signer = makeSigner();
      const wallet = signer.keypair.publicKey.toBase58();
      const challenge = await challengeFor(server, wallet);

      // There is no challenge-TTL knob in `Config` (CHALLENGE_TTL_MS is a module
      // constant), so age the persisted row through the db layer instead of
      // faking a clock.
      const db = openDb(server.dbPath);
      try {
        const result = db.raw
          .prepare("UPDATE auth_nonces SET expires_at = ? WHERE nonce = ?")
          .run(Date.now() - 1_000, challenge.nonce);
        assert.equal(Number(result.changes), 1, "ageing the challenge must hit exactly the persisted auth_nonces row");
      } finally {
        db.close();
      }

      const signature = signSiws(signer, challenge.signInInput);
      expect4xx(
        await call(server, "POST", "/auth/verify", {
          body: { wallet, signature, signInInput: challenge.signInInput },
        }),
        "POST /auth/verify over an expired challenge",
      );

      // Positive control: a fresh challenge for the same wallet still verifies.
      const fresh = await challengeFor(server, wallet);
      const freshSignature = signSiws(signer, fresh.signInInput);
      expectOk<SessionResponse>(
        await call(server, "POST", "/auth/verify", {
          body: { wallet, signature: freshSignature, signInInput: fresh.signInInput },
        }),
        "POST /auth/verify over a fresh challenge (expiry positive control)",
      );
    });

    await t.test("verify: malformed base58 signatures are rejected", async () => {
      const wallet = Keypair.generate().publicKey.toBase58();
      const challenge = await challengeFor(server, wallet);
      const cases: Array<[string, string]> = [
        ["contains non-base58 characters", "0OIl!!!"],
        ["decodes to 32 bytes, not a 64-byte ed25519 signature", base58Encode(Buffer.alloc(32, 7))],
      ];
      for (const [what, signature] of cases) {
        expect4xx(
          await call(server, "POST", "/auth/verify", { body: { wallet, signature, signInInput: challenge.signInInput } }),
          `POST /auth/verify with a signature that ${what}`,
        );
      }
    });
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// AUTH-SESSION-GATES-ROUTES (REQ-B-4)
// ---------------------------------------------------------------------------

test("AUTH-SESSION-GATES-ROUTES: every private route 401s without a valid token and succeeds with one.", async (t) => {
  const server = await startServer();

  try {
    const privateRoutes = ROUTES.filter((route) => route.private);
    assert.ok(
      privateRoutes.length >= 8,
      `the exported ROUTES table must enumerate every private route (expected >= 8, got ${privateRoutes.length})`,
    );

    await t.test("no Authorization header: every private route 401s", async () => {
      for (const route of privateRoutes) {
        const res = await call(server, route.method, route.path, { body: route.method === "POST" ? {} : undefined });
        expect401(res, `${route.method} ${route.path} without a token`);
      }
    });

    await t.test("a garbage bearer token: every private route 401s", async () => {
      for (const route of privateRoutes) {
        const res = await call(server, route.method, route.path, {
          token: "not-a-jwt",
          body: route.method === "POST" ? {} : undefined,
        });
        expect401(res, `${route.method} ${route.path} with a garbage token`);
      }
    });

    await t.test("a well-formed but expired HS256 token: /me 401s", async () => {
      const wallet = Keypair.generate().publicKey.toBase58();
      // The harness boots the server with JWT_SECRET "harness-secret"; an
      // expired standard JWT must be refused even though it is signed right.
      const expired = craftHs256Jwt({ sub: wallet, exp: Math.floor(Date.now() / 1000) - 3_600 }, "harness-secret");
      expect401(await call(server, "GET", "/me", { token: expired }), "GET /me with an expired token");
    });

    await t.test("a valid session token unlocks GET /me and GET /market", async () => {
      const signer = makeSigner();
      const wallet = signer.keypair.publicKey.toBase58();
      const challenge = await challengeFor(server, wallet);
      const signature = signSiws(signer, challenge.signInInput);
      const session = expectOk<SessionResponse>(
        await call(server, "POST", "/auth/verify", { body: { wallet, signature, signInInput: challenge.signInInput } }),
        "POST /auth/verify for the gating positive leg",
      );

      const me = await call(server, "GET", "/me", { token: session.token });
      const portfolio = expectOk<UserPortfolio>(me, "GET /me with a valid session token");
      assert.equal(portfolio.wallet, wallet, "GET /me must serve the session's wallet");

      const market = await call(server, "GET", "/market", { token: session.token });
      expectOk<MarketView>(market, "GET /market with a valid session token");
    });

    await t.test("a valid session token clears the gate on every private action route", async () => {
      const signer = makeSigner();
      const wallet = signer.keypair.publicKey.toBase58();
      const challenge = await challengeFor(server, wallet);
      const signature = signSiws(signer, challenge.signInInput);
      const session = expectOk<SessionResponse>(
        await call(server, "POST", "/auth/verify", { body: { wallet, signature, signInInput: challenge.signInInput } }),
        "POST /auth/verify for the action-gate positive leg",
      );

      for (const route of privateRoutes.filter((candidate) => candidate.method === "POST")) {
        const res = await call(server, route.method, route.path, { token: session.token, body: {} });
        assert.notEqual(
          res.status,
          401,
          `${route.method} ${route.path} with a valid token must not 401 (got ${res.status}: ${res.text.slice(0, 160)})`,
        );
      }
    });
  } finally {
    await server.stop();
  }
});
