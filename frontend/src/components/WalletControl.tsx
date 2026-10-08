//! Connect / logout / bind wallet control. Stub.

import type { AuthState } from "../state/auth.js";
import type { ShellActions } from "./Shell.js";

export interface WalletControlProps {
  auth: AuthState;
  actions: Pick<ShellActions, "connect" | "disconnect" | "login" | "bind">;
}

export function WalletControl(_props: WalletControlProps) {
  return null;
}
