//! SIWS auth + sessions (REQ-B-4, D14). `challenge()` is live (it mints and
//! persists the single-use nonce); `verify()` and `verifyToken()` are STUBS
//! for the ed25519 / HS256 wave.

import { randomBytes } from "node:crypto";
import type { ChallengeResponse, SessionResponse } from "fructus-sdk/src/api.js";
import type { Db } from "./db.js";
import { NotImplementedError } from "./errors.js";

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

export function createAuth(opts: AuthOptions): AuthService {
  return {
    challenge(wallet: string, requestDomain?: string): ChallengeResponse {
      const nonce = randomBytes(16).toString("hex");
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
      const domain = requestDomain ?? opts.domain;
      // Canonical SIWS-ish message; the exact wording is pinned by the auth
      // test vectors in the later wave.
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

    async verify(): Promise<SessionResponse> {
      // STUB (REQ-B-4): base58-decode `signature`, ed25519-verify it over the
      // challenge `signInInput` (`node:crypto`), consume the nonce exactly once
      // (replay => reject), then issue an HS256 JWT (`exp` = 24 h) over
      // `jwtSecret` with the wallet as `sub`.
      throw new NotImplementedError("auth.verify");
    },

    verifyToken(): SessionInfo | null {
      // STUB (REQ-B-4): HS256 verify + `exp` check; `null` means unauthorized.
      return null;
    },
  };
}
