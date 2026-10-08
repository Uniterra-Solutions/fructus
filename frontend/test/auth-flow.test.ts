//! RED acceptance test for product-v3 REQ-F-2 (auth state machine):
//! the disconnected→connected→authed→bound walk and the unauthorized fallback.
//!
//! RED on today's tree: `authReducer` is a stub returning the state unchanged —
//! the first non-trivial transition assertion fails behaviourally (connected
//! expected, disconnected received), never on a compile/import error.

import { expect, it } from "vitest";
import { authReducer, initialAuthState } from "../src/state/auth.js";

const WALLET = "WALLET11111111111111111111111111111111";
const TOKEN = "session-token-1";
const OPERATOR = "OPERATOR111111111111111111111111111111";

it("AUTH-STATE-FALLBACK: a 401 on an authed read clears the session and lands in connected (not disconnected), while success walks disconnected→connected→authed→bound", () => {
  expect(initialAuthState).toEqual({ phase: "disconnected", wallet: null, token: null, operator: null });

  // disconnected → connected: the wallet is known, no session yet.
  let state = authReducer(initialAuthState, { type: "connect", wallet: WALLET });
  expect(state).toEqual({ phase: "connected", wallet: WALLET, token: null, operator: null });

  // Hostile: bind before login must be a no-op (bind applies only from authed).
  expect(authReducer(state, { type: "bind", operator: OPERATOR })).toEqual(state);

  // Hostile: unauthorized while merely connected leaves the state unchanged.
  expect(authReducer(state, { type: "unauthorized" })).toEqual(state);

  // connected → authed: the session lands.
  state = authReducer(state, { type: "login", wallet: WALLET, token: TOKEN });
  expect(state).toEqual({ phase: "authed", wallet: WALLET, token: TOKEN, operator: null });

  // A 401 on an authed read: session cleared, wallet kept, phase connected.
  state = authReducer(state, { type: "unauthorized" });
  expect(state).toEqual({ phase: "connected", wallet: WALLET, token: null, operator: null });

  // Re-login, then bind → bound.
  state = authReducer(state, { type: "login", wallet: WALLET, token: TOKEN });
  expect(state).toEqual({ phase: "authed", wallet: WALLET, token: TOKEN, operator: null });
  state = authReducer(state, { type: "bind", operator: OPERATOR });
  expect(state).toEqual({ phase: "bound", wallet: WALLET, token: TOKEN, operator: OPERATOR });

  // A 401 on an authed read from bound: back to connected (never disconnected).
  state = authReducer(state, { type: "unauthorized" });
  expect(state).toEqual({ phase: "connected", wallet: WALLET, token: null, operator: null });

  // Disconnect: everything cleared.
  state = authReducer(state, { type: "disconnect" });
  expect(state).toEqual({ phase: "disconnected", wallet: null, token: null, operator: null });
});
