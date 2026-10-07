//! Shared server-side error types. The API layer maps these onto the unified
//! envelope (`{ok:false,error:{code,message}}`) with the HTTP status carried on
//! the class.

/** Thrown by every stub path whose behavior lands in a later wave; maps to HTTP 501. */
export class NotImplementedError extends Error {
  readonly code = "not_implemented";
  readonly status = 501;
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}

/** Thrown when the operator hot key is unconfigured/unusable (`OPERATOR_KEYPAIR` unset or unreadable); maps to HTTP 501. */
export class OperatorUnconfiguredError extends Error {
  readonly code = "operator_unconfigured";
  readonly status = 501;
  constructor(detail: string) {
    super(`operator actions are unavailable: ${detail}`);
    this.name = "OperatorUnconfiguredError";
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

/** Thrown when a faucet request would exceed a 24 h cap; maps to HTTP 429. */
export class FaucetCapError extends Error {
  readonly code = "faucet_cap_exceeded";
  readonly status = 429;
  constructor(scope: "per-wallet" | "global", spent: bigint, drip: bigint, cap: bigint) {
    super(`${scope} faucet cap exceeded: ${spent} spent + ${drip} drip > ${cap} cap (24 h window)`);
    this.name = "FaucetCapError";
  }
}

/** Missing / invalid / expired credentials (SIWS verify, JWT gate); maps to HTTP 401. */
export class UnauthorizedError extends Error {
  readonly code = "unauthorized";
  readonly status = 401;
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Malformed request payloads; maps to HTTP 400. */
export class BadRequestError extends Error {
  readonly code = "bad_request";
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}
