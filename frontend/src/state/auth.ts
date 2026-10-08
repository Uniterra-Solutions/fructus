//! Auth state machine (disconnected → connected → authed → bound).
//! Stub — product-v3 freeze.

export type AuthPhase = "disconnected" | "connected" | "authed" | "bound";

export interface AuthState {
  phase: AuthPhase;
  wallet: string | null;
  token: string | null;
  operator: string | null;
}

export const initialAuthState: AuthState = {
  phase: "disconnected",
  wallet: null,
  token: null,
  operator: null,
};

export type AuthEvent =
  | { type: "connect"; wallet: string }
  | { type: "disconnect" }
  | { type: "login"; wallet: string; token: string }
  | { type: "bind"; operator: string }
  | { type: "revoked" }
  | { type: "unauthorized" };

export function authReducer(state: AuthState, _event: AuthEvent): AuthState {
  return state;
}
