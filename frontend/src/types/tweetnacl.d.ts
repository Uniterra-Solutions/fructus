/**
 * Minimal ambient declaration for `tweetnacl` (no official types ship with the
 * package): only the detached-ed25519 surface the demo wallet uses.
 */
declare module "tweetnacl" {
  interface DetachedSign {
    (message: Uint8Array, secretKey: Uint8Array): Uint8Array;
    verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean;
  }
  interface Nacl {
    sign: {
      detached: DetachedSign;
    };
  }
  const nacl: Nacl;
  export default nacl;
}
