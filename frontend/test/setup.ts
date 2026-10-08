//! Vitest environment normalisation (test realm only — never shipped).
//!
//! jsdom hosts its window in a separate V8 realm, so `new TextEncoder()` hands
//! back typed arrays that fail tweetnacl's and web3.js' `instanceof
//! Uint8Array` checks (detached-signature verification via caller-provided
//! TextEncoder output breaks). Only when that mismatch is observable, wrap
//! `encode` so its output is a realm-local Uint8Array. In a browser (and in
//! plain Node) the probe passes and the global stays untouched.

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
