//! `withdraw` — build a `withdraw_collateral` instruction (R-C1).

import { PublicKey } from "@solana/web3.js";
import type { ParsedArgs } from "../args.js";
import { flagStr } from "../args.js";
import type { TraderConfig } from "../env.js";
import { die } from "../errors.js";
import type { DryRunReport } from "../report.js";
import { instructionStep } from "../report.js";
import { parseUsize } from "../units.js";
import { deriveAta } from "../ata.js";
import { derived, emptyParts, placeholders, value } from "./common.js";
import {
  buildWithdrawCollateral,
  userCollateralPda,
  vaultPda,
} from "fructus-sdk/src/index.js";

export const usage = `withdraw <amount> [options]
  amount  collateral to withdraw (raw base units)
options:
  --mint <pubkey>      collateral mint (USDC)
  --ata <pubkey>       user ATA (default: derived from owner + mint)
  --market <pubkey>    market address
  --program-id <pubkey> program id
  --submit             sign + submit on-chain`;

export async function build(cfg: TraderConfig, args: ParsedArgs): Promise<DryRunReport> {
  const amountRaw =
    args.positionals[0] ?? flagStr(args.flags, "amount") ?? die("missing <amount>");
  const amount = parseUsize(amountRaw, "amount");

  const ataRaw = flagStr(args.flags, "ata");
  const userAta = ataRaw
    ? new PublicKey(ataRaw)
    : deriveAta(cfg.owner, cfg.collateralMint);

  const userCollateral = userCollateralPda(cfg.market, cfg.owner, cfg.programId).address;
  const vault = vaultPda(cfg.programId).address;

  const ix = buildWithdrawCollateral({
    user: cfg.owner,
    market: cfg.market,
    userCollateral,
    vault,
    userAta,
    collateralMint: cfg.collateralMint,
    // REQ-A2-3/D9: the equity gate reads Σ upnl via the market's index source.
    indexSource: cfg.indexSource,
    amount,
    programId: cfg.programId,
  });

  const parts = emptyParts();
  parts.derived.push(
    derived("user_collateral", userCollateral, "user_collateral"),
    derived("vault", vault, "vault"),
    derived("user_ata", userAta, "associated_token"),
  );
  parts.values.push(value("amount", amount));
  placeholders(cfg, parts);

  return {
    command: "withdraw",
    mode: cfg.network || cfg.submit ? "network" : "offline",
    programId: cfg.programId,
    market: cfg.market,
    owner: cfg.owner,
    instructions: [instructionStep("withdraw_collateral", ix)],
    ...parts,
  };
}
