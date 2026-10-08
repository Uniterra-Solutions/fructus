//! RED acceptance test for product-v3 REQ-F-2 (demo burner wallet):
//! persistence + repair through storage, detached ed25519 signatures, reset.
//!
//! RED on today's tree: `loadOrCreateDemoKeypair` never touches storage,
//! `resetDemoKeypair` is a no-op and `signMessageBase58` returns "" — the
//! first storage assertion fails behaviourally, never on compile/import.

import { expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  DEMO_KEY_STORAGE,
  loadOrCreateDemoKeypair,
  resetDemoKeypair,
  signMessageBase58,
} from "../src/wallet/demoWallet.js";

/** Map-backed StorageLike (self-contained: test files share no helpers). */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string): string | null => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string): void => {
      map.set(key, value);
    },
    removeItem: (key: string): void => {
      map.delete(key);
    },
  };
}

/** Assert the entry is valid JSON of exactly 64 byte values and return them. */
function readPersistedBytes(storage: { getItem(key: string): string | null }): number[] {
  const raw = storage.getItem(DEMO_KEY_STORAGE);
  expect(raw).not.toBeNull();
  const parsed = JSON.parse(String(raw)) as unknown;
  expect(Array.isArray(parsed)).toBe(true);
  const bytes = parsed as number[];
  expect(bytes.length).toBe(64);
  expect(bytes.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255)).toBe(true);
  return bytes;
}

it("DEMO-WALLET-PERSISTS-AND-SIGNS: a generated demo keypair round-trips through storage and its signMessage signatures verify against its public key; reset clears storage", () => {
  expect(DEMO_KEY_STORAGE).toBe("fructus.demoKey");

  // Fresh store: a keypair is generated AND persisted as its 64 secret-key bytes.
  const storage = memoryStorage();
  const keypair = loadOrCreateDemoKeypair(storage);
  const bytes = readPersistedBytes(storage);
  expect(Keypair.fromSecretKey(Uint8Array.from(bytes)).publicKey.toBase58()).toBe(keypair.publicKey.toBase58());

  // Second load: the same keypair comes back and the stored bytes are untouched.
  const storedBefore = storage.getItem(DEMO_KEY_STORAGE);
  const reloaded = loadOrCreateDemoKeypair(storage);
  expect(reloaded.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
  expect(storage.getItem(DEMO_KEY_STORAGE)).toBe(storedBefore);

  // Signing: the base58 detached ed25519 signature verifies against the public key.
  const message = "hello fructus";
  const messageBytes = new TextEncoder().encode(message);
  const signature = bs58.decode(signMessageBase58(keypair, message));
  // tweetnacl's ambient typing only declares `detached`; the runtime API is used here.
  const detached = nacl.sign.detached as unknown as {
    verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean;
  };
  expect(signature.length).toBe(64);
  expect(detached.verify(messageBytes, signature, keypair.publicKey.toBytes())).toBe(true);

  // Corrupted store (garbage JSON): load repairs it into a valid, usable entry.
  const corrupted = memoryStorage();
  corrupted.setItem(DEMO_KEY_STORAGE, "not-json{{{");
  const repaired = loadOrCreateDemoKeypair(corrupted);
  const repairedBytes = readPersistedBytes(corrupted);
  expect(Keypair.fromSecretKey(Uint8Array.from(repairedBytes)).publicKey.toBase58()).toBe(
    repaired.publicKey.toBase58(),
  );

  // Corrupted store (well-formed JSON, wrong length) is repaired too.
  const wrongShape = memoryStorage();
  wrongShape.setItem(DEMO_KEY_STORAGE, JSON.stringify([1, 2, 3]));
  const repaired2 = loadOrCreateDemoKeypair(wrongShape);
  const repairedBytes2 = readPersistedBytes(wrongShape);
  expect(Keypair.fromSecretKey(Uint8Array.from(repairedBytes2)).publicKey.toBase58()).toBe(
    repaired2.publicKey.toBase58(),
  );

  // Reset: storage cleared; the next load creates a fresh keypair.
  resetDemoKeypair(storage);
  expect(storage.getItem(DEMO_KEY_STORAGE)).toBeNull();
  const fresh = loadOrCreateDemoKeypair(storage);
  expect(fresh.publicKey.toBase58()).not.toBe(keypair.publicKey.toBase58());
  readPersistedBytes(storage);
});
