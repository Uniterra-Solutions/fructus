//! Auth state machine (disconnected → connected → authed → bound).

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

/** Reduce one auth event into a fresh state object (never mutates `state`). */
export function authReducer(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case "connect":
      // A new wallet connection replaces the whole session, from any phase.
      return { phase: "connected", wallet: event.wallet, token: null, operator: null };
    case "login":
      // A fresh session token lands; any previous operator binding is gone.
      return { phase: "authed", wallet: event.wallet, token: event.token, operator: null };
    case "bind":
      // Binding applies only from authed.
      if (state.phase === "authed") {
        return { phase: "bound", wallet: state.wallet, token: state.token, operator: event.operator };
      }
      return { ...state };
    case "revoked":
      // Operator revoked: fall back to the plain authenticated session.
      if (state.phase === "bound") {
        return { phase: "authed", wallet: state.wallet, token: state.token, operator: null };
      }
      return { ...state };
    case "unauthorized":
      // A 401 clears the session but keeps the wallet: land in connected, never disconnected.
      if (state.phase === "authed" || state.phase === "bound") {
        return { phase: "connected", wallet: state.wallet, token: null, operator: null };
      }
      return { ...state };
    case "disconnect":
      return { ...initialAuthState };
  }
}
