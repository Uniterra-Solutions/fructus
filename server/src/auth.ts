//! SIWS auth + sessions (REQ-B-4, D14): the challenge mints and persists the
//! single-use nonce; `verify` checks the ed25519 signature (node:crypto only)
//! over the canonical message, consumes the nonce exactly once and issues an
//! HS256 JWT (`exp` = 24 h); `verifyToken` is the route-gating helper.

import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as edVerify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import type { ChallengeResponse, SessionResponse } from "fructus-sdk/src/api.js";
import type { Db } from "./db.js";
import { UnauthorizedError } from "./errors.js";

/** Challenge lifetime (PRD: expiration <= 5 min). */
export const CHALLENGE_TTL_MS = 5 * 60_000;
/** Session lifetime (PRD: JWT `exp` = 24 h). */
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

export interface SessionInfo {
  wallet: string;
}

export interface AuthService {
  /** Mint a SIWS `signInInput` (+ persisted nonce). `domain` defaults to the configured host. */
  challenge(wallet: string, domain?: string): ChallengeResponse;
  /** Verify the ed25519 signature over the challenge, consume the nonce, issue the JWT. */
  verify(wallet: string, signature: string, signInInput?: string): Promise<SessionResponse>;
  /** HS256-verify a bearer token; `null` => 401 upstream. */
  verifyToken(token: string): SessionInfo | null;
}

export interface AuthOptions {
  db: Db;
  jwtSecret: string;
  /** Fallback SIWS domain when the request host is not threaded through. */
  domain: string;
}

// ---------------------------------------------------------------------------
// base58 (decode; the encode-side vector lives in the tests)
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decode a base58 string into raw bytes; `null` on any non-alphabet character. */
function base58Decode(input: string): Uint8Array | null {
  if (input.length === 0) return null;
  let value = 0n;
  for (const char of input) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  // Every leading '1' encodes one leading zero byte.
  for (const char of input) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

// Standard RFC 8410 DER prefixes for raw ed25519 keys (seed / public point).
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Build an ed25519 public-key object from the raw 32-byte public point. */
function ed25519PublicKey(raw: Uint8Array) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]),
    format: "der",
    type: "spki",
  });
}

// ---------------------------------------------------------------------------
// HS256 JWT (node:crypto only)
// ---------------------------------------------------------------------------

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Issue an HS256 JWT with the wallet as `sub` and `exp` = now + SESSION_TTL_SECONDS. */
function issueToken(wallet: string, secret: string, nowMs = Date.now()): string {
  const nowSeconds = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ sub: wallet, iat: nowSeconds, exp: nowSeconds + SESSION_TTL_SECONDS }),
  );
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/** Verify an HS256 JWT's signature + `exp`; `null` when invalid or expired. */
function verifyTokenSignature(token: string, secret: string, nowMs = Date.now()): SessionInfo | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  const provided = Buffer.from(signature, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const { sub, exp } = claims as { sub?: unknown; exp?: unknown };
  if (typeof sub !== "string" || sub.length === 0) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  if (exp <= Math.floor(nowMs / 1000)) return null; // expired (REQ-B-4)
  return { wallet: sub };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Extract the nonce embedded in the canonical `Nonce: <hex>` line. */
function parseNonce(signInInput: string): string | null {
  for (const line of signInInput.split("\n")) {
    if (line.startsWith("Nonce: ")) {
      const nonce = line.slice("Nonce: ".length).trim();
      if (nonce.length > 0) return nonce;
    }
  }
  return null;
}

export function createAuth(opts: AuthOptions): AuthService {
  return {
    challenge(wallet: string, requestDomain?: string): ChallengeResponse {
      const nonce = randomBytes(16).toString("hex");
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
      const domain = requestDomain ?? opts.domain;
      // The canonical 6-line SIWS message (pinned by the auth test vectors).
      const signInInput = [
        `${domain} wants you to sign in with your Solana account:`,
        wallet,
        ``,
        `Nonce: ${nonce}`,
        `Issued At: ${issuedAt.toISOString()}`,
        `Expiration Time: ${expiresAt.toISOString()}`,
      ].join("\n");
      opts.db.createNonce({
        nonce,
        wallet,
        signInInput,
        expiresAt: expiresAt.getTime(),
        consumed: false,
      });
      return { signInInput, nonce, expiresAt: expiresAt.toISOString() };
    },

    async verify(wallet: string, signature: string, signInInput?: string): Promise<SessionResponse> {
      if (typeof signInInput !== "string" || signInInput.length === 0) {
        throw new UnauthorizedError("missing signInInput for the challenge");
      }

      // The wallet must be a decodable ed25519 public key.
      let walletBytes: Uint8Array;
      try {
        walletBytes = new PublicKey(wallet).toBytes();
      } catch {
        throw new UnauthorizedError("wallet is not a base58 public key");
      }

      // The signature must be base58 and exactly one 64-byte ed25519 signature.
      const signatureBytes = base58Decode(signature);
      if (signatureBytes === null || signatureBytes.length !== 64) {
        throw new UnauthorizedError("signature must be a base58-encoded 64-byte ed25519 signature");
      }

      // The message must embed a persisted challenge for this wallet, byte-equal.
      const nonce = parseNonce(signInInput);
      if (nonce === null) throw new UnauthorizedError("signInInput carries no nonce");
      const row = opts.db.getNonce(nonce);
      if (row === null) throw new UnauthorizedError("unknown challenge nonce");
      if (row.wallet !== wallet) throw new UnauthorizedError("challenge does not belong to this wallet");
      if (row.signInInput !== signInInput) throw new UnauthorizedError("signInInput does not match the issued challenge");
      if (row.consumed) throw new UnauthorizedError("challenge nonce already consumed");

      // ed25519 over the exact signed text, with the WALLET's key (not the signer's).
      let valid = false;
      try {
        valid = edVerify(null, Buffer.from(signInInput, "utf8"), ed25519PublicKey(walletBytes), signatureBytes);
      } catch {
        valid = false;
      }
      if (!valid) throw new UnauthorizedError("signature does not verify against the wallet key");

      // Single-use consume (replay AND expiry checked atomically by the db layer).
      const consumed = opts.db.consumeNonce(nonce);
      if (consumed === null) throw new UnauthorizedError("challenge nonce is consumed or expired");

      return { token: issueToken(wallet, opts.jwtSecret), wallet };
    },

    verifyToken(token: string): SessionInfo | null {
      return verifyTokenSignature(token, opts.jwtSecret);
    },
  };
}
