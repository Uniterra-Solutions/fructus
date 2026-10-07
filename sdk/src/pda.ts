//! PDA derivation mirroring the on-chain seed arrays in `lib.rs`. Each returns
//! the program-derived address and its bump, so the SDK can build the exact
//! account set an instruction expects.

import { PublicKey } from "@solana/web3.js";
import {
  OPERATOR_SEED,
  ORACLE_SEED,
  ORDER_BOOK_SEED,
  PERP_MARKET_SEED,
  POSITION_SEED,
  PROGRAM_ID,
  USER_COLLATERAL_SEED,
  VAULT_SEED,
} from "./constants.js";

export { PROGRAM_ID };

export interface Pda {
  address: PublicKey;
  bump: number;
}

/** Derive the singleton yield-oracle PDA: `[ORACLE_SEED]`. */
export function oraclePda(programId: PublicKey = PROGRAM_ID): Pda {
  const [address, bump] = PublicKey.findProgramAddressSync([ORACLE_SEED], programId);
  return { address, bump };
}

/** Derive the singleton perpetual-market PDA: `[PERP_MARKET_SEED]`. */
export function marketPda(programId: PublicKey = PROGRAM_ID): Pda {
  const [address, bump] = PublicKey.findProgramAddressSync([PERP_MARKET_SEED], programId);
  return { address, bump };
}

/** Derive the collateral-vault token-account PDA: `[VAULT_SEED]`. */
export function vaultPda(programId: PublicKey = PROGRAM_ID): Pda {
  const [address, bump] = PublicKey.findProgramAddressSync([VAULT_SEED], programId);
  return { address, bump };
}

/** Derive the per-market order-book PDA: `[ORDER_BOOK_SEED, market]`. */
export function orderBookPda(
  market: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): Pda {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [ORDER_BOOK_SEED, market.toBuffer()],
    programId,
  );
  return { address, bump };
}

/** Derive the per-`(market, user)` collateral-ledger PDA: `[USER_COLLATERAL_SEED, market, user]`. */
export function userCollateralPda(
  market: PublicKey,
  user: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): Pda {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [USER_COLLATERAL_SEED, market.toBuffer(), user.toBuffer()],
    programId,
  );
  return { address, bump };
}

/** Derive the per-`(market, user, side)` position PDA: `[POSITION_SEED, market, user, [side]]`. */
export function positionPda(
  market: PublicKey,
  user: PublicKey,
  side: number,
  programId: PublicKey = PROGRAM_ID,
): Pda {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [POSITION_SEED, market.toBuffer(), user.toBuffer(), Buffer.from([side & 0xff])],
    programId,
  );
  return { address, bump };
}

/** Derive the per-`(market, user)` operator record PDA: `[OPERATOR_SEED, market, user]`. */
export function operatorPda(
  market: PublicKey,
  user: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): Pda {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [OPERATOR_SEED, market.toBuffer(), user.toBuffer()],
    programId,
  );
  return { address, bump };
}
