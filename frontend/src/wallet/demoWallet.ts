//! In-page demo (burner) wallet: generated keypair persisted locally.
//! Stub — product-v3 freeze.

import { Keypair } from "@solana/web3.js";

export const DEMO_KEY_STORAGE = "fructus.demoKey";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Load the persisted demo keypair, creating + persisting one when absent (repairs corrupted entries). */
export function loadOrCreateDemoKeypair(_storage: StorageLike): Keypair {
  return Keypair.generate();
}

/** Remove the demo keypair from storage. */
export function resetDemoKeypair(_storage: StorageLike): void {
  /* stub */
}

/** Sign a UTF-8 message with the keypair; returns the base58 signature. */
export function signMessageBase58(_keypair: Keypair, _message: string): string {
  return "";
}
