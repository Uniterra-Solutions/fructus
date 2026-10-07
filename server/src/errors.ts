//! Shared server-side error types. The API layer maps these onto the unified
//! envelope (`{ok:false,error:{code,message}}`) in a later wave.

/** Thrown by every stub path whose behavior lands in a later wave; maps to HTTP 501. */
export class NotImplementedError extends Error {
  readonly code = "not_implemented";
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}

/** Thrown when the faucet is disabled or unconfigured (D15); maps to HTTP 404. */
export class FaucetDisabledError extends Error {
  readonly code = "faucet_disabled";
  readonly status = 404;
  constructor() {
    super("faucet is disabled (FAUCET_ENABLED / FAUCET_MINT / FAUCET_MINT_AUTHORITY_KEYPAIR not set)");
    this.name = "FaucetDisabledError";
  }
}
