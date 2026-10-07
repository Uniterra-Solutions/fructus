//! Fructus trader SDK (issue #10).
//!
//! Mirrors the on-chain program: instruction builders + submit helpers for the
//! full instruction set, typed account decoders, and the pure funding / PnL /
//! mark / index mirrors locked by cross-language vector tests.

// Pure mirrors of the on-chain math.
export * from "./constants.js";
export * from "./encoding.js";
export * from "./exchange.js";
export * from "./funding.js";
export * from "./positions.js";
export * from "./orderbook.js";
export * from "./mark-index.js";

// Account layouts + decoders (R-SDK2).
export * from "./account/index.js";

// PDA derivation + instruction builders / submit helpers (R-SDK1).
export * from "./pda.js";
export * from "./instructions.js";

// Transaction v1 opt-in send path (issue #19).
export * from "./v1.js";

// Shared REST + WS DTO types for the server and the future frontend (REQ-C-3).
export * from "./api.js";
