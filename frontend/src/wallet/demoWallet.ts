//! In-page demo (burner) wallet: a generated ed25519 keypair persisted in
//! storage as its 64 secret-key bytes (JSON array), with silent repair of
//! corrupted entries; signing goes through tweetnacl's detached ed25519 (the
//! SDK's `Keypair.sign` no longer exists).

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

export const DEMO_KEY_STORAGE = "fructus.demoKey";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const SECRET_KEY_LENGTH = 64;

/** Parse a stored secret key, returning `null` for anything that is not 64 byte values. */
function parseStoredSecretKey(raw: string | null): Uint8Array | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const values = parsed as unknown[];
  if (values.length !== SECRET_KEY_LENGTH) return null;
  const bytes: number[] = [];
  for (const value of values) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) return null;
    bytes.push(value);
  }
  return Uint8Array.from(bytes);
}

/** Load the persisted demo keypair, creating + persisting one when absent (repairs corrupted entries). */
export function loadOrCreateDemoKeypair(storage: StorageLike): Keypair {
  const secretKey = parseStoredSecretKey(storage.getItem(DEMO_KEY_STORAGE));
  if (secretKey !== null) {
    try {
      return Keypair.fromSecretKey(secretKey);
    } catch {
      /* structurally invalid key: fall through to regeneration */
    }
  }
  const keypair = Keypair.generate();
  storage.setItem(DEMO_KEY_STORAGE, JSON.stringify(Array.from(keypair.secretKey)));
  return keypair;
}

/** Remove the demo keypair from storage. */
export function resetDemoKeypair(storage: StorageLike): void {
  storage.removeItem(DEMO_KEY_STORAGE);
}

/** Sign a UTF-8 message with the keypair; returns the base58 signature. */
export function signMessageBase58(keypair: Keypair, message: string): string {
  // Copy into the module realm's Uint8Array: under jsdom/vitest the TextEncoder
  // output can come from another realm and would fail tweetnacl's instanceof check.
  const messageBytes = Uint8Array.from(new TextEncoder().encode(message));
  const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
  return bs58.encode(signature);
}

/**
 * Test-runtime realm normalisation (no-op in real browsers).
 *
 * jsdom — as Vitest runs it — hosts its window in a separate V8 realm, so
 * `new TextEncoder()` hands back typed arrays that fail tweetnacl's and
 * web3.js' `instanceof Uint8Array` checks (detached-signature verification via
 * caller-provided TextEncoder output breaks). Only when that mismatch is
 * observable, wrap `encode` so its output is a realm-local Uint8Array. In a
 * browser (and in plain Node) the probe passes and the global stays untouched.
 */
function ensureRealmConsistentTextEncoder(): void {
  try {
    if (new TextEncoder().encode("") instanceof Uint8Array) return;
    const originalEncode = TextEncoder.prototype.encode;
    TextEncoder.prototype.encode = function (this: TextEncoder, input?: string): Uint8Array<ArrayBuffer> {
      const encoded = input === undefined ? originalEncode.call(this) : originalEncode.call(this, input);
      const copy = new Uint8Array(encoded.length);
      copy.set(encoded);
      return copy;
    };
  } catch {
    /* probe unavailable: leave the global as-is */
  }
}

ensureRealmConsistentTextEncoder();
