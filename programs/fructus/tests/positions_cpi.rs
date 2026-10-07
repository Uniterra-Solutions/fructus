//! Bank-style CPI integration tests for the position lifecycle (issue #5).
//!
//! These tests run the real instruction handlers (`open_position`,
//! `close_position`, `settle_fill`, plus the amended `place_limit_order` /
//! `place_market_order` / `crank`) against a local bank built with
//! `solana-program-test` — the same harness pattern as `collateral_cpi.rs`
//! (the Fructus program loaded as a compiled SBF binary, SPL Token
//! in-process, a fake jitoSOL stake-pool account as the market-bound index
//! source). The environment wires four funded parties (A–D), each with minted
//! USDC, a `UserCollateral` ledger, the collateral vault, and the `OrderBook`.
//!
//! The scenarios lock the acceptance criteria A-4..A-11, A-13b, A-15, A-20
//! (`.plan/20260820/position-lifecycle/acceptance.md`): taker-inline +
//! maker-deferred settlement, ledger-only reserved margin, atomic failure
//! semantics, and the end-to-end open/close of both sides.
//!
//! Side encoding (design §5): `0` = Long/Bid, `1` = Short/Ask. A market order
//! is signalled by `price == 0`. Fructus errors surface as `Custom` codes
//! (matched via `assert_anchor_error`); the ownership/format errors
//! (`InvalidAccountData`) surface as the raw system `InstructionError`.

use std::path::{Path, PathBuf};
use std::rc::Rc;

use proptest::prelude::*;

use anchor_lang::{AccountDeserialize, Discriminator, InstructionData};
use fructus::constants::{
    ORDER_BOOK_SEED, PERP_MARKET_SEED, POSITION_SEED, USER_COLLATERAL_SEED, VAULT_SEED,
};
use fructus::error::FructusError;
use fructus::exchange::STAKE_POOL_PROGRAM_ID;
use fructus::positions::PositionSide;
use fructus::state::{OrderBook, PerpMarket, Position, UserCollateral};
use solana_account::{Account, AccountSharedData};
use solana_instruction::error::InstructionError as SolanaInstructionError;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_program_pack::Pack;
use solana_program_test::{processor, BanksClientError, ProgramTest, ProgramTestContext};
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use spl_associated_token_account::get_associated_token_address;
use spl_token::solana_program::program_option::COption;
use spl_token::state::{Account as TokenAccount, AccountState, Mint};

/// USDC collateral mint decimals, matching `constants::USDC_DECIMALS`.
const DECIMALS: u8 = 6;
/// Initial minted amount per user: 1,000,000 USDC (6 decimals).
const MINT_AMOUNT: u64 = 1_000_000_000_000;
/// Lamports used to fund the pre-created accounts (mint, users).
const FUNDING_LAMPORTS: u64 = 10_000_000_000;
/// Notional of one fill-sized order, in USDC microunits (1 USDC).
const SIZE: u64 = 1_000_000;
/// Initial margin in basis points (10x leverage): margin == ceil(notional / 10).
const INITIAL_MARGIN_BPS: u16 = 1_000;
/// Position/open side encodings: 0 = Long/Bid, 1 = Short/Ask.
const LONG: u8 = 0;
const SHORT: u8 = 1;
/// Fake stake-pool `total_lamports` used for the base snapshot (rate 1.0).
const BASE_TOTAL_LAMPORTS: u64 = 10_000_000_000_000;
/// Fake stake-pool `pool_token_supply` (rate 1.0 when `total_lamports` matches).
const BASE_POOL_TOKEN_SUPPLY: u64 = 10_000_000_000_000;
/// Maintenance margin in basis points: the market is initialized with `500`
/// (half the initial `1_000`), so the account-level liquidation trigger fires
/// once unrealized losses push equity below `Σ m(n_i, 500)`.
const MAINTENANCE_MARGIN_BPS: u16 = 500;
/// Liquidator penalty share of the released collateral, in basis points —
/// mirrors `constants::LIQUIDATION_PENALTY_BPS`.
const LIQUIDATION_PENALTY_BPS: u16 = 500;

/// The system program id is the all-zero pubkey (`11111111111111111111111111111111`).
fn system_program_id() -> Pubkey {
    Pubkey::default()
}

/// Locate the compiled Fructus SBF binary (`cargo build-sbf` / `anchor build`
/// output), returning `None` when it has not been built yet.
fn find_fructus_so() -> Option<PathBuf> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        manifest.join("../../target/sbpf-solana-solana/release/fructus.so"),
        manifest.join("../../target/deploy/fructus.so"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

/// Bytes for a fake SPL Stake Pool account, enough for `read_stake_pool`'s
/// validation to succeed: the `StakePool` account-type discriminator (byte 0)
/// plus non-zero `total_lamports` / `pool_token_supply` at the canonical
/// offsets (258 / 266, with the `account_type` prefix — do not "fix" to 257/265).
fn fake_stake_pool_data() -> Vec<u8> {
    let mut data = vec![0u8; 274];
    data[0] = 1; // AccountType::StakePool
    data[258..266].copy_from_slice(&BASE_TOTAL_LAMPORTS.to_le_bytes()); // total_lamports
    data[266..274].copy_from_slice(&BASE_POOL_TOKEN_SUPPLY.to_le_bytes()); // pool_token_supply
    data
}

/// Serialized, initialized SPL Token `Account` state for a pre-funded account.
///
/// Used to seed user associated token accounts directly in the bank (the
/// modern ATA program unconditionally initializes the Token-2022
/// `ImmutableOwner` extension, which plain Tokenkeg rejects).
fn token_account_data(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let state = TokenAccount {
        mint: *mint,
        owner: *owner,
        amount,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    };
    let mut data = vec![0u8; TokenAccount::LEN];
    TokenAccount::pack(state, &mut data).expect("pack token account");
    data
}

/// One `(market, user)` party: signer keypair (shared via `Rc` so a `User` is
/// cheaply cloneable — `solana_keypair::Keypair` is not `Clone`) plus the
/// derived PDAs it trades with.
#[derive(Clone)]
struct User {
    keypair: Rc<Keypair>,
    ata: Pubkey,
    user_collateral: Pubkey,
    long: Pubkey,
    short: Pubkey,
}

impl User {
    fn position(&self, side: u8) -> Pubkey {
        if side == LONG {
            self.long
        } else {
            self.short
        }
    }
}

/// A fully-wired test environment: program + SPL programs loaded, collateral
/// mint created, four funded users (A–D) each with a funded ATA, the
/// `PerpMarket`, the `OrderBook`, the collateral vault, and a deposited
/// `UserCollateral` ledger per user.
struct Env {
    ctx: ProgramTestContext,
    market: Pubkey,
    vault: Pubkey,
    mint: Pubkey,
    order_book: Pubkey,
    stake_pool: Pubkey,
    /// A second stake-pool-valid account whose key differs from
    /// `PerpMarket.index_source` — used by `index_source_must_be_market_binding`.
    wrong_stake_pool: Pubkey,
    a: User,
    b: User,
    c: User,
    d: User,
}

async fn setup() -> Option<Env> {
    let program_id = fructus::ID;

    // Run the Fructus program from its SBF binary (Anchor 1.x CPI is SBF-only).
    let so = match find_fructus_so() {
        Some(so) => so,
        None => {
            eprintln!(
                "skipping positions CPI test: fructus.so not found; \
                 run `cargo build-sbf` (or `anchor build`) first"
            );
            return None;
        }
    };
    let so_bytes = std::fs::read(so).expect("read fructus.so");
    let mut pt = ProgramTest::default();
    pt.add_account(
        program_id,
        Account {
            lamports: solana_rent::Rent::default()
                .minimum_balance(so_bytes.len())
                .max(1),
            data: so_bytes,
            owner: solana_sdk_ids::bpf_loader::id(),
            executable: true,
            rent_epoch: 0,
        },
    );
    pt.add_program(
        "spl_token",
        spl_token::id(),
        processor!(spl_token::processor::Processor::process),
    );

    // Fake index-source (jitoSOL stake pool) account, owned by the stake-pool
    // program, so `initialize_market` accepts it as `market.index_source`.
    let stake_pool = Pubkey::new_from_array([9u8; 32]);
    pt.add_account(
        stake_pool,
        Account {
            lamports: FUNDING_LAMPORTS,
            data: fake_stake_pool_data(),
            owner: STAKE_POOL_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    // A second stake-pool-valid account (different key) for the A-13b binding test.
    let wrong_stake_pool = Pubkey::new_from_array([8u8; 32]);
    pt.add_account(
        wrong_stake_pool,
        Account {
            lamports: FUNDING_LAMPORTS,
            data: fake_stake_pool_data(),
            owner: STAKE_POOL_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    );

    // Collateral mint (system-created + token-owned, empty 82-byte state).
    let mint = Keypair::new();
    pt.add_account(
        mint.pubkey(),
        Account {
            lamports: FUNDING_LAMPORTS,
            data: vec![0u8; Mint::LEN],
            owner: spl_token::id(),
            executable: false,
            rent_epoch: 0,
        },
    );

    // Four funded users + their (empty) ATAs, seeded directly in the bank.
    let mut user_seeds = Vec::with_capacity(4);
    for _ in 0..4 {
        let user = Keypair::new();
        pt.add_account(
            user.pubkey(),
            Account {
                lamports: FUNDING_LAMPORTS,
                data: vec![],
                owner: system_program_id(),
                executable: false,
                rent_epoch: 0,
            },
        );
        let ata = get_associated_token_address(&user.pubkey(), &mint.pubkey());
        pt.add_account(
            ata,
            Account {
                lamports: FUNDING_LAMPORTS,
                data: token_account_data(&mint.pubkey(), &user.pubkey(), 0),
                owner: spl_token::id(),
                executable: false,
                rent_epoch: 0,
            },
        );
        user_seeds.push((user, ata));
    }

    // PDAs are pure `find_program_address` derivations, computed before the
    // bank starts so the order-book account can be seeded into it.
    let market = Pubkey::find_program_address(&[PERP_MARKET_SEED], &program_id).0;
    let vault = Pubkey::find_program_address(&[VAULT_SEED], &program_id).0;

    // The `OrderBook` account (`8 + LEN = 6_240` B) is sized under the runtime's
    // per-transaction account-growth cap (MAX_PERMITTED_DATA_INCREASE = 10 KiB),
    // so the on-chain `initialize_order_book` CPI `create_account` now fits.
    // We still seed a fully-initialized account directly in the bank — faster
    // than a CPI round-trip and byte-identical to what the handler would write
    // (discriminator + zeroed struct with `market`/`bump` set). The bank
    // `set_account` path avoids the 10 KiB inner-CPI allocation entirely.
    let (order_book, order_book_bump) =
        Pubkey::find_program_address(&[ORDER_BOOK_SEED, market.as_ref()], &program_id);
    pt.add_account(
        order_book,
        Account {
            lamports: solana_rent::Rent::default().minimum_balance(8 + OrderBook::LEN),
            data: initialized_order_book_data(&market, order_book_bump),
            owner: program_id,
            executable: false,
            rent_epoch: 0,
        },
    );

    let mut ctx = pt.start_with_context().await;

    // 1. Initialize the mint (authority = payer).
    let ix = spl_token::instruction::initialize_mint(
        &spl_token::id(),
        &mint.pubkey(),
        &ctx.payer.pubkey(),
        None,
        DECIMALS,
    )
    .expect("initialize_mint builds");
    submit(&mut ctx, vec![ix], &[])
        .await
        .expect("initialize_mint");

    // 2. Mint collateral to each user's ATA (mint authority = payer).
    for (_user, ata) in &user_seeds {
        let ix = spl_token::instruction::mint_to(
            &spl_token::id(),
            &mint.pubkey(),
            ata,
            &ctx.payer.pubkey(),
            &[],
            MINT_AMOUNT,
        )
        .expect("mint_to builds");
        submit(&mut ctx, vec![ix], &[]).await.expect("mint_to");
    }

    // 3. Initialize the perpetual market (binds the vault PDA + collateral mint).
    let data = fructus::instruction::InitializeMarket {
        collateral_mint: mint.pubkey(),
        funding_k: 100_000,
        max_funding: 10_000,
        funding_epoch_slots: 1_000,
        initial_margin_bps: INITIAL_MARGIN_BPS,
        maintenance_margin_bps: 500,
    }
    .data();
    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(market, false),                     // market (init)
            AccountMeta::new_readonly(stake_pool, false),        // index_source
            AccountMeta::new_readonly(ctx.payer.pubkey(), true), // authority (signer)
            AccountMeta::new(ctx.payer.pubkey(), true),          // payer (signer, mut)
            AccountMeta::new_readonly(system_program_id(), false), // system_program
        ],
        data,
    };
    submit(&mut ctx, vec![ix], &[])
        .await
        .expect("initialize_market");

    let mut env = Env {
        ctx,
        market,
        vault,
        mint: mint.pubkey(),
        order_book,
        stake_pool,
        wrong_stake_pool,
        a: make_user(&market, user_seeds.remove(0)),
        b: make_user(&market, user_seeds.remove(0)),
        c: make_user(&market, user_seeds.remove(0)),
        d: make_user(&market, user_seeds.remove(0)),
    };

    // 4. Collateral vault (authority-gated) and a deposited ledger per user —
    //    every test starts from the same fully-wired state (the order book was
    //    seeded in the bank above).
    initialize_vault(&mut env)
        .await
        .expect("initialize_collateral_vault");
    for user in [env.a.clone(), env.b.clone(), env.c.clone(), env.d.clone()] {
        deposit(&mut env, &user, MINT_AMOUNT)
            .await
            .expect("deposit_collateral");
    }

    Some(env)
}

/// Derive a `User`'s three PDAs from the market key.
fn make_user(market: &Pubkey, (keypair, ata): (Keypair, Pubkey)) -> User {
    let pubkey = keypair.pubkey();
    User {
        keypair: Rc::new(keypair),
        ata,
        user_collateral: user_collateral_pda(market, &pubkey),
        long: position_pda(market, &pubkey, LONG),
        short: position_pda(market, &pubkey, SHORT),
    }
}

fn position_pda(market: &Pubkey, user: &Pubkey, side: u8) -> Pubkey {
    Pubkey::find_program_address(
        &[POSITION_SEED, market.as_ref(), user.as_ref(), &[side]],
        &fructus::ID,
    )
    .0
}

fn user_collateral_pda(market: &Pubkey, user: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[USER_COLLATERAL_SEED, market.as_ref(), user.as_ref()],
        &fructus::ID,
    )
    .0
}

async fn submit(
    ctx: &mut ProgramTestContext,
    ixs: Vec<Instruction>,
    extra_signers: &[&Keypair],
) -> Result<(), BanksClientError> {
    let blockhash = ctx.get_new_latest_blockhash().await.unwrap();
    let mut signers: Vec<&Keypair> = Vec::with_capacity(extra_signers.len() + 1);
    if !extra_signers
        .iter()
        .any(|k| k.pubkey() == ctx.payer.pubkey())
    {
        signers.push(&ctx.payer);
    }
    signers.extend_from_slice(extra_signers);
    let tx = Transaction::new_signed_with_payer(
        &ixs,
        Some(&ctx.payer.pubkey()),
        signers.as_slice(),
        blockhash,
    );
    ctx.banks_client.process_transaction(tx).await
}

/// Assert a transaction failed with the given Anchor error code.
fn assert_anchor_error(result: Result<(), BanksClientError>, expected: FructusError) {
    let code = u32::from(expected);
    match result {
        Ok(()) => panic!("expected anchor error (code {code}), got Ok"),
        Err(BanksClientError::TransactionError(TransactionError::InstructionError(
            _,
            SolanaInstructionError::Custom(c),
        ))) => assert_eq!(c, code, "wrong anchor error code"),
        Err(e) => panic!("expected anchor error (code {code}), got {e:?}"),
    }
}

/// Assert a transaction failed with a raw system instruction error (used for
/// `InvalidAccountData` / `InvalidInstructionData`, which Fructus surfaces
/// directly rather than through a `Custom` code).
fn assert_instruction_error(
    result: Result<(), BanksClientError>,
    expected: SolanaInstructionError,
) {
    match result {
        Ok(()) => panic!("expected instruction error {expected:?}, got Ok"),
        Err(BanksClientError::TransactionError(TransactionError::InstructionError(_, e))) => {
            assert_eq!(e, expected, "wrong instruction error")
        }
        Err(e) => panic!("expected instruction error {expected:?}, got {e:?}"),
    }
}

// --- Instruction builders (account order matches the `#[derive(Accounts)]` ---
// --- structs in lib.rs) ------------------------------------------------

/// Account data for a fully-initialized `OrderBook`: the 8-byte Anchor
/// discriminator followed by the raw zero-copy struct bytes (the on-chain
/// `load_init()` view). Header fields match what `initialize_order_book`
/// writes; the arrays are zeroed, so `next_seq == 0` and the event ring is
/// empty — a fresh, handler-identical book.
fn initialized_order_book_data(market: &Pubkey, bump: u8) -> Vec<u8> {
    let mut book = OrderBook::default();
    book.market = *market;
    book.bump = bump;
    let mut data = Vec::with_capacity(8 + OrderBook::LEN);
    data.extend_from_slice(<OrderBook as Discriminator>::DISCRIMINATOR);
    data.extend_from_slice(bytemuck::bytes_of(&book));
    data
}

async fn initialize_vault(env: &mut Env) -> Result<(), BanksClientError> {
    let data = fructus::instruction::InitializeCollateralVault.data();
    let authority = env.ctx.payer.pubkey();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            AccountMeta::new_readonly(env.market, false), // market
            AccountMeta::new_readonly(authority, true),   // authority (signer)
            AccountMeta::new(authority, true),            // payer (signer, mut)
            AccountMeta::new(env.vault, false),           // vault (mut)
            AccountMeta::new_readonly(env.mint, false),   // collateral_mint
            AccountMeta::new_readonly(system_program_id(), false), // system_program
            AccountMeta::new_readonly(spl_token::id(), false), // token_program
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[]).await
}

async fn deposit(env: &mut Env, user: &User, amount: u64) -> Result<(), BanksClientError> {
    let data = fructus::instruction::DepositCollateral { amount }.data();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            AccountMeta::new(user.keypair.pubkey(), true), // user (signer, mut)
            AccountMeta::new(env.market, false),           // market (mut)
            AccountMeta::new(user.user_collateral, false), // user_collateral (mut)
            AccountMeta::new(env.vault, false),            // vault (mut)
            AccountMeta::new(user.ata, false),             // user_ata (mut)
            AccountMeta::new_readonly(env.mint, false),    // collateral_mint
            AccountMeta::new_readonly(system_program_id(), false), // system_program
            AccountMeta::new_readonly(spl_token::id(), false), // token_program
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[user.keypair.as_ref()]).await
}

/// `withdraw_collateral(amount)` — the v2 account set (PRD Appendix): user (S),
/// market (mut), user_collateral (mut), vault (mut), user_ata (mut),
/// collateral_mint, index_source, position_long, position_short, token_program
/// (the two Position PDAs feed the Σ upnl equity gate; pristine sides read as
/// zero).
async fn withdraw(env: &mut Env, user: &User, amount: u64) -> Result<(), BanksClientError> {
    let data = fructus::instruction::WithdrawCollateral { amount }.data();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            AccountMeta::new_readonly(user.keypair.pubkey(), true), // user (signer)
            AccountMeta::new(env.market, false),                    // market (mut)
            AccountMeta::new(user.user_collateral, false),          // user_collateral (mut)
            AccountMeta::new(env.vault, false),                     // vault (mut)
            AccountMeta::new(user.ata, false),                      // user_ata (mut)
            AccountMeta::new_readonly(env.mint, false),             // collateral_mint
            AccountMeta::new_readonly(env.stake_pool, false),       // index_source
            AccountMeta::new_readonly(user.long, false),            // position_long
            AccountMeta::new_readonly(user.short, false),           // position_short
            AccountMeta::new_readonly(spl_token::id(), false),      // token_program
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[user.keypair.as_ref()]).await
}

/// `open_position(side, size, price)`: `price == 0` is a market (IOC) order.
/// `index_source: None` uses the market-bound stake pool; `Some(k)` supplies a
/// caller-chosen account (used to test the `address = market.index_source`
/// binding).
async fn open_position(
    env: &mut Env,
    user: &User,
    side: u8,
    size: u64,
    price: u64,
    index_source: Option<&Pubkey>,
) -> Result<(), BanksClientError> {
    let data = fructus::instruction::OpenPosition { side, size, price }.data();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            AccountMeta::new(user.keypair.pubkey(), true), // owner (signer, mut)
            AccountMeta::new_readonly(env.market, false),  // market
            AccountMeta::new(env.order_book, false),       // order_book (mut)
            AccountMeta::new_readonly(*index_source.unwrap_or(&env.stake_pool), false), // index_source
            AccountMeta::new(user.position(side), false), // position (mut)
            AccountMeta::new(user.user_collateral, false), // user_collateral (mut)
            AccountMeta::new_readonly(system_program_id(), false), // system_program
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[user.keypair.as_ref()]).await
}

/// `close_position(side, size)` places a market-IOC order on the opposite side.
async fn close_position(
    env: &mut Env,
    user: &User,
    side: u8,
    size: u64,
    index_source: Option<&Pubkey>,
) -> Result<(), BanksClientError> {
    let data = fructus::instruction::ClosePosition { side, size }.data();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            AccountMeta::new_readonly(user.keypair.pubkey(), true), // owner (signer)
            AccountMeta::new_readonly(env.market, false),           // market
            AccountMeta::new(env.order_book, false),                // order_book (mut)
            AccountMeta::new_readonly(*index_source.unwrap_or(&env.stake_pool), false), // index_source
            AccountMeta::new(user.position(side), false), // position (mut)
            AccountMeta::new(user.user_collateral, false), // user_collateral (mut)
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[user.keypair.as_ref()]).await
}

/// `settle_fill(seq)` — permissionless; the fee payer (`ctx.payer`) is the
/// caller and pays the lazy rent for a first-time maker `Position`.
async fn settle_fill(
    env: &mut Env,
    seq: u64,
    position: &Pubkey,
    user_collateral: &Pubkey,
) -> Result<(), BanksClientError> {
    let data = fructus::instruction::SettleFill { seq }.data();
    let payer = env.ctx.payer.pubkey();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            AccountMeta::new_readonly(env.market, false), // market
            AccountMeta::new(env.order_book, false),      // order_book (mut)
            AccountMeta::new(*position, false),           // position (mut)
            AccountMeta::new(*user_collateral, false),    // user_collateral (mut)
            AccountMeta::new(payer, true),                // payer (signer, mut)
            AccountMeta::new_readonly(system_program_id(), false), // system_program
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[]).await
}

async fn place_limit_order(
    env: &mut Env,
    user: &User,
    side: u8,
    price: u64,
    size: u64,
    index_source: Option<&Pubkey>,
) -> Result<(), BanksClientError> {
    let data = fructus::instruction::PlaceLimitOrder { side, price, size }.data();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            AccountMeta::new(env.order_book, false), // order_book (mut)
            AccountMeta::new_readonly(env.market, false), // market
            AccountMeta::new_readonly(*index_source.unwrap_or(&env.stake_pool), false), // index_source
            AccountMeta::new_readonly(user.keypair.pubkey(), true), // owner (signer)
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[user.keypair.as_ref()]).await
}

async fn place_market_order(
    env: &mut Env,
    user: &User,
    side: u8,
    size: u64,
    index_source: Option<&Pubkey>,
) -> Result<(), BanksClientError> {
    let data = fructus::instruction::PlaceMarketOrder { side, size }.data();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            AccountMeta::new(env.order_book, false), // order_book (mut)
            AccountMeta::new_readonly(env.market, false), // market
            AccountMeta::new_readonly(*index_source.unwrap_or(&env.stake_pool), false), // index_source
            AccountMeta::new_readonly(user.keypair.pubkey(), true), // owner (signer)
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[user.keypair.as_ref()]).await
}

async fn crank(env: &mut Env, index_source: Option<&Pubkey>) -> Result<(), BanksClientError> {
    let data = fructus::instruction::Crank.data();
    let cranker = env.ctx.payer.pubkey();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            AccountMeta::new(env.order_book, false), // order_book (mut)
            AccountMeta::new_readonly(env.market, false), // market
            AccountMeta::new_readonly(*index_source.unwrap_or(&env.stake_pool), false), // index_source
            AccountMeta::new_readonly(cranker, true), // cranker (signer)
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[]).await
}

/// The opposite book side byte (`0` = Long/Bid `1` = Short/Ask).
fn opposite(side: u8) -> u8 {
    if side == LONG {
        SHORT
    } else {
        LONG
    }
}

/// Open one maker-side position for `maker`: rest a non-crossing `side` limit
/// order at `price`, have `taker` market-take it (the opposite side), then
/// settle the maker's deferred fill at ring `seq`. The fill-time index
/// snapshot is the stake pool's *current* rate — set it before calling so the
/// maker's entry basis is deterministic.
async fn open_maker_position(
    env: &mut Env,
    maker: &User,
    taker: &User,
    side: u8,
    size: u64,
    price: u64,
    seq: u64,
) -> Result<(), BanksClientError> {
    open_position(env, maker, side, size, price, None).await?;
    open_position(env, taker, opposite(side), size, 0, None).await?;
    settle_fill(env, seq, &maker.position(side), &maker.user_collateral).await
}

/// `liquidate(side, amount)` — the ACCOUNT-level liquidation (product-v2 A2,
/// D8): market (mut), position (mut), other_position (the opposite side's
/// Position PDA, readonly), user_collateral (mut), order_book (mut),
/// index_source, liquidator (signer), liquidator_collateral (mut). The order
/// matches the `Liquidate` Accounts struct in lib.rs and the PRD Appendix.
async fn liquidate(
    env: &mut Env,
    victim: &User,
    liquidator: &User,
    side: u8,
    amount: u64,
) -> Result<(), BanksClientError> {
    let data = fructus::instruction::Liquidate { side, amount }.data();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            AccountMeta::new(env.market, false),            // market (mut)
            AccountMeta::new(victim.position(side), false), // position (mut)
            AccountMeta::new_readonly(victim.position(opposite(side)), false), // other_position
            AccountMeta::new(victim.user_collateral, false), // user_collateral (mut)
            AccountMeta::new(env.order_book, false),        // order_book (mut)
            AccountMeta::new_readonly(env.stake_pool, false), // index_source
            AccountMeta::new_readonly(liquidator.keypair.pubkey(), true), // liquidator (signer)
            AccountMeta::new(liquidator.user_collateral, false), // liquidator_collateral (mut)
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[liquidator.keypair.as_ref()]).await
}

/// `settle_funding()` — permissionless; market (mut), position (mut),
/// user_collateral (mut), order_book (mut), index_source.
async fn settle_funding(
    env: &mut Env,
    position: &Pubkey,
    user_collateral: &Pubkey,
) -> Result<(), BanksClientError> {
    let data = fructus::instruction::SettleFunding.data();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            AccountMeta::new(env.market, false),              // market (mut)
            AccountMeta::new(*position, false),               // position (mut)
            AccountMeta::new(*user_collateral, false),        // user_collateral (mut)
            AccountMeta::new(env.order_book, false),          // order_book (mut)
            AccountMeta::new_readonly(env.stake_pool, false), // index_source
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[]).await
}

// --- Bank-state readers ------------------------------------------------

async fn position_state(env: &Env, key: &Pubkey) -> Option<Position> {
    let account = env.ctx.banks_client.get_account(*key).await.unwrap()?;
    let mut data: &[u8] = &account.data;
    Position::try_deserialize(&mut data).ok()
}

async fn user_collateral_state(env: &Env, key: &Pubkey) -> Option<UserCollateral> {
    let account = env.ctx.banks_client.get_account(*key).await.unwrap()?;
    let mut data: &[u8] = &account.data;
    UserCollateral::try_deserialize(&mut data).ok()
}

async fn ata_balance(env: &Env, ata: &Pubkey) -> u64 {
    let account = env
        .ctx
        .banks_client
        .get_account(*ata)
        .await
        .unwrap()
        .expect("ATA exists");
    TokenAccount::unpack(&account.data).unwrap().amount
}

async fn vault_balance(env: &Env) -> u64 {
    let account = env
        .ctx
        .banks_client
        .get_account(env.vault)
        .await
        .unwrap()
        .expect("vault exists");
    TokenAccount::unpack(&account.data).unwrap().amount
}

/// Raw account bytes (or `None` when the account does not exist) — used for
/// the byte-identity assertions on accounts a scenario must NOT touch.
async fn account_data(env: &Env, key: &Pubkey) -> Option<Vec<u8>> {
    env.ctx
        .banks_client
        .get_account(*key)
        .await
        .unwrap()
        .map(|account| account.data)
}

/// The on-chain `PerpMarket` state (used for `pnl_pool` assertions).
async fn market_state(env: &Env) -> PerpMarket {
    let account = env
        .ctx
        .banks_client
        .get_account(env.market)
        .await
        .unwrap()
        .expect("market exists");
    let mut data: &[u8] = &account.data;
    PerpMarket::try_deserialize(&mut data).expect("market deserializes")
}

/// The live fake stake-pool rate snapshot `(total_lamports,
/// pool_token_supply)` — the same bytes `read_stake_pool` reads on-chain
/// (offsets 258/266, with the `account_type` prefix).
async fn stake_pool_rate(env: &Env) -> (u64, u64) {
    let account = env
        .ctx
        .banks_client
        .get_account(env.stake_pool)
        .await
        .unwrap()
        .expect("stake pool exists");
    (read_u64(&account.data, 258), read_u64(&account.data, 266))
}

/// `margin_required(notional, bps)` mirror (CEILING `(notional × bps + 9_999)
/// / 10_000`) for an arbitrary ratio — the maintenance ratio as well as the
/// market's initial one.
fn margin_required_bps(notional: u64, bps: u16) -> u64 {
    (notional as u128 * bps as u128).div_ceil(10_000) as u64
}

/// Account equity (`deposited + Σ upnl`, signed) — the account-level health
/// numerator the handler gate must compute (REQ-A2-1).
fn account_equity(deposited: u64, pnl_sum: i128) -> i128 {
    (deposited as i128).saturating_add(pnl_sum)
}

/// The account-level margin requirement `Σ_side margin_required(n_side, bps)`
/// (cross margin, NO netting — REQ-A2-1).
fn account_margin_required(n_long: u64, n_short: u64, bps: u16) -> u64 {
    margin_required_bps(n_long, bps) + margin_required_bps(n_short, bps)
}

/// The ACCOUNT-liquidatable predicate the `liquidate` gate applies
/// (REQ-A2-1/D8): no exposure ⇒ false, else `equity < Σ m(n_i, bps)` strict.
/// Computed from the pristine pure pieces (`positions::pnl` + the ceiling
/// formula) — the stubbed `liquidation::account_liquidatable` is what the
/// handler gate must implement, so the scenarios assert against THIS inline
/// mirror instead.
fn account_is_liquidatable(deposited: u64, pnl_sum: i128, n_long: u64, n_short: u64) -> bool {
    n_long + n_short > 0
        && account_equity(deposited, pnl_sum)
            < account_margin_required(n_long, n_short, MAINTENANCE_MARGIN_BPS) as i128
}

/// Signed unrealized PnL of one position against `rate` (a live index
/// snapshot) — the exact `positions::pnl` call the handlers make.
fn pnl_of(position: &Position, rate: (u64, u64)) -> i128 {
    let side = if position.side == LONG {
        PositionSide::Long
    } else {
        PositionSide::Short
    };
    fructus::positions::pnl(
        position.entry_n_sum,
        position.entry_d_sum,
        rate.0,
        rate.1,
        position.notional,
        side,
    )
    .expect("pnl is total in the bank band")
}

/// The liquidator penalty on `released` collateral at
/// `LIQUIDATION_PENALTY_BPS` — the exact CEILING formula
/// `liquidation::liquidation_penalty` implements (R-L3).
fn liquidation_penalty(released: u64) -> u64 {
    (released as u128 * LIQUIDATION_PENALTY_BPS as u128).div_ceil(10_000) as u64
}

/// `margin_required(notional)` mirror of `positions::margin_required` for the
/// market's `INITIAL_MARGIN_BPS`: CEILING `(notional * bps + 9_999) / 10_000`.
fn margin_required(notional: u64) -> u64 {
    (notional as u128 * INITIAL_MARGIN_BPS as u128).div_ceil(10_000) as u64
}

// --- Raw byte views of the zero-copy OrderBook account ---
//
// The on-chain `OrderBook` is an Anchor zero-copy account: `[8-byte
// discriminator][OrderBook payload]`, with the payload laid out as
// `header (88) + bids (16×64) + asks (16×64) + events (32×112) +
// observations (16×32)`. The readers below slice the raw account bytes at the
// documented offsets (AGENTS.md byte-level discipline; `state.rs` pins
// `OrderBook::LEN == 6_232` and the per-type sizes).

const OB_BIDS_OFF: usize = 8 + 88; // discriminator + header
const OB_ASKS_OFF: usize = OB_BIDS_OFF + 16 * 64;
const OB_EVENTS_OFF: usize = OB_ASKS_OFF + 16 * 64;

/// A single resting-order slot, decoded from the `bids`/`asks` arrays.
#[derive(Debug, Clone)]
struct OrderView {
    active: u8,
    owner: Pubkey,
    price: u64,
    size: u64,
    seq: u64,
}

/// One ring slot of the event queue, decoded from the `events` array.
#[derive(Debug, Clone)]
struct EventView {
    seq: u64,
    kind: u8,
    settled: u8,
    side: u8,
    owner: Pubkey,
    counterparty: Pubkey,
    price: u64,
    size: u64,
    entry_total_lamports: u64,
    entry_pool_token_supply: u64,
}

/// Decoded view of the whole `OrderBook` account (cursors, resting orders,
/// event ring) for assertions.
#[derive(Debug, Clone)]
struct BookView {
    best_bid: u64,
    best_ask: u64,
    read_cursor: u64,
    write_cursor: u64,
    bids: Vec<OrderView>,
    asks: Vec<OrderView>,
    events: Vec<EventView>,
}

impl BookView {
    /// The event currently occupying ring `slot` (in ring order, not seq).
    fn event(&self, slot: usize) -> &EventView {
        &self.events[slot]
    }
    fn resting_bids(&self) -> usize {
        self.bids.iter().filter(|o| o.active != 0).count()
    }
    fn resting_asks(&self) -> usize {
        self.asks.iter().filter(|o| o.active != 0).count()
    }
}

async fn book_view(env: &Env) -> BookView {
    let account = env
        .ctx
        .banks_client
        .get_account(env.order_book)
        .await
        .unwrap()
        .expect("order book exists");
    let data = &account.data;
    let mut bids = Vec::with_capacity(16);
    let mut asks = Vec::with_capacity(16);
    let mut events = Vec::with_capacity(32);
    for i in 0..16 {
        bids.push(read_order(data, OB_BIDS_OFF + i * 64));
        asks.push(read_order(data, OB_ASKS_OFF + i * 64));
    }
    for i in 0..32 {
        events.push(read_event(data, OB_EVENTS_OFF + i * 112));
    }
    BookView {
        best_bid: read_u64(data, 16),
        best_ask: read_u64(data, 24),
        read_cursor: read_u64(data, 32),
        write_cursor: read_u64(data, 40),
        bids,
        asks,
        events,
    }
}

fn read_order(data: &[u8], base: usize) -> OrderView {
    OrderView {
        active: data[base + 56],
        owner: read_pubkey(data, base),
        price: read_u64(data, base + 32),
        size: read_u64(data, base + 40),
        seq: read_u64(data, base + 48),
    }
}

fn read_event(data: &[u8], base: usize) -> EventView {
    EventView {
        seq: read_u64(data, base),
        kind: data[base + 105],
        settled: data[base + 104],
        side: data[base + 106],
        owner: read_pubkey(data, base + 24),
        counterparty: read_pubkey(data, base + 56),
        price: read_u64(data, base + 8),
        size: read_u64(data, base + 16),
        entry_total_lamports: read_u64(data, base + 88),
        entry_pool_token_supply: read_u64(data, base + 96),
    }
}

fn read_u64(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().expect("u64 slice"))
}

fn read_pubkey(data: &[u8], offset: usize) -> Pubkey {
    Pubkey::new_from_array(data[offset..offset + 32].try_into().expect("pubkey slice"))
}

// --- Bank-mutation helpers --------------------------------------------

/// Advance the fake stake pool's `total_lamports` (offset 258, with the
/// `account_type` prefix) so the next fill-producing transaction stamps a
/// different index snapshot onto its events.
async fn set_stake_pool_total_lamports(env: &mut Env, total_lamports: u64) {
    let account = env
        .ctx
        .banks_client
        .get_account(env.stake_pool)
        .await
        .unwrap()
        .expect("stake pool exists");
    let mut patched = account.clone();
    patched.data[258..266].copy_from_slice(&total_lamports.to_le_bytes());
    env.ctx
        .set_account(&env.stake_pool, &AccountSharedData::from(patched));
}

/// Overwrite the `seq` field of event-ring `slot` (simulating the slot having
/// been wrapped by 128 newer events — the OQ-1 liveness case).
async fn patch_order_book_event_seq(env: &mut Env, slot: usize, new_seq: u64) {
    let account = env
        .ctx
        .banks_client
        .get_account(env.order_book)
        .await
        .unwrap()
        .expect("order book exists");
    let mut patched = account.clone();
    let seq_off = OB_EVENTS_OFF + slot * 112;
    patched.data[seq_off..seq_off + 8].copy_from_slice(&new_seq.to_le_bytes());
    env.ctx
        .set_account(&env.order_book, &AccountSharedData::from(patched));
}

/// Create a fresh funded party (system account + ATA + minted USDC) that has
/// NOT deposited — so it has no `UserCollateral` ledger — with PDAs derived
/// from the market.
async fn fresh_user(env: &mut Env) -> User {
    let keypair = Keypair::new();
    env.ctx.set_account(
        &keypair.pubkey(),
        &AccountSharedData::from(Account {
            lamports: FUNDING_LAMPORTS,
            data: vec![],
            owner: system_program_id(),
            executable: false,
            rent_epoch: 0,
        }),
    );
    let ata = get_associated_token_address(&keypair.pubkey(), &env.mint);
    env.ctx.set_account(
        &ata,
        &AccountSharedData::from(Account {
            lamports: FUNDING_LAMPORTS,
            data: token_account_data(&env.mint, &keypair.pubkey(), 0),
            owner: spl_token::id(),
            executable: false,
            rent_epoch: 0,
        }),
    );
    let ix = spl_token::instruction::mint_to(
        &spl_token::id(),
        &env.mint,
        &ata,
        &env.ctx.payer.pubkey(),
        &[],
        MINT_AMOUNT,
    )
    .expect("mint_to builds");
    submit(&mut env.ctx, vec![ix], &[]).await.expect("mint_to");
    make_user(&env.market, (keypair, ata))
}

// --- A-20: end-to-end open/close long & short --------------------------

/// The four-party e2e (acceptance A-20): A opens long (limit, rests); B opens
/// short (market) — filling A and booking B's short inline; `settle_fill`
/// books A's maker long; C rests a bid and D rests an ask; A and B market-close
/// against them; `settle_fill` books C's long and D's short. Both closed
/// positions end at `notional == 0` / `reserved == 0`.
#[tokio::test]
async fn position_lifecycle_e2e_long_and_short() {
    let Some(mut env) = setup().await else {
        return;
    };
    let a = env.a.clone();
    let b = env.b.clone();
    let c = env.c.clone();
    let d = env.d.clone();

    // 1. A opens long at a limit price on an empty book: rests, no Position yet.
    let pa = 150_000u64;
    open_position(&mut env, &a, LONG, SIZE, pa, None)
        .await
        .expect("A opens long (limit)");
    let book = book_view(&env).await;
    assert_eq!(book.best_bid, pa, "A's bid rests");
    assert_eq!(book.write_cursor, 0, "a resting order emits no event");
    assert!(
        position_state(&env, &a.long).await.is_none(),
        "maker position is not created until settlement"
    );

    // 2. B opens short (market ask): fills A's bid; B's short settles inline.
    open_position(&mut env, &b, SHORT, SIZE, 0, None)
        .await
        .expect("B opens short (market)");
    let b_pos = position_state(&env, &b.short)
        .await
        .expect("B short exists");
    assert_eq!(b_pos.notional, SIZE, "B's market open fills instantly");
    assert_eq!(b_pos.side, SHORT);
    assert_eq!(b_pos.owner, b.keypair.pubkey());
    assert_eq!(b_pos.collateral, margin_required(SIZE));
    assert_eq!(
        b_pos.entry_n_sum,
        BASE_TOTAL_LAMPORTS as u128 * SIZE as u128,
        "B's entry sums stamp the fill-time snapshot"
    );
    assert_eq!(
        b_pos.entry_d_sum,
        BASE_POOL_TOKEN_SUPPLY as u128 * SIZE as u128
    );
    let uc_b = user_collateral_state(&env, &b.user_collateral)
        .await
        .expect("B ledger");
    assert_eq!(uc_b.reserved, margin_required(SIZE), "B's margin reserved");
    let book = book_view(&env).await;
    assert_eq!(book.best_bid, 0, "A's bid was consumed");
    let ev0 = book.event(0);
    assert_eq!(ev0.kind, 0, "event 0 is a Fill");
    assert_eq!(ev0.seq, 0);
    assert_eq!(ev0.settled, 0, "a fresh Fill is pending maker settlement");
    assert_eq!(ev0.side, LONG, "the maker rested on the bid side");
    assert_eq!(ev0.owner, a.keypair.pubkey());
    assert_eq!(ev0.counterparty, b.keypair.pubkey());
    assert_eq!(ev0.price, pa);
    assert_eq!(ev0.size, SIZE);
    assert_eq!(ev0.entry_total_lamports, BASE_TOTAL_LAMPORTS);
    assert_eq!(ev0.entry_pool_token_supply, BASE_POOL_TOKEN_SUPPLY);

    // 3. settle_fill books A's maker long.
    settle_fill(&mut env, 0, &a.long, &a.user_collateral)
        .await
        .expect("settle A's maker fill");
    let a_pos = position_state(&env, &a.long).await.expect("A long exists");
    assert_eq!(a_pos.notional, SIZE);
    assert_eq!(a_pos.side, LONG);
    assert_eq!(a_pos.owner, a.keypair.pubkey());
    assert_eq!(a_pos.collateral, margin_required(SIZE));
    assert_eq!(
        a_pos.entry_n_sum,
        BASE_TOTAL_LAMPORTS as u128 * SIZE as u128,
        "maker entry sums == event snapshot × size"
    );
    assert_eq!(
        a_pos.entry_d_sum,
        BASE_POOL_TOKEN_SUPPLY as u128 * SIZE as u128
    );
    assert!(
        a_pos.open_slot > 0,
        "maker open records the settlement slot"
    );
    let uc_a = user_collateral_state(&env, &a.user_collateral)
        .await
        .expect("A ledger");
    assert_eq!(uc_a.reserved, margin_required(SIZE));

    // 4. C rests a bid; D rests an ask (D's price above C's, so no cross).
    let pc = 100_000u64;
    let pd = 200_000u64;
    open_position(&mut env, &c, LONG, SIZE, pc, None)
        .await
        .expect("C opens long (limit)");
    open_position(&mut env, &d, SHORT, SIZE, pd, None)
        .await
        .expect("D opens short (limit)");
    let book = book_view(&env).await;
    assert_eq!(book.best_bid, pc, "C's bid rests");
    assert_eq!(book.best_ask, pd, "D's ask rests");
    let c_bid = book.bids.iter().find(|o| o.active != 0).expect("C's bid");
    assert_eq!(c_bid.owner, c.keypair.pubkey());
    assert_eq!(c_bid.price, pc);
    assert_eq!(c_bid.size, SIZE);
    let d_ask = book.asks.iter().find(|o| o.active != 0).expect("D's ask");
    assert_eq!(d_ask.owner, d.keypair.pubkey());
    assert_eq!(d_ask.price, pd);
    assert_eq!(d_ask.size, SIZE);

    // 5. A market-closes the long against C's bid (A long -> 0).
    close_position(&mut env, &a, LONG, SIZE, None)
        .await
        .expect("A closes long (market)");
    let a_pos = position_state(&env, &a.long)
        .await
        .expect("A long retained");
    assert_eq!(a_pos.notional, 0, "A fully closed");
    assert_eq!(a_pos.collateral, 0, "closed position has no margin");
    let uc_a = user_collateral_state(&env, &a.user_collateral)
        .await
        .expect("A ledger");
    assert_eq!(uc_a.reserved, 0, "A's margin fully released");

    // 6. B market-closes the short against D's ask (B short -> 0).
    close_position(&mut env, &b, SHORT, SIZE, None)
        .await
        .expect("B closes short (market)");
    let b_pos = position_state(&env, &b.short)
        .await
        .expect("B short retained");
    assert_eq!(b_pos.notional, 0, "B fully closed");
    assert_eq!(b_pos.collateral, 0);
    let uc_b = user_collateral_state(&env, &b.user_collateral)
        .await
        .expect("B ledger");
    assert_eq!(uc_b.reserved, 0, "B's margin fully released");

    // 7. settle_fill books C's long (event 1) and D's short (event 2).
    settle_fill(&mut env, 1, &c.long, &c.user_collateral)
        .await
        .expect("settle C's maker fill");
    settle_fill(&mut env, 2, &d.short, &d.user_collateral)
        .await
        .expect("settle D's maker fill");
    let c_pos = position_state(&env, &c.long).await.expect("C long exists");
    assert_eq!(c_pos.notional, SIZE);
    assert_eq!(c_pos.side, LONG);
    assert_eq!(c_pos.collateral, margin_required(SIZE));
    assert_eq!(
        c_pos.entry_n_sum,
        BASE_TOTAL_LAMPORTS as u128 * SIZE as u128
    );
    assert_eq!(
        c_pos.entry_d_sum,
        BASE_POOL_TOKEN_SUPPLY as u128 * SIZE as u128
    );
    let d_pos = position_state(&env, &d.short)
        .await
        .expect("D short exists");
    assert_eq!(d_pos.notional, SIZE);
    assert_eq!(d_pos.side, SHORT);
    assert_eq!(d_pos.collateral, margin_required(SIZE));
    assert_eq!(
        d_pos.entry_n_sum,
        BASE_TOTAL_LAMPORTS as u128 * SIZE as u128
    );
    assert_eq!(
        d_pos.entry_d_sum,
        BASE_POOL_TOKEN_SUPPLY as u128 * SIZE as u128
    );
    let uc_c = user_collateral_state(&env, &c.user_collateral)
        .await
        .expect("C ledger");
    assert_eq!(uc_c.reserved, margin_required(SIZE));
    let uc_d = user_collateral_state(&env, &d.user_collateral)
        .await
        .expect("D ledger");
    assert_eq!(uc_d.reserved, margin_required(SIZE));

    // 8. The ring holds exactly three fills, each settled.
    let book = book_view(&env).await;
    assert_eq!(book.write_cursor, 3);
    assert_eq!(book.event(0).settled, 1);
    assert_eq!(book.event(1).settled, 1);
    assert_eq!(book.event(2).settled, 1);
    // Final invariants: both closed positions are at zero notional/reserved,
    // both opened positions are correctly booked.
    assert_eq!(position_state(&env, &a.long).await.unwrap().notional, 0);
    assert_eq!(position_state(&env, &b.short).await.unwrap().notional, 0);
    assert_eq!(
        user_collateral_state(&env, &a.user_collateral)
            .await
            .unwrap()
            .reserved,
        0
    );
    assert_eq!(
        user_collateral_state(&env, &b.user_collateral)
            .await
            .unwrap()
            .reserved,
        0
    );
}

// --- A-4: limit rests, then a market order fills it ---------------------

/// Alice's non-crossing `open_position(Long, size, price)` rests (book bid
/// non-empty, no `Position` yet); Bob's market `open_position(Short, size, 0)`
/// fills it — Bob's `Position(Short)` has `notional == fill size` immediately,
/// Alice's book order is gone, and a `Fill` event with `settled == 0` and the
/// in-transaction snapshot (`entry_*`) was appended.
#[tokio::test]
async fn open_position_limit_rests_then_market_fills() {
    let Some(mut env) = setup().await else {
        return;
    };
    let a = env.a.clone();
    let b = env.b.clone();

    // Advance the index rate so the fill's snapshot is distinguishable from
    // the base rate (validates the bank-mutation mechanism too).
    let new_total_lamports = 11_000_000_000_000u64;
    set_stake_pool_total_lamports(&mut env, new_total_lamports).await;

    let pa = 150_000u64;
    open_position(&mut env, &a, LONG, SIZE, pa, None)
        .await
        .expect("A rests a long");
    let book = book_view(&env).await;
    assert_eq!(book.best_bid, pa);
    assert_eq!(book.resting_bids(), 1);
    let resting = book.bids.iter().find(|o| o.active != 0).expect("A's bid");
    assert_eq!(resting.owner, a.keypair.pubkey());
    assert_eq!(resting.price, pa);
    assert_eq!(resting.size, SIZE);
    assert_eq!(resting.seq, 0, "the first order takes order seq 0");
    assert_eq!(book.write_cursor, 0, "resting order emits no event");
    assert!(
        position_state(&env, &a.long).await.is_none(),
        "no Position until a fill settles it"
    );

    open_position(&mut env, &b, SHORT, SIZE, 0, None)
        .await
        .expect("B market-shorts");
    let b_pos = position_state(&env, &b.short)
        .await
        .expect("B short exists");
    assert_eq!(b_pos.notional, SIZE, "taker fills settle inline");
    assert_eq!(b_pos.entry_n_sum, new_total_lamports as u128 * SIZE as u128);
    assert_eq!(
        b_pos.entry_d_sum,
        BASE_POOL_TOKEN_SUPPLY as u128 * SIZE as u128
    );
    let book = book_view(&env).await;
    assert_eq!(book.best_bid, 0, "Alice's order is gone");
    assert_eq!(book.resting_bids(), 0);
    let ev = book.event(0);
    assert_eq!(ev.kind, 0, "a Fill event was appended");
    assert_eq!(ev.seq, 0);
    assert_eq!(ev.settled, 0);
    assert_eq!(ev.side, LONG, "maker side is the bid");
    assert_eq!(ev.owner, a.keypair.pubkey());
    assert_eq!(ev.counterparty, b.keypair.pubkey());
    assert_eq!(ev.price, pa);
    assert_eq!(ev.size, SIZE);
    assert_eq!(
        ev.entry_total_lamports, new_total_lamports,
        "the Fill carries the in-transaction snapshot"
    );
    assert_eq!(ev.entry_pool_token_supply, BASE_POOL_TOKEN_SUPPLY);
}

// --- A-5: margin shortfall fails atomically -----------------------------

/// Opening a position whose `margin_required` increment exceeds free
/// collateral fails with `InsufficientFreeCollateral` and leaves the book,
/// ledger, and events unchanged (atomic revert). Opening with **no
/// `UserCollateral` at all** also fails with `InsufficientFreeCollateral` (the
/// ledger is deposit-created), not an account-format error.
#[tokio::test]
async fn open_position_margin_shortfall_fails() {
    let Some(mut env) = setup().await else {
        return;
    };
    let a = env.a.clone();

    // Fresh user with a ledger too small to back the position.
    let e = fresh_user(&mut env).await;
    deposit(&mut env, &e, 1_000)
        .await
        .expect("E deposits a tiny amount");

    // A rests an ask; E's market long crosses it but cannot reserve margin.
    let pa = 150_000u64;
    open_position(&mut env, &a, SHORT, SIZE, pa, None)
        .await
        .expect("A rests an ask");
    let result = open_position(&mut env, &e, LONG, SIZE, 0, None).await;
    assert_anchor_error(result, FructusError::InsufficientFreeCollateral);

    // Atomic: the book keeps A's ask, no event was appended, and neither E's
    // ledger nor E's position changed.
    let book = book_view(&env).await;
    assert_eq!(book.best_ask, pa, "A's ask still rests");
    assert_eq!(book.resting_asks(), 1);
    assert_eq!(book.write_cursor, 0, "no fill event survived the revert");
    assert!(
        position_state(&env, &e.long).await.is_none(),
        "E's position was rolled back"
    );
    let uc_e = user_collateral_state(&env, &e.user_collateral)
        .await
        .expect("E ledger");
    assert_eq!(uc_e.deposited, 1_000, "E's ledger untouched");
    assert_eq!(uc_e.reserved, 0);
    let uc_a = user_collateral_state(&env, &a.user_collateral)
        .await
        .expect("A ledger");
    assert_eq!(uc_a.reserved, 0, "A's ledger untouched");

    // A fresh user with NO ledger at all: the same market open fails with
    // InsufficientFreeCollateral (the ledger is deposit-created, so a missing
    // ledger is a free-collateral error, not an account-format error).
    let f = fresh_user(&mut env).await;
    let result = open_position(&mut env, &f, LONG, SIZE, 0, None).await;
    assert_anchor_error(result, FructusError::InsufficientFreeCollateral);
    let book = book_view(&env).await;
    assert_eq!(book.best_ask, pa, "book unchanged again");
    assert_eq!(book.write_cursor, 0);
    assert!(position_state(&env, &f.long).await.is_none());
    assert!(
        user_collateral_state(&env, &f.user_collateral)
            .await
            .is_none(),
        "F never gained a ledger"
    );
}

// --- A-7: close reduces notional and releases margin --------------------

/// After an open, `close_position(Long, size)` reduces `notional` by the
/// filled amount, recomputes `collateral` down, releases
/// `UserCollateral.reserved`, and leaves `entry_*` / `open_slot` unchanged; a
/// full close leaves `notional == 0` / `collateral == 0`. Exercised for both
/// sides, with a partial close in between.
#[tokio::test]
async fn close_position_long_and_short_market() {
    let Some(mut env) = setup().await else {
        return;
    };
    let a = env.a.clone();
    let b = env.b.clone();
    let c = env.c.clone();
    let d = env.d.clone();

    // A opens a 2x-SIZE long; B's market short fills it; settle books A.
    let pa = 150_000u64;
    open_position(&mut env, &a, LONG, 2 * SIZE, pa, None)
        .await
        .expect("A opens long (2x)");
    open_position(&mut env, &b, SHORT, 2 * SIZE, 0, None)
        .await
        .expect("B opens short (2x)");
    settle_fill(&mut env, 0, &a.long, &a.user_collateral)
        .await
        .expect("settle A");
    let a_open = position_state(&env, &a.long).await.expect("A long");
    assert_eq!(a_open.notional, 2 * SIZE);
    assert_eq!(a_open.collateral, margin_required(2 * SIZE));

    // C rests a 2x-SIZE bid; A partially closes SIZE of the long against it,
    // leaving C's bid resting with its SIZE remainder.
    let pc = 100_000u64;
    open_position(&mut env, &c, LONG, 2 * SIZE, pc, None)
        .await
        .expect("C rests a bid");
    close_position(&mut env, &a, LONG, SIZE, None)
        .await
        .expect("A partially closes");
    let a_half = position_state(&env, &a.long).await.expect("A long");
    assert_eq!(a_half.notional, SIZE, "partial close reduces notional");
    assert_eq!(a_half.collateral, margin_required(SIZE));
    assert_eq!(
        a_half.entry_n_sum, a_open.entry_n_sum,
        "close never touches the entry sums"
    );
    assert_eq!(a_half.entry_d_sum, a_open.entry_d_sum);
    assert_eq!(a_half.open_slot, a_open.open_slot, "open_slot unchanged");
    let uc_a = user_collateral_state(&env, &a.user_collateral)
        .await
        .expect("A ledger");
    assert_eq!(
        uc_a.reserved,
        margin_required(SIZE),
        "margin released by delta"
    );
    let book = book_view(&env).await;
    assert_eq!(book.best_bid, pc, "C's bid still rests with its remainder");

    // A closes the remaining SIZE — full close.
    close_position(&mut env, &a, LONG, SIZE, None)
        .await
        .expect("A fully closes");
    let a_closed = position_state(&env, &a.long)
        .await
        .expect("A long retained");
    assert_eq!(a_closed.notional, 0);
    assert_eq!(a_closed.collateral, 0);
    assert_eq!(a_closed.entry_n_sum, a_open.entry_n_sum, "entry untouched");
    assert_eq!(a_closed.entry_d_sum, a_open.entry_d_sum);
    assert_eq!(a_closed.open_slot, a_open.open_slot);
    let uc_a = user_collateral_state(&env, &a.user_collateral)
        .await
        .expect("A ledger");
    assert_eq!(uc_a.reserved, 0, "full close releases all margin");
    let book = book_view(&env).await;
    assert_eq!(book.best_bid, 0, "C's bid consumed");

    // D rests an ask; B market-closes the short against it.
    let pd = 200_000u64;
    open_position(&mut env, &d, SHORT, 2 * SIZE, pd, None)
        .await
        .expect("D rests an ask");
    let b_open = position_state(&env, &b.short).await.expect("B short");
    close_position(&mut env, &b, SHORT, 2 * SIZE, None)
        .await
        .expect("B closes short");
    let b_closed = position_state(&env, &b.short)
        .await
        .expect("B short retained");
    assert_eq!(b_closed.notional, 0);
    assert_eq!(b_closed.collateral, 0);
    assert_eq!(
        b_closed.entry_n_sum, b_open.entry_n_sum,
        "B's entry sums unchanged on close"
    );
    assert_eq!(b_closed.entry_d_sum, b_open.entry_d_sum);
    let uc_b = user_collateral_state(&env, &b.user_collateral)
        .await
        .expect("B ledger");
    assert_eq!(uc_b.reserved, 0, "B's margin fully released");
    let book = book_view(&env).await;
    assert_eq!(book.best_ask, 0, "D's ask consumed");
}

// --- A-8: close errors, no mutation on failure --------------------------

/// Closing with no live position → `PositionNotFound`; with `size > notional`
/// → `InvalidCloseSize`; with `size == 0` → `InvalidSize` (matching the open
/// path); none mutates any account.
#[tokio::test]
async fn close_position_errors() {
    let Some(mut env) = setup().await else {
        return;
    };
    let a = env.a.clone();
    let c = env.c.clone();

    // size == 0 is rejected before any position lookup (InvalidSize).
    let result = close_position(&mut env, &a, LONG, 0, None).await;
    assert_anchor_error(result, FructusError::InvalidSize);

    // No live position at all -> PositionNotFound, no book mutation.
    let result = close_position(&mut env, &a, LONG, SIZE, None).await;
    assert_anchor_error(result, FructusError::PositionNotFound);
    let book = book_view(&env).await;
    assert_eq!(book.write_cursor, 0, "no event on the failed close");

    // Open A's long so we can test InvalidCloseSize and the closed-position case.
    let pa = 150_000u64;
    open_position(&mut env, &a, LONG, SIZE, pa, None)
        .await
        .expect("A opens long");
    let b = env.b.clone();
    open_position(&mut env, &b, SHORT, SIZE, 0, None)
        .await
        .expect("B market-shorts");
    settle_fill(&mut env, 0, &a.long, &a.user_collateral)
        .await
        .expect("settle A");
    let before = position_state(&env, &a.long).await.expect("A long");

    // size > notional -> InvalidCloseSize, position/ledger/book untouched.
    let result = close_position(&mut env, &a, LONG, SIZE + 1, None).await;
    assert_anchor_error(result, FructusError::InvalidCloseSize);
    let after = position_state(&env, &a.long).await.expect("A long");
    assert_eq!(after.notional, before.notional, "notional unchanged");
    assert_eq!(after.collateral, before.collateral, "collateral unchanged");
    assert_eq!(after.entry_n_sum, before.entry_n_sum, "entry unchanged");
    let uc = user_collateral_state(&env, &a.user_collateral)
        .await
        .expect("A ledger");
    assert_eq!(uc.reserved, before.collateral, "reserved unchanged");
    let book = book_view(&env).await;
    assert_eq!(book.write_cursor, 1, "no new event on the failed close");

    // size == 0 again — still InvalidSize, still no mutation.
    let result = close_position(&mut env, &a, LONG, 0, None).await;
    assert_anchor_error(result, FructusError::InvalidSize);

    // Fully close A, then closing again is PositionNotFound (notional == 0).
    let pc = 100_000u64;
    open_position(&mut env, &c, LONG, SIZE, pc, None)
        .await
        .expect("C rests a bid");
    close_position(&mut env, &a, LONG, SIZE, None)
        .await
        .expect("A fully closes");
    let closed = position_state(&env, &a.long)
        .await
        .expect("A long retained");
    assert_eq!(closed.notional, 0);
    let result = close_position(&mut env, &a, LONG, 1, None).await;
    assert_anchor_error(result, FructusError::PositionNotFound);
    let after = position_state(&env, &a.long)
        .await
        .expect("A long retained");
    assert_eq!(after.notional, 0, "still closed after the failed close");
    assert_eq!(after.collateral, 0);
    let uc = user_collateral_state(&env, &a.user_collateral)
        .await
        .expect("A ledger");
    assert_eq!(uc.reserved, 0);
}

// --- A-9: settle_fill books the maker, idempotently ---------------------

/// A permissionless `settle_fill(seq)` creates/updates the maker's
/// `Position(Long)` with `notional == fill size`, `entry_*` matching the
/// event-carried snapshot (sums = snapshot × size), `collateral` reserved, and
/// marks the event `settled == 1`; a second call with the same `seq` succeeds
/// as a no-op (idempotent, D9).
#[tokio::test]
async fn settle_fill_books_maker_position() {
    let Some(mut env) = setup().await else {
        return;
    };
    let a = env.a.clone();
    let b = env.b.clone();

    let new_total_lamports = 11_000_000_000_000u64;
    set_stake_pool_total_lamports(&mut env, new_total_lamports).await;
    let pa = 150_000u64;
    open_position(&mut env, &a, LONG, SIZE, pa, None)
        .await
        .expect("A rests a long");
    open_position(&mut env, &b, SHORT, SIZE, 0, None)
        .await
        .expect("B market-shorts");

    // The caller is the permissionless payer (≠ Alice).
    settle_fill(&mut env, 0, &a.long, &a.user_collateral)
        .await
        .expect("settle the maker fill");
    let pos = position_state(&env, &a.long).await.expect("A long exists");
    assert_eq!(pos.market, env.market);
    assert_eq!(pos.owner, a.keypair.pubkey());
    assert_eq!(pos.side, LONG);
    assert_eq!(pos.notional, SIZE);
    assert_eq!(
        pos.entry_n_sum,
        new_total_lamports as u128 * SIZE as u128,
        "entry sums == event snapshot × size"
    );
    assert_eq!(
        pos.entry_d_sum,
        BASE_POOL_TOKEN_SUPPLY as u128 * SIZE as u128
    );
    assert_eq!(pos.collateral, margin_required(SIZE));
    assert!(pos.open_slot > 0);
    let uc = user_collateral_state(&env, &a.user_collateral)
        .await
        .expect("A ledger");
    assert_eq!(uc.reserved, margin_required(SIZE));
    assert_eq!(book_view(&env).await.event(0).settled, 1);

    // Idempotent no-op: a second settle of the same seq succeeds and changes
    // nothing.
    settle_fill(&mut env, 0, &a.long, &a.user_collateral)
        .await
        .expect("re-settle is a no-op");
    let pos2 = position_state(&env, &a.long).await.expect("A long exists");
    assert_eq!(pos2.notional, SIZE, "no double-booking");
    assert_eq!(pos2.entry_n_sum, pos.entry_n_sum);
    assert_eq!(pos2.entry_d_sum, pos.entry_d_sum);
    assert_eq!(pos2.collateral, pos.collateral);
    let uc2 = user_collateral_state(&env, &a.user_collateral)
        .await
        .expect("A ledger");
    assert_eq!(uc2.reserved, uc.reserved);
    assert_eq!(book_view(&env).await.event(0).settled, 1);
}

// --- A-9b: re-open of a fully closed position resets entry/open_slot -----

/// After the maker's position is fully closed (`notional == 0`, retained
/// account), a later `settle_fill` for a new fill on the same side **re-opens**
/// it — `entry_* :=` the event-carried snapshot weighted by `event.size` and
/// `open_slot :=` the current slot — instead of accumulating into the stale
/// closed sums (FR-2/FR-5).
#[tokio::test]
async fn settle_fill_reopens_closed_position() {
    let Some(mut env) = setup().await else {
        return;
    };
    let a = env.a.clone();
    let c = env.c.clone();
    let d = env.d.clone();

    // Life 1: A rests a long at rate 1.1; B fills it; settle books A.
    set_stake_pool_total_lamports(&mut env, 11_000_000_000_000).await;
    let pa = 150_000u64;
    open_position(&mut env, &a, LONG, SIZE, pa, None)
        .await
        .expect("A rests a long (life 1)");
    let b = env.b.clone();
    open_position(&mut env, &b, SHORT, SIZE, 0, None)
        .await
        .expect("B market-shorts (life 1)");
    settle_fill(&mut env, 0, &a.long, &a.user_collateral)
        .await
        .expect("settle A (life 1)");
    let life1 = position_state(&env, &a.long).await.expect("A long");
    assert_eq!(life1.entry_n_sum, 11_000_000_000_000u128 * SIZE as u128);
    assert!(life1.open_slot > 0);

    // Close fully (retained account): entry sums and open_slot survive.
    let pc = 100_000u64;
    open_position(&mut env, &c, LONG, SIZE, pc, None)
        .await
        .expect("C rests a bid");
    close_position(&mut env, &a, LONG, SIZE, None)
        .await
        .expect("A fully closes");
    let closed = position_state(&env, &a.long)
        .await
        .expect("A long retained");
    assert_eq!(closed.notional, 0);
    assert_eq!(closed.collateral, 0);
    assert_eq!(closed.entry_n_sum, life1.entry_n_sum, "stale sums retained");
    assert_eq!(closed.open_slot, life1.open_slot);

    // Life 2: A rests again at rate 1.2; D fills it; settle re-opens A.
    set_stake_pool_total_lamports(&mut env, 12_000_000_000_000).await;
    let pa2 = 160_000u64;
    open_position(&mut env, &a, LONG, SIZE, pa2, None)
        .await
        .expect("A rests a long (life 2)");
    open_position(&mut env, &d, SHORT, SIZE, 0, None)
        .await
        .expect("D market-shorts (life 2)");
    // Force the re-open to a later slot so open_slot provably resets.
    env.ctx.warp_to_slot(1_000).expect("warp to slot 1000");
    settle_fill(&mut env, 2, &a.long, &a.user_collateral)
        .await
        .expect("settle A (life 2)");

    let reopened = position_state(&env, &a.long).await.expect("A long");
    assert_eq!(reopened.notional, SIZE, "re-opened");
    assert_eq!(
        reopened.entry_n_sum,
        12_000_000_000_000u128 * SIZE as u128,
        "entry := the NEW fill's weighted snapshot, not accumulated into stale sums"
    );
    assert_eq!(
        reopened.entry_d_sum,
        BASE_POOL_TOKEN_SUPPLY as u128 * SIZE as u128
    );
    assert_eq!(reopened.collateral, margin_required(SIZE));
    assert!(
        reopened.open_slot >= 1_000 && reopened.open_slot > life1.open_slot,
        "re-open stamps the current settlement slot ({} > {})",
        reopened.open_slot,
        life1.open_slot
    );
    let uc = user_collateral_state(&env, &a.user_collateral)
        .await
        .expect("A ledger");
    assert_eq!(uc.reserved, margin_required(SIZE));
    assert_eq!(book_view(&env).await.event(2).settled, 1);
}

// --- A-10: settle_fill ownership verification ---------------------------

/// Passing a `Position`/`UserCollateral` that does not match the event-derived
/// PDA fails with `ProgramError::InvalidAccountData`; a `seq` whose ring slot
/// holds no `Fill` with `event.seq == seq` — a never-written seq, or a slot
/// overwritten by newer events (OQ-1) — fails with `EventNotFound`.
#[tokio::test]
async fn settle_fill_verifies_ownership() {
    let Some(mut env) = setup().await else {
        return;
    };
    let a = env.a.clone();
    let b = env.b.clone();

    let pa = 150_000u64;
    open_position(&mut env, &a, LONG, SIZE, pa, None)
        .await
        .expect("A rests a long");
    open_position(&mut env, &b, SHORT, SIZE, 0, None)
        .await
        .expect("B market-shorts");

    // Wrong Position key -> InvalidAccountData (byte-level PDA verification).
    let wrong_pos = Pubkey::new_from_array([1u8; 32]);
    let result = settle_fill(&mut env, 0, &wrong_pos, &a.user_collateral).await;
    assert_instruction_error(result, SolanaInstructionError::InvalidAccountData);

    // Wrong UserCollateral key -> InvalidAccountData.
    let wrong_uc = Pubkey::new_from_array([2u8; 32]);
    let result = settle_fill(&mut env, 0, &a.long, &wrong_uc).await;
    assert_instruction_error(result, SolanaInstructionError::InvalidAccountData);

    // A never-written seq: the ring slot holds a default (seq 0) event.
    let result = settle_fill(&mut env, 999, &a.long, &a.user_collateral).await;
    assert_anchor_error(result, FructusError::EventNotFound);

    // Overwritten slot: patch ring slot 0's seq to 128 (as if 128 newer
    // events wrapped over it), then the original seq 0 is no longer findable.
    patch_order_book_event_seq(&mut env, 0, 128).await;
    let result = settle_fill(&mut env, 0, &a.long, &a.user_collateral).await;
    assert_anchor_error(result, FructusError::EventNotFound);

    // The failed attempts never marked the fill settled.
    assert_eq!(book_view(&env).await.event(0).settled, 0);
}

// --- A-11: settle_fill margin shortfall is retryable --------------------

/// A maker with insufficient free collateral fails settlement atomically (the
/// event stays `settled == 0`); a maker with **no `UserCollateral` yet** also
/// fails with `InsufficientFreeCollateral`; after the maker deposits, the same
/// `settle_fill(seq)` succeeds.
#[tokio::test]
async fn settle_fill_margin_shortfall_retryable() {
    let Some(mut env) = setup().await else {
        return;
    };
    let a = env.a.clone();
    let e = fresh_user(&mut env).await;

    // E rests an ask (position-neutral; no ledger needed to rest).
    let pe = 200_000u64;
    open_position(&mut env, &e, SHORT, SIZE, pe, None)
        .await
        .expect("E rests an ask");
    // A's market long fills E's ask (event 0).
    open_position(&mut env, &a, LONG, SIZE, 0, None)
        .await
        .expect("A market-longs");

    // 1. No UserCollateral at all -> InsufficientFreeCollateral, event stays
    //    pending, no Position created.
    let result = settle_fill(&mut env, 0, &e.short, &e.user_collateral).await;
    assert_anchor_error(result, FructusError::InsufficientFreeCollateral);
    assert_eq!(book_view(&env).await.event(0).settled, 0);
    assert!(position_state(&env, &e.short).await.is_none());
    assert!(user_collateral_state(&env, &e.user_collateral)
        .await
        .is_none());

    // 2. A ledger that cannot back the margin -> InsufficientFreeCollateral,
    //    still atomic (no position, event still pending).
    deposit(&mut env, &e, 1)
        .await
        .expect("E deposits 1 microunit");
    let result = settle_fill(&mut env, 0, &e.short, &e.user_collateral).await;
    assert_anchor_error(result, FructusError::InsufficientFreeCollateral);
    assert_eq!(book_view(&env).await.event(0).settled, 0);
    assert!(position_state(&env, &e.short).await.is_none());
    let uc = user_collateral_state(&env, &e.user_collateral)
        .await
        .expect("E ledger");
    assert_eq!(uc.deposited, 1);
    assert_eq!(uc.reserved, 0);

    // 3. After E deposits enough, the SAME seq settles successfully.
    deposit(&mut env, &e, MINT_AMOUNT - 1)
        .await
        .expect("E tops up");
    settle_fill(&mut env, 0, &e.short, &e.user_collateral)
        .await
        .expect("retry succeeds");
    let pos = position_state(&env, &e.short)
        .await
        .expect("E short exists");
    assert_eq!(pos.notional, SIZE);
    assert_eq!(pos.side, SHORT);
    assert_eq!(pos.owner, e.keypair.pubkey());
    assert_eq!(pos.entry_n_sum, BASE_TOTAL_LAMPORTS as u128 * SIZE as u128);
    assert_eq!(
        pos.entry_d_sum,
        BASE_POOL_TOKEN_SUPPLY as u128 * SIZE as u128
    );
    assert_eq!(pos.collateral, margin_required(SIZE));
    let uc = user_collateral_state(&env, &e.user_collateral)
        .await
        .expect("E ledger");
    assert_eq!(uc.deposited, MINT_AMOUNT);
    assert_eq!(uc.reserved, margin_required(SIZE));
    assert_eq!(book_view(&env).await.event(0).settled, 1);

    // 4. Idempotent after success.
    settle_fill(&mut env, 0, &e.short, &e.user_collateral)
        .await
        .expect("still a no-op after success");
    assert_eq!(position_state(&env, &e.short).await.unwrap().notional, SIZE);
    assert_eq!(book_view(&env).await.event(0).settled, 1);
}

// --- A-15: withdrawal blocked while reserved > 0 -------------------------

/// With an open position (`reserved > 0`), `withdraw_collateral(free + 1)`
/// fails `InsufficientFreeCollateral` and moves no tokens; after closing, the
/// same withdrawal succeeds.
#[tokio::test]
async fn withdrawal_blocked_by_reserved() {
    let Some(mut env) = setup().await else {
        return;
    };
    let a = env.a.clone();
    let b = env.b.clone();
    let c = env.c.clone();

    // Book A's long (reserved = margin_required(SIZE) = 100_000).
    let pa = 150_000u64;
    open_position(&mut env, &a, LONG, SIZE, pa, None)
        .await
        .expect("A opens long");
    open_position(&mut env, &b, SHORT, SIZE, 0, None)
        .await
        .expect("B market-shorts");
    settle_fill(&mut env, 0, &a.long, &a.user_collateral)
        .await
        .expect("settle A");

    let free = MINT_AMOUNT - margin_required(SIZE);
    let before_ata = ata_balance(&env, &a.ata).await;
    let before_vault = vault_balance(&env).await;

    // Withdrawing more than free collateral (reserved > 0) fails atomically.
    let result = withdraw(&mut env, &a, free + 1).await;
    assert_anchor_error(result, FructusError::InsufficientFreeCollateral);
    assert_eq!(ata_balance(&env, &a.ata).await, before_ata, "no ATA change");
    assert_eq!(vault_balance(&env).await, before_vault, "no vault change");
    let uc = user_collateral_state(&env, &a.user_collateral)
        .await
        .expect("A ledger");
    assert_eq!(uc.deposited, MINT_AMOUNT);
    assert_eq!(uc.reserved, margin_required(SIZE));

    // Close the position (releases all reservation), then the same withdrawal
    // succeeds.
    let pc = 100_000u64;
    open_position(&mut env, &c, LONG, SIZE, pc, None)
        .await
        .expect("C rests a bid");
    close_position(&mut env, &a, LONG, SIZE, None)
        .await
        .expect("A closes");
    let uc = user_collateral_state(&env, &a.user_collateral)
        .await
        .expect("A ledger");
    assert_eq!(uc.reserved, 0);

    withdraw(&mut env, &a, free + 1)
        .await
        .expect("withdraw succeeds");
    assert_eq!(
        ata_balance(&env, &a.ata).await,
        before_ata + free + 1,
        "tokens moved to the user ATA"
    );
    assert_eq!(
        vault_balance(&env).await,
        before_vault - (free + 1),
        "tokens left the vault"
    );
    let uc = user_collateral_state(&env, &a.user_collateral)
        .await
        .expect("A ledger");
    assert_eq!(uc.deposited, MINT_AMOUNT - (free + 1));
}

// --- A-13b: index_source must byte-equal market.index_source -------------

/// On every fill-producing instruction (`open_position`, `close_position`,
/// `place_limit_order`, `place_market_order`, `crank`), supplying a
/// stake-pool-valid account whose key ≠ `PerpMarket.index_source` fails (the
/// Anchor `address` constraint), leaves no state behind, and the market-bound
/// account succeeds.
#[tokio::test]
async fn index_source_must_be_market_binding() {
    let Some(mut env) = setup().await else {
        return;
    };
    let a = env.a.clone();
    let b = env.b.clone();
    let c = env.c.clone();
    // Copied (Pubkey is Copy) so it can be passed alongside `&mut env`.
    let wrong = env.wrong_stake_pool;
    let pa = 150_000u64;
    let pa2 = 160_000u64;
    let pc = 100_000u64;

    // place_limit_order: wrong binding fails, right binding rests A's bid.
    let result = place_limit_order(&mut env, &a, LONG, pa, SIZE, Some(&wrong)).await;
    assert!(
        result.is_err(),
        "place_limit_order with a foreign index_source fails"
    );
    let book = book_view(&env).await;
    assert_eq!(book.best_bid, 0, "nothing rested");
    assert_eq!(book.write_cursor, 0);
    place_limit_order(&mut env, &a, LONG, pa, SIZE, None)
        .await
        .expect("market-bound index_source succeeds");
    assert_eq!(book_view(&env).await.best_bid, pa);

    // open_position: wrong binding fails and leaves the book untouched.
    let result = open_position(&mut env, &a, LONG, SIZE, pa2, Some(&wrong)).await;
    assert!(
        result.is_err(),
        "open_position with a foreign index_source fails"
    );
    let book = book_view(&env).await;
    assert_eq!(book.best_bid, pa, "book untouched by the failed open");
    assert_eq!(book.write_cursor, 0);

    // place_market_order: wrong binding fails, right binding fills A's bid.
    let result = place_market_order(&mut env, &b, SHORT, SIZE, Some(&wrong)).await;
    assert!(
        result.is_err(),
        "place_market_order with a foreign index_source fails"
    );
    let book = book_view(&env).await;
    assert_eq!(
        book.best_bid, pa,
        "book untouched by the failed market order"
    );
    assert_eq!(book.write_cursor, 0);
    place_market_order(&mut env, &b, SHORT, SIZE, None)
        .await
        .expect("market-bound index_source succeeds");
    let book = book_view(&env).await;
    assert_eq!(book.best_bid, 0, "A's bid consumed");
    assert_eq!(book.write_cursor, 1);

    // open_position again (A rests a long) and a wrong-binding market open.
    open_position(&mut env, &a, LONG, SIZE, pa2, None)
        .await
        .expect("A rests a long");
    let result = open_position(&mut env, &b, SHORT, SIZE, 0, Some(&wrong)).await;
    assert!(
        result.is_err(),
        "market open with a foreign index_source fails"
    );
    let book = book_view(&env).await;
    assert_eq!(book.best_bid, pa2, "A's bid untouched");
    assert_eq!(book.write_cursor, 1);
    open_position(&mut env, &b, SHORT, SIZE, 0, None)
        .await
        .expect("market open with the market-bound index_source succeeds");

    // Book A's long so close_position can be exercised.
    settle_fill(&mut env, 1, &a.long, &a.user_collateral)
        .await
        .expect("settle A's maker fill");
    open_position(&mut env, &c, LONG, SIZE, pc, None)
        .await
        .expect("C rests a bid");

    // close_position: wrong binding fails, right binding fills C's bid.
    let result = close_position(&mut env, &a, LONG, SIZE, Some(&wrong)).await;
    assert!(
        result.is_err(),
        "close_position with a foreign index_source fails"
    );
    let book = book_view(&env).await;
    assert_eq!(book.best_bid, pc, "book untouched by the failed close");
    assert_eq!(book.write_cursor, 2);
    close_position(&mut env, &a, LONG, SIZE, None)
        .await
        .expect("close_position with the market-bound index_source succeeds");
    assert_eq!(position_state(&env, &a.long).await.unwrap().notional, 0);

    // crank: wrong binding fails, right binding drains the ring.
    let result = crank(&mut env, Some(&wrong)).await;
    assert!(result.is_err(), "crank with a foreign index_source fails");
    let book = book_view(&env).await;
    assert_eq!(book.read_cursor, 0, "failed crank drained nothing");
    crank(&mut env, None)
        .await
        .expect("crank with the market-bound index_source succeeds");
    let book = book_view(&env).await;
    assert_eq!(book.read_cursor, 3, "crank drained all three fills");
}

// --- A2: account-level liquidation + the withdraw equity gate -------------

/// LIQUIDATE-TRIGGERS-ON-ACCOUNT-HEALTH (REQ-A2-2, bank): `liquidate`
/// succeeds iff the ACCOUNT's equity is below its TOTAL maintenance
/// requirement — the superseded per-position metric is not the trigger.
///
/// (a) both sides held: each side would PASS the per-position check, yet the
///     account is under its total maintenance requirement ⇒ liquidation
///     succeeds on one side;
/// (b) one side looks individually weak but the account (a big deposit) is
///     healthy ⇒ `NotLiquidatable`;
/// (c) the opposite side is pristine (never created) ⇒ zero contribution and
///     the account behaves as a single-side account.
///
/// Cases (b)/(c) run first: case (a) parks the book's mark furniture (a
/// resting bid/ask used for the funding premium) that later market orders
/// would otherwise pick up.
#[tokio::test]
async fn liquidate_triggers_on_account_health() {
    let Some(mut env) = setup().await else {
        return;
    };
    let a = env.a.clone();
    let b = env.b.clone();
    let c = env.c.clone();
    let d = env.d.clone();
    let n_long = 3_000_000u64; // long-side notional (USDC microunits)
    let n_short = 1_000_000u64; // short-side notional

    // ---- (b) one side individually weak, the account healthy (big deposit).
    {
        set_stake_pool_total_lamports(&mut env, 11_600_000_000_000).await; // entry 1.16
        open_maker_position(&mut env, &a, &b, LONG, n_long, 150_000, 0)
            .await
            .expect("(b) A rests a long (entry 1.16)");
        set_stake_pool_total_lamports(&mut env, 10_000_000_000_000).await; // drift 1.16 -> 1.00
        open_maker_position(&mut env, &a, &c, SHORT, n_short, 250_000, 1)
            .await
            .expect("(b) A rests a short (entry 1.00)");
        let open_slot = position_state(&env, &a.long).await.unwrap().open_slot;
        env.ctx
            .warp_to_slot(open_slot.wrapping_add(1_001))
            .expect("(b) warp past the TWAP window");

        let rate = stake_pool_rate(&env).await;
        let long = position_state(&env, &a.long).await.expect("(b) A long");
        let short = position_state(&env, &a.short).await.expect("(b) A short");
        let pnl_long = pnl_of(&long, rate);
        let pnl_short = pnl_of(&short, rate);
        let pnl_sum = pnl_long + pnl_short;
        let uc = user_collateral_state(&env, &a.user_collateral)
            .await
            .expect("(b) A ledger");
        // The long alone would be liquidatable under the superseded
        // per-position metric (`collateral + upnl < m(n, maintenance)`) …
        assert!(
            (long.collateral as i128) + pnl_long
                < margin_required_bps(long.notional, MAINTENANCE_MARGIN_BPS) as i128,
            "(b) premise: the long side must look individually liquidatable"
        );
        // … but the account's equity (a 1,000,000 USDC deposit) is far above
        // the TOTAL maintenance requirement, so liquidation must be refused.
        assert!(
            !account_is_liquidatable(uc.deposited, pnl_sum, long.notional, short.notional),
            "(b) premise: the account must stay above its total maintenance requirement"
        );
        let moved = liquidate(&mut env, &a, &d, LONG, n_short).await;
        assert_anchor_error(moved, FructusError::NotLiquidatable);
        assert_eq!(
            user_collateral_state(&env, &a.user_collateral)
                .await
                .expect("(b) A ledger")
                .deposited,
            uc.deposited,
            "(b) a refused liquidation must not move the ledger"
        );
        assert_eq!(
            position_state(&env, &a.long).await.unwrap().notional,
            n_long,
            "(b) a refused liquidation must not touch the position"
        );
    }

    // ---- (c) pristine other side: zero contribution (single-side account).
    {
        let u = fresh_user(&mut env).await;
        deposit(&mut env, &u, 400_000)
            .await
            .expect("(c) u deposits its 10% margin");
        set_stake_pool_total_lamports(&mut env, 11_600_000_000_000).await; // entry 1.16
        open_maker_position(&mut env, &u, &b, LONG, n_long, 150_000, 2)
            .await
            .expect("(c) u rests a long (entry 1.16)");
        set_stake_pool_total_lamports(&mut env, 10_000_000_000_000).await; // drift 1.16 -> 1.00
        let open_slot = position_state(&env, &u.long).await.unwrap().open_slot;
        env.ctx
            .warp_to_slot(open_slot.wrapping_add(1_001))
            .expect("(c) warp past the TWAP window");
        // The short side was never created: its PDA is pristine and must
        // contribute zero exposure.
        assert!(
            account_data(&env, &u.short).await.is_none(),
            "(c) premise: the opposite side must be pristine"
        );
        let rate = stake_pool_rate(&env).await;
        let long = position_state(&env, &u.long).await.expect("(c) u long");
        let pnl = pnl_of(&long, rate);
        let uc = user_collateral_state(&env, &u.user_collateral)
            .await
            .expect("(c) u ledger");
        assert!(
            account_is_liquidatable(uc.deposited, pnl, long.notional, 0),
            "(c) premise: the single-side account is under maintenance"
        );
        let d_before = user_collateral_state(&env, &d.user_collateral)
            .await
            .expect("(c) liquidator ledger")
            .deposited;
        liquidate(&mut env, &u, &d, LONG, n_short)
            .await
            .expect("(c) a single-side account liquidates on account health");
        let released = margin_required(n_long) - margin_required(n_long - n_short);
        let reward = liquidation_penalty(released);
        let reserved_after = margin_required(n_long - n_short);
        let booked = u64::try_from(pnl.unsigned_abs())
            .expect("loss fits u64")
            .min(uc.deposited - reserved_after - reward);
        assert_eq!(
            position_state(&env, &u.long).await.unwrap().notional,
            n_long - n_short,
            "(c) the long is reduced by the liquidated amount"
        );
        let uc_after = user_collateral_state(&env, &u.user_collateral)
            .await
            .expect("(c) u ledger after");
        assert_eq!(
            uc_after.reserved, reserved_after,
            "(c) reserved releases the freed margin"
        );
        assert_eq!(
            uc_after.deposited,
            uc.deposited - booked - reward,
            "(c) the victim pays the booked loss and the reward"
        );
        assert_eq!(
            user_collateral_state(&env, &d.user_collateral)
                .await
                .expect("(c) liquidator ledger after")
                .deposited,
            d_before + reward,
            "(c) the liquidator is credited the penalty reward"
        );
    }

    // ---- (a) each side individually healthy, the ACCOUNT under total
    // maintenance (both notionals large, a small deposit + a funding debit).
    {
        let u = fresh_user(&mut env).await;
        deposit(&mut env, &u, 400_000)
            .await
            .expect("(a) u deposits its 10% margin");
        set_stake_pool_total_lamports(&mut env, 10_800_000_000_000).await; // long entry 1.08
        open_maker_position(&mut env, &u, &b, LONG, n_long, 150_000, 3)
            .await
            .expect("(a) u rests a long (entry 1.08)");
        set_stake_pool_total_lamports(&mut env, 10_000_000_000_000).await; // short entry 1.00
        open_maker_position(&mut env, &u, &c, SHORT, n_short, 250_000, 4)
            .await
            .expect("(a) u rests a short (entry 1.00)");
        // The book's mid (1.10) is the mark for the funding premium.
        open_position(&mut env, &c, LONG, n_short, 1_000_000, None)
            .await
            .expect("(a) mark bid rests");
        open_position(&mut env, &d, SHORT, n_short, 1_200_000, None)
            .await
            .expect("(a) mark ask rests");
        // Settle three funding epochs on the long: the first market
        // settlement has no baseline, so `index == 0` and the premium is the
        // full mark — the rate clamps to its +1%/epoch cap and the long pays
        // exactly 1% x 3M per epoch.
        let last_epoch = position_state(&env, &u.long)
            .await
            .expect("(a) u long")
            .last_funding_epoch;
        env.ctx
            .warp_to_slot((last_epoch + 3) * 1_000 + 500)
            .expect("(a) warp three funding epochs");
        let before_funding = user_collateral_state(&env, &u.user_collateral)
            .await
            .expect("(a) u ledger pre-funding");
        settle_funding(&mut env, &u.long, &u.user_collateral)
            .await
            .expect("(a) settle funding on the long");
        let after_funding = user_collateral_state(&env, &u.user_collateral)
            .await
            .expect("(a) u ledger post-funding");
        assert_eq!(
            before_funding.deposited - after_funding.deposited,
            90_000,
            "(a) premise: three epochs of max-rate funding debit 90_000 off the long"
        );
        set_stake_pool_total_lamports(&mut env, 10_400_000_000_000).await; // final drift 1.04

        let rate = stake_pool_rate(&env).await;
        let long = position_state(&env, &u.long).await.expect("(a) u long");
        let short = position_state(&env, &u.short).await.expect("(a) u short");
        let pnl_long = pnl_of(&long, rate);
        let pnl_short = pnl_of(&short, rate);
        let pnl_sum = pnl_long + pnl_short;
        let uc = user_collateral_state(&env, &u.user_collateral)
            .await
            .expect("(a) u ledger");
        // EACH side is individually healthy under the superseded metric …
        assert!(
            (long.collateral as i128) + pnl_long
                >= margin_required_bps(long.notional, MAINTENANCE_MARGIN_BPS) as i128,
            "(a) premise: the long side must look individually healthy"
        );
        assert!(
            (short.collateral as i128) + pnl_short
                >= margin_required_bps(short.notional, MAINTENANCE_MARGIN_BPS) as i128,
            "(a) premise: the short side must look individually healthy"
        );
        // … yet the ACCOUNT is below its TOTAL maintenance requirement.
        assert!(
            account_is_liquidatable(uc.deposited, pnl_sum, long.notional, short.notional),
            "(a) premise: the account must be under total maintenance"
        );
        let d_before = user_collateral_state(&env, &d.user_collateral)
            .await
            .expect("(a) liquidator ledger")
            .deposited;
        liquidate(&mut env, &u, &d, LONG, n_short)
            .await
            .expect("(a) an individually-healthy side liquidates on account health");
        let released = margin_required(n_long) - margin_required(n_long - n_short);
        let reward = liquidation_penalty(released);
        let reserved_after = margin_required(n_long - n_short) + margin_required(n_short);
        let seam = uc.deposited - reserved_after - reward;
        let booked = u64::try_from(pnl_sum.unsigned_abs())
            .expect("loss fits u64")
            .min(seam);
        assert_eq!(
            position_state(&env, &u.long).await.unwrap().notional,
            n_long - n_short,
            "(a) the targeted long is reduced"
        );
        assert_eq!(
            position_state(&env, &u.short).await.unwrap().notional,
            n_short,
            "(a) the other side is untouched"
        );
        let uc_after = user_collateral_state(&env, &u.user_collateral)
            .await
            .expect("(a) u ledger after");
        assert_eq!(
            uc_after.reserved, reserved_after,
            "(a) reserved == Σ m(n_i, im) after the release"
        );
        assert_eq!(
            uc_after.deposited,
            uc.deposited - booked - reward,
            "(a) the victim pays the booked loss and the reward"
        );
        assert_eq!(
            user_collateral_state(&env, &d.user_collateral)
                .await
                .expect("(a) liquidator ledger after")
                .deposited,
            d_before + reward,
            "(a) the liquidator is credited the penalty reward"
        );
    }
}

/// LIQUIDATE-RELEASES-ONLY-THE-TARGETED-SIDE (REQ-A2-2, bank): a partial
/// liquidation of the long (and a full one of the short, on a second account)
/// reduces only the targeted side's notional/collateral — the other side's
/// `Position` account stays byte-identical — while `reserved` drops by exactly
/// the released initial-margin backing, the liquidator is credited the 5%
/// penalty on the release, and the account loss `max(0, −Σ upnl)` is booked
/// into the pool with the `deposited − reserved_after − reward` clamp.
#[tokio::test]
async fn liquidate_releases_only_the_targeted_side() {
    let Some(mut env) = setup().await else {
        return;
    };
    let b = env.b.clone();
    let c = env.c.clone();
    let d = env.d.clone();
    let n_long = 3_000_000u64;
    let n_short = 1_000_000u64;

    // ---- partial liquidation of the long on a two-side account.
    let u1 = fresh_user(&mut env).await;
    deposit(&mut env, &u1, 400_000)
        .await
        .expect("u1 deposits the exact margin");
    set_stake_pool_total_lamports(&mut env, 11_600_000_000_000).await; // long entry 1.16
    open_maker_position(&mut env, &u1, &b, LONG, n_long, 150_000, 0)
        .await
        .expect("u1 rests a long (entry 1.16)");
    set_stake_pool_total_lamports(&mut env, 10_000_000_000_000).await; // drift 1.16 -> 1.00
    open_maker_position(&mut env, &u1, &c, SHORT, n_short, 250_000, 1)
        .await
        .expect("u1 rests a short (entry 1.00)");
    let open_slot = position_state(&env, &u1.long).await.unwrap().open_slot;
    env.ctx
        .warp_to_slot(open_slot.wrapping_add(1_001))
        .expect("u1 warp past the TWAP window");

    let rate = stake_pool_rate(&env).await;
    let long = position_state(&env, &u1.long).await.expect("u1 long");
    let short = position_state(&env, &u1.short).await.expect("u1 short");
    let pnl_sum = pnl_of(&long, rate) + pnl_of(&short, rate);
    let uc = user_collateral_state(&env, &u1.user_collateral)
        .await
        .expect("u1 ledger");
    assert!(
        account_is_liquidatable(uc.deposited, pnl_sum, long.notional, short.notional),
        "u1 premise: the account is under its total maintenance requirement"
    );
    let short_bytes = account_data(&env, &u1.short).await.expect("u1 short bytes");
    let d_before = user_collateral_state(&env, &d.user_collateral)
        .await
        .expect("liquidator ledger")
        .deposited;
    let pool_before = market_state(&env).await.pnl_pool;
    let vault_before = vault_balance(&env).await;

    liquidate(&mut env, &u1, &d, LONG, n_short)
        .await
        .expect("u1: a partial liquidation of the long succeeds");

    assert_eq!(
        account_data(&env, &u1.short).await,
        Some(short_bytes),
        "the untargeted short side must be byte-identical"
    );
    let long_after = position_state(&env, &u1.long).await.expect("u1 long after");
    assert_eq!(
        long_after.notional,
        n_long - n_short,
        "the targeted notional is reduced by amount"
    );
    assert_eq!(
        long_after.collateral,
        margin_required(n_long - n_short),
        "the survivor holds exactly m(n - amount, im)"
    );
    let released = margin_required(n_long) - margin_required(n_long - n_short);
    let reward = liquidation_penalty(released);
    let reserved_after = margin_required(n_long - n_short) + margin_required(n_short);
    let booked = u64::try_from(pnl_sum.unsigned_abs())
        .expect("loss fits u64")
        .min(uc.deposited - reserved_after - reward);
    let uc_after = user_collateral_state(&env, &u1.user_collateral)
        .await
        .expect("u1 ledger after");
    assert_eq!(
        uc_after.reserved, reserved_after,
        "reserved == Σ m(n_i, im) after the release"
    );
    assert_eq!(
        uc_after.deposited,
        uc.deposited - booked - reward,
        "the victim pays the booked loss and the reward"
    );
    assert_eq!(
        user_collateral_state(&env, &d.user_collateral)
            .await
            .expect("liquidator ledger after")
            .deposited,
        d_before + reward,
        "the liquidator is credited the penalty on the released margin"
    );
    assert_eq!(
        market_state(&env).await.pnl_pool,
        pool_before + booked,
        "the account loss max(0, -Σ upnl) is booked into the pool, seam-clamped"
    );
    assert_eq!(
        vault_balance(&env).await,
        vault_before,
        "a liquidation moves no vault tokens"
    );

    // ---- full liquidation of the short on a second two-side account.
    let u2 = fresh_user(&mut env).await;
    deposit(&mut env, &u2, 400_000)
        .await
        .expect("u2 deposits the exact margin");
    set_stake_pool_total_lamports(&mut env, 13_000_000_000_000).await; // small long enters at 1.30
    open_maker_position(&mut env, &u2, &b, LONG, n_short, 150_000, 2)
        .await
        .expect("u2 rests a small long (entry 1.30)");
    set_stake_pool_total_lamports(&mut env, 10_000_000_000_000).await; // big short enters at 1.00
    open_maker_position(&mut env, &u2, &c, SHORT, n_long, 250_000, 3)
        .await
        .expect("u2 rests a big short (entry 1.00)");
    let open_slot = position_state(&env, &u2.long).await.unwrap().open_slot;
    env.ctx
        .warp_to_slot(open_slot.wrapping_add(1_001))
        .expect("u2 warp past the TWAP window");

    let rate = stake_pool_rate(&env).await;
    let long = position_state(&env, &u2.long).await.expect("u2 long");
    let short = position_state(&env, &u2.short).await.expect("u2 short");
    let pnl_sum = pnl_of(&long, rate) + pnl_of(&short, rate);
    let uc = user_collateral_state(&env, &u2.user_collateral)
        .await
        .expect("u2 ledger");
    assert!(
        account_is_liquidatable(uc.deposited, pnl_sum, long.notional, short.notional),
        "u2 premise: the account is under its total maintenance requirement"
    );
    let long_bytes = account_data(&env, &u2.long).await.expect("u2 long bytes");
    let d_before = user_collateral_state(&env, &d.user_collateral)
        .await
        .expect("liquidator ledger")
        .deposited;
    let pool_before = market_state(&env).await.pnl_pool;
    let vault_before = vault_balance(&env).await;

    liquidate(&mut env, &u2, &d, SHORT, n_long)
        .await
        .expect("u2: a full liquidation of the short succeeds");

    assert_eq!(
        account_data(&env, &u2.long).await,
        Some(long_bytes),
        "the untargeted long side must be byte-identical"
    );
    let short_after = position_state(&env, &u2.short)
        .await
        .expect("u2 short after");
    assert_eq!(
        short_after.notional, 0,
        "a full liquidation closes the targeted side"
    );
    assert_eq!(
        short_after.collateral, 0,
        "a fully liquidated side holds zero collateral"
    );
    let released = margin_required(n_long);
    let reward = liquidation_penalty(released);
    let reserved_after = margin_required(n_short);
    let booked = u64::try_from(pnl_sum.unsigned_abs())
        .expect("loss fits u64")
        .min(uc.deposited - reserved_after - reward);
    let uc_after = user_collateral_state(&env, &u2.user_collateral)
        .await
        .expect("u2 ledger after");
    assert_eq!(
        uc_after.reserved, reserved_after,
        "only the short's initial-margin backing is released"
    );
    assert_eq!(
        uc_after.deposited,
        uc.deposited - booked - reward,
        "the victim pays the booked loss and the reward"
    );
    assert_eq!(
        user_collateral_state(&env, &d.user_collateral)
            .await
            .expect("liquidator ledger after")
            .deposited,
        d_before + reward,
        "the liquidator is credited the penalty on the released margin"
    );
    assert_eq!(
        market_state(&env).await.pnl_pool,
        pool_before + booked,
        "the account loss is booked into the pool"
    );
    assert_eq!(
        vault_balance(&env).await,
        vault_before,
        "a liquidation moves no vault tokens"
    );
}

/// WITHDRAW-BLOCKED-BELOW-INITIAL-MARGIN (REQ-A2-3, bank): after a downward
/// drift leaves the account with negative Σ upnl, a withdrawal that would
/// leave equity (`deposited + Σ upnl`) below the reserved initial-margin
/// requirement fails with `InsufficientFreeCollateral` and moves nothing,
/// while one that keeps equity ≥ it succeeds — the exact boundary is pinned
/// (±1 microunit). Covers a single-side account (pristine-position path) and
/// a two-side account (both sides' upnl enter the gate).
#[tokio::test]
async fn withdraw_blocked_below_initial_margin() {
    let Some(mut env) = setup().await else {
        return;
    };
    let b = env.b.clone();
    let c = env.c.clone();
    let n_long = 3_000_000u64;
    let n_short = 1_000_000u64;

    // Opens: u1 long @1.08, u2 long @1.08, u2 short @1.00.
    let u1 = fresh_user(&mut env).await;
    deposit(&mut env, &u1, 500_000).await.expect("u1 deposits");
    let u2 = fresh_user(&mut env).await;
    deposit(&mut env, &u2, 560_000).await.expect("u2 deposits");
    set_stake_pool_total_lamports(&mut env, 10_800_000_000_000).await;
    open_maker_position(&mut env, &u1, &b, LONG, n_long, 150_000, 0)
        .await
        .expect("u1 rests a long (entry 1.08)");
    open_maker_position(&mut env, &u2, &b, LONG, n_long, 150_000, 1)
        .await
        .expect("u2 rests a long (entry 1.08)");
    set_stake_pool_total_lamports(&mut env, 10_000_000_000_000).await; // short entry 1.00
    open_maker_position(&mut env, &u2, &c, SHORT, n_short, 250_000, 2)
        .await
        .expect("u2 rests a short (entry 1.00)");
    set_stake_pool_total_lamports(&mut env, 10_400_000_000_000).await; // drift 1.08 -> 1.04

    // ---- single-side account: pristine short contributes zero upnl.
    assert!(
        account_data(&env, &u1.short).await.is_none(),
        "u1 premise: the short side is pristine (must contribute zero upnl)"
    );
    let rate = stake_pool_rate(&env).await;
    let long1 = position_state(&env, &u1.long).await.expect("u1 long");
    let pnl1 = pnl_of(&long1, rate);
    assert!(
        pnl1 < 0,
        "u1 premise: the drift leaves the long with negative PnL"
    );
    let uc1 = user_collateral_state(&env, &u1.user_collateral)
        .await
        .expect("u1 ledger");
    let reserved1 = margin_required(long1.notional);
    assert_eq!(uc1.reserved, reserved1, "u1 premise: reserved == m(n, im)");
    // The largest withdrawal that keeps `equity - amount >= reserved`.
    let limit1 = u64::try_from(account_equity(uc1.deposited, pnl1) - reserved1 as i128)
        .expect("u1 limit fits u64");
    assert!(
        limit1 < uc1.deposited - uc1.reserved,
        "u1 premise: the free seam must NOT be what blocks (equity gate must bite)"
    );

    let ata_before = ata_balance(&env, &u1.ata).await;
    let vault_before = vault_balance(&env).await;
    let moved = withdraw(&mut env, &u1, limit1 + 1).await;
    assert_anchor_error(moved, FructusError::InsufficientFreeCollateral);
    assert_eq!(
        ata_balance(&env, &u1.ata).await,
        ata_before,
        "a refused withdrawal moves no tokens"
    );
    assert_eq!(
        vault_balance(&env).await,
        vault_before,
        "a refused withdrawal moves no tokens"
    );
    assert_eq!(
        user_collateral_state(&env, &u1.user_collateral)
            .await
            .expect("u1 ledger")
            .deposited,
        uc1.deposited,
        "a refused withdrawal leaves the ledger untouched"
    );

    withdraw(&mut env, &u1, limit1)
        .await
        .expect("u1: a withdrawal that keeps equity >= reserved succeeds");
    assert_eq!(
        ata_balance(&env, &u1.ata).await,
        ata_before + limit1,
        "tokens moved to the user ATA"
    );
    assert_eq!(
        vault_balance(&env).await,
        vault_before - limit1,
        "tokens left the vault"
    );
    let uc1_after = user_collateral_state(&env, &u1.user_collateral)
        .await
        .expect("u1 ledger after");
    assert_eq!(
        uc1_after.deposited,
        uc1.deposited - limit1,
        "the ledger is debited by the amount"
    );
    assert_eq!(
        account_equity(uc1_after.deposited, pnl1),
        reserved1 as i128,
        "the boundary withdrawal lands exactly on the initial requirement"
    );

    // ---- two-side account: both sides carry losses, both enter the gate.
    let long2 = position_state(&env, &u2.long).await.expect("u2 long");
    let short2 = position_state(&env, &u2.short).await.expect("u2 short");
    let pnl_long2 = pnl_of(&long2, rate);
    let pnl_short2 = pnl_of(&short2, rate);
    assert!(
        pnl_long2 < 0 && pnl_short2 < 0,
        "u2 premise: both sides carry negative PnL (no netting in the gate)"
    );
    let uc2 = user_collateral_state(&env, &u2.user_collateral)
        .await
        .expect("u2 ledger");
    let reserved2 = margin_required(long2.notional) + margin_required(short2.notional);
    assert_eq!(
        uc2.reserved, reserved2,
        "u2 premise: reserved == Σ m(n_i, im)"
    );
    let limit2 =
        u64::try_from(account_equity(uc2.deposited, pnl_long2 + pnl_short2) - reserved2 as i128)
            .expect("u2 limit fits u64");
    assert!(
        limit2 < uc2.deposited - uc2.reserved,
        "u2 premise: the equity gate, not the free seam, must block"
    );

    let moved2 = withdraw(&mut env, &u2, limit2 + 1).await;
    assert_anchor_error(moved2, FructusError::InsufficientFreeCollateral);
    assert_eq!(
        user_collateral_state(&env, &u2.user_collateral)
            .await
            .expect("u2 ledger")
            .deposited,
        uc2.deposited,
        "u2: a refused withdrawal leaves the ledger untouched"
    );

    withdraw(&mut env, &u2, limit2)
        .await
        .expect("u2: the boundary withdrawal succeeds");
    let uc2_after = user_collateral_state(&env, &u2.user_collateral)
        .await
        .expect("u2 ledger after");
    assert_eq!(
        uc2_after.deposited,
        uc2.deposited - limit2,
        "u2: the ledger is debited by the amount"
    );
    assert_eq!(
        account_equity(uc2_after.deposited, pnl_long2 + pnl_short2),
        reserved2 as i128,
        "u2: post-withdraw equity lands exactly on Σ m(n_i, im)"
    );
}

/// DEPOSIT-IMPROVES-ACCOUNT-HEALTH (REQ-A2-4, bank): after a downward drift
/// leaves an under-margin account, a direct `deposit_collateral` raises equity
/// one-for-one; depositing exactly the gap flips the account-level predicate
/// to false while one microunit less stays liquidatable — the ±1 boundary is
/// checked against the same equity-vs-requirement math the handler gate uses,
/// and via the handler itself (a still-under account liquidates; the healed
/// ones are refused with `NotLiquidatable`).
#[tokio::test]
async fn deposit_improves_account_health() {
    let Some(mut env) = setup().await else {
        return;
    };
    let b = env.b.clone();
    let d = env.d.clone();
    let n_long = 3_000_000u64;

    // Three identical accounts: long 3M entered at 1.08, drifted to 1.00.
    let mut accounts = Vec::new();
    for seq in 0..3u64 {
        let u = fresh_user(&mut env).await;
        deposit(&mut env, &u, 310_000).await.expect("deposit");
        set_stake_pool_total_lamports(&mut env, 10_800_000_000_000).await; // entry 1.08
        open_maker_position(&mut env, &u, &b, LONG, n_long, 150_000, seq)
            .await
            .expect("rests a long (entry 1.08)");
        accounts.push(u);
    }
    set_stake_pool_total_lamports(&mut env, 10_000_000_000_000).await; // drift 1.08 -> 1.00
    let open_slot = position_state(&env, &accounts[0].long)
        .await
        .unwrap()
        .open_slot;
    env.ctx
        .warp_to_slot(open_slot.wrapping_add(1_001))
        .expect("warp past the TWAP window");

    // Per-account flip point: the deposit amount that lands equity exactly on
    // the maintenance requirement, computed with the handler gate's math.
    let rate = stake_pool_rate(&env).await;
    let mut state = Vec::new(); // (pnl, deposited_before, gap)
    for u in &accounts {
        let long = position_state(&env, &u.long).await.expect("long");
        let pnl = pnl_of(&long, rate);
        let uc = user_collateral_state(&env, &u.user_collateral)
            .await
            .expect("ledger");
        assert!(
            account_is_liquidatable(uc.deposited, pnl, long.notional, 0),
            "premise: the drift must leave the account liquidatable"
        );
        let required = account_margin_required(long.notional, 0, MAINTENANCE_MARGIN_BPS) as i128;
        let gap = u64::try_from(required - account_equity(uc.deposited, pnl))
            .expect("flip point fits u64");
        assert!(gap > 1, "premise: the gap must admit a ±1 boundary");
        state.push((pnl, uc.deposited, gap));
    }
    // Deposits: gap - 1 (still under), gap (exactly at), gap + 1 (above).
    let deposits = [state[0].2 - 1, state[1].2, state[2].2 + 1];
    for (i, u) in accounts.iter().enumerate() {
        let (pnl, before, _) = state[i];
        deposit(&mut env, u, deposits[i])
            .await
            .expect("boundary deposit");
        let uc = user_collateral_state(&env, &u.user_collateral)
            .await
            .expect("ledger after deposit");
        assert_eq!(
            uc.deposited,
            before + deposits[i],
            "a deposit raises deposited one-for-one"
        );
        assert_eq!(
            account_equity(uc.deposited, pnl),
            account_equity(before, pnl) + deposits[i] as i128,
            "a deposit raises equity one-for-one"
        );
        let still_under = account_is_liquidatable(uc.deposited, pnl, n_long, 0);
        match i {
            0 => assert!(
                still_under,
                "gap - 1 must stay below the maintenance requirement"
            ),
            _ => assert!(
                !still_under,
                "gap and gap + 1 must clear the maintenance requirement"
            ),
        }
    }

    // Handler-level evidence: the still-under account liquidates; the healed
    // ones are refused with NotLiquidatable.
    let (pnl0, before0, _) = state[0];
    let deposited0 = before0 + deposits[0];
    let released0 = margin_required(n_long) - margin_required(2_000_000);
    let reward0 = liquidation_penalty(released0);
    let reserved_after0 = margin_required(2_000_000);
    let booked0 = u64::try_from(pnl0.unsigned_abs())
        .expect("loss fits u64")
        .min(deposited0 - reserved_after0 - reward0);
    let d_before = user_collateral_state(&env, &d.user_collateral)
        .await
        .expect("liquidator ledger")
        .deposited;
    liquidate(&mut env, &accounts[0], &d, LONG, 1_000_000)
        .await
        .expect("a still-under account liquidates");
    let uc0 = user_collateral_state(&env, &accounts[0].user_collateral)
        .await
        .expect("ledger after liquidate");
    assert_eq!(
        uc0.deposited,
        deposited0 - booked0 - reward0,
        "the liquidation books the clamped loss and the reward"
    );
    assert_eq!(
        uc0.reserved, reserved_after0,
        "reserved == m(n - amount, im)"
    );
    assert_eq!(
        user_collateral_state(&env, &d.user_collateral)
            .await
            .expect("liquidator ledger after")
            .deposited,
        d_before + reward0,
        "the liquidator is credited the reward"
    );
    for u in &accounts[1..] {
        let moved = liquidate(&mut env, u, &d, LONG, 1_000_000).await;
        assert_anchor_error(moved, FructusError::NotLiquidatable);
    }
}

/// Every positions CPI test body is `let Some(mut env) = setup(..) else { return; }`,
/// so `cargo test --workspace` reports green while silently skipping all
/// position assertions whenever the SBF binary is missing (or runs a stale
/// binary). This guard converts that silent skip/staleness into a hard failure
/// (the acceptance A-21 requires the new tests to actually run).
#[test]
fn cpi_binary_is_present_and_fresh() {
    let so = find_fructus_so().expect(
        "fructus.so not built; every positions CPI test below silently skips under \
         `cargo test --workspace` (A-20/A-21 require them to actually run)",
    );
    let so_mtime = std::fs::metadata(&so)
        .and_then(|m| m.modified())
        .expect("fructus.so metadata");
    let newest = newest_src_mtime(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"));
    assert!(
        so_mtime >= newest,
        "fructus.so is stale (built {:?}, newest source {:?}); rebuild with `anchor build` \
         so the CPI assertions exercise current code rather than silently running a stale binary",
        so_mtime,
        newest
    );
}

/// Newest `modified` time among the `.rs` files under `dir` (recursive).
fn newest_src_mtime(dir: &Path) -> std::time::SystemTime {
    let mut newest = std::time::SystemTime::UNIX_EPOCH;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d).expect("read src dir") {
            let entry = entry.expect("read dir entry");
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().and_then(|e| e.to_str()) == Some("rs") {
                if let Ok(t) = entry.metadata().and_then(|m| m.modified()) {
                    newest = newest.max(t);
                }
            }
        }
    }
    newest
}

// ============================================================================
// Property-based protocol invariant test (issue #9 "check for bugs"):
// drives the real on-chain CLOB + deferred-maker-settlement flow across varied
// price data (the stake-pool index) and order quantities, and asserts the
// protocol invariants hold for every drawn case. Unlike the deterministic
// scenarios above, the index (jitoSOL exchange rate => premium), the trade
// price, and the order size are all randomized — this is the
// solana-program-test counterpart to the Trident on-chain fuzz (which
// trident_svm's execution stack cannot yet host).
//
// Invariants asserted per case:
//   1. a taker fill creates a Position with notional == size and reserved
//      collateral == margin_required(size);
//   2. the fill stamps the live index (`entry_n_sum == total_lamports * size`,
//      `entry_d_sum == pool_token_supply * size`);
//   3. a deferred maker `settle_fill` books the opposite Position symmetric to
//      the taker;
//   4. the vault is never under-collateralized relative to reserved margin;
//   5. no ledger ever has `reserved > deposited` (no negative free collateral);
//   6. a well-formed sequence never reverts (no panic / unexpected error).
proptest! {
    #![proptest_config(proptest::test_runner::Config::with_cases(20))]

    #[test]
    fn pbt_clob_fills_hold_invariants(
        // jitoSOL exchange-rate numerator (index / price data), rate 0.9..1.1.
        total_lamports in 9_000_000_000_000u64..=11_000_000_000_000u64,
        // trade yield level (APY_SCALE fixed point), non-crossing when resting.
        price in 1u64..=1_000_000u64,
        // order notional in USDC microunits (fully within the pre-funded deposit).
        size in 1_000u64..=5_000_000u64,
    ) {
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(async {
            let Some(mut env) = setup().await else { return; };
            let a = env.a.clone();
            let b = env.b.clone();

            // Vary the trustless index => varied premium/price data.
            set_stake_pool_total_lamports(&mut env, total_lamports).await;

            // 1. A rests a long bid at `price` (no Position until settlement).
            open_position(&mut env, &a, LONG, size, price, None)
                .await
                .expect("A opens long (limit) rests");
            let book = book_view(&env).await;
            assert_eq!(book.best_bid, price, "A's bid rested at price");
            assert_eq!(
                book.write_cursor, 0,
                "a resting order emits no Fill event"
            );

            // 2. B market-opens a short: fills A's bid inline (taker settlement).
            open_position(&mut env, &b, SHORT, size, 0, None)
                .await
                .expect("B opens short (market) fills");
            let bp = position_state(&env, &b.short).await.expect("B short exists");
            assert_eq!(bp.notional, size, "taker fill has full notional");
            assert_eq!(bp.side, SHORT);
            assert_eq!(bp.owner, b.keypair.pubkey());
            assert_eq!(bp.collateral, margin_required(size), "taker margin reserved");
            assert_eq!(
                bp.entry_n_sum,
                total_lamports as u128 * size as u128,
                "fill stamps the live index numerator"
            );
            assert_eq!(
                bp.entry_d_sum,
                BASE_POOL_TOKEN_SUPPLY as u128 * size as u128,
                "fill stamps the live index denominator"
            );
            let uc_b = user_collateral_state(&env, &b.user_collateral)
                .await
                .expect("B ledger");
            assert_eq!(uc_b.reserved, margin_required(size), "B margin reserved");

            // 3. A's resting bid was consumed by the taker fill.
            let book = book_view(&env).await;
            assert_eq!(book.best_bid, 0, "A's bid consumed");
            let ev = book.event(0);
            assert_eq!(ev.kind, 0, "event 0 is a Fill");
            assert_eq!(ev.settled, 0, "fresh Fill is pending maker settlement");
            assert_eq!(ev.side, LONG, "maker rested on the bid side");
            assert_eq!(ev.owner, a.keypair.pubkey());
            assert_eq!(ev.counterparty, b.keypair.pubkey());
            assert_eq!(ev.price, price);
            assert_eq!(ev.size, size);
            assert_eq!(ev.entry_total_lamports, total_lamports, "live index on fill");

            // 4. Deferred maker settlement books A's symmetric long.
            settle_fill(&mut env, 0, &a.long, &a.user_collateral)
                .await
                .expect("settle A's maker fill");
            let ap = position_state(&env, &a.long).await.expect("A long exists");
            assert_eq!(ap.notional, size, "maker position notional");
            assert_eq!(ap.side, LONG);
            assert_eq!(ap.collateral, margin_required(size), "maker margin reserved");
            assert_eq!(
                ap.entry_n_sum,
                total_lamports as u128 * size as u128,
                "maker entry == event snapshot x size"
            );
            assert_eq!(
                ap.entry_d_sum,
                BASE_POOL_TOKEN_SUPPLY as u128 * size as u128
            );

            // 5. Reserved margin for both open positions never exceeds deposits,
            //    and the vault is never under-collateralized.
            let uc_a = user_collateral_state(&env, &a.user_collateral)
                .await
                .expect("A ledger");
            assert!(
                uc_a.reserved <= uc_a.deposited,
                "A reserved > deposited (negative free collateral)"
            );
            assert!(
                uc_b.reserved <= uc_b.deposited,
                "B reserved > deposited (negative free collateral)"
            );
            let vb = vault_balance(&env).await;
            assert!(
                vb >= 2 * margin_required(size),
                "vault under-collateralized: {vb} < {}",
                2 * margin_required(size)
            );
        });
    }

    // ==========================================================================
    // Full-lifecycle property test: funding settlement (R-F3) + ACCOUNT-level
    // liquidation (REQ-A2-2). Reuses the fill to produce one LONG (A) and one
    // SHORT (B), then
    //   (a) shrinks A's ledger to its reserved margin (so the drawdown can
    //       push the ACCOUNT under its total maintenance requirement) and
    //       advances a funding epoch, asserting the sign convention when a
    //       non-flat premium makes funding actually flow;
    //   (b) drives A's long underwater (the trustless index drops below the
    //       entry snapshot) and liquidates it, asserting the account-level
    //       transition: permissionless, the liquidator credited exactly the
    //       penalty reward, the clamped account loss booked into the pool, and
    //       Σ(victim + liquidator + pool) conserved.
    #[test]
    fn pbt_funding_and_liquidation(
        entry_total in 9_000_000_000_000u64..=11_000_000_000_000u64,
        price in 1u64..=1_000_000u64,
        size in 1_000u64..=5_000_000u64,
        drawdown_pct in 6u64..=20u64,
    ) {
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(async {
            let Some(mut env) = setup().await else { return; };
            let a = env.a.clone();
            let b = env.b.clone();
            let c = env.c.clone();
            let d = env.d.clone();

            set_stake_pool_total_lamports(&mut env, entry_total).await;

            open_position(&mut env, &a, LONG, size, price, None)
                .await
                .expect("A opens long (limit)");
            open_position(&mut env, &b, SHORT, size, 0, None)
                .await
                .expect("B opens short (market)");
            settle_fill(&mut env, 0, &a.long, &a.user_collateral)
                .await
                .expect("settle A maker fill");
            let apos = position_state(&env, &a.long).await.expect("A long");
            let open_slot = apos.open_slot;

            // Shrink A's ledger to its reserved (initial-margin) requirement:
            // at the fill-time rate the unrealized PnL is zero, so the equity
            // gate permits withdrawing exactly the free seam — and only then
            // can the coming drawdown push the ACCOUNT below its total
            // maintenance requirement (REQ-A2-2). A per-position check could
            // never see this (A's single side is backed at the initial ratio).
            let uc_a_pre_withdraw = user_collateral_state(&env, &a.user_collateral)
                .await
                .expect("A ledger pre-withdraw");
            withdraw(
                &mut env,
                &a,
                uc_a_pre_withdraw.deposited - uc_a_pre_withdraw.reserved,
            )
            .await
            .expect("A withdraws down to the reserved margin");
            let uc_a_reserved_only = user_collateral_state(&env, &a.user_collateral)
                .await
                .expect("A ledger post-withdraw");
            assert_eq!(
                uc_a_reserved_only.deposited, uc_a_reserved_only.reserved,
                "A's ledger holds exactly the reserved (initial-margin) backing"
            );

            // ---- (a) funding: advance an epoch, then settle both positions.
            // A non-flat premium needs a real book mid (both sides present) that
            // differs from the index. Rest C on the bid and D on the ask so the
            // mid = 1.10; set the index to 0.90 => premium = +0.20 > 0.
            let mark_bid = 1_000_000u64;
            let mark_ask = 1_200_000u64;
            open_position(&mut env, &c, LONG, size, mark_bid, None)
                .await
                .expect("C rests a bid (sets mid)");
            open_position(&mut env, &d, SHORT, size, mark_ask, None)
                .await
                .expect("D rests an ask (sets mid)");
            set_stake_pool_total_lamports(&mut env, 9_000_000_000_000u64).await;
            env.ctx
                .warp_to_slot(open_slot.wrapping_add(1_001))
                .expect("warp past an epoch");

            let l0 = user_collateral_state(&env, &a.user_collateral)
                .await
                .expect("A ledger pre-funding")
                .deposited;
            let s0 = user_collateral_state(&env, &b.user_collateral)
                .await
                .expect("B ledger pre-funding")
                .deposited;

            settle_funding(&mut env, &a.long, &a.user_collateral)
                .await
                .expect("settle_funding long");
            settle_funding(&mut env, &b.short, &b.user_collateral)
                .await
                .expect("settle_funding short");

            let lafter = user_collateral_state(&env, &a.user_collateral)
                .await
                .expect("A ledger post-funding")
                .deposited;
            let safter = user_collateral_state(&env, &b.user_collateral)
                .await
                .expect("B ledger post-funding")
                .deposited;
            let d_long = lafter as i128 - l0 as i128;
            let d_short = safter as i128 - s0 as i128;
            if d_long != 0 && d_short != 0 {
                // R-F3: long and short funding are exact opposites.
                assert_eq!(d_long, -d_short, "funding not zero-sum (long/short)");
                // premium > 0 => long pays (flows negative), short receives.
                assert!(d_long < 0, "positive premium must make long pay (got {d_long})");
                assert!(d_short > 0, "positive premium must pay short (got {d_short})");
            }

            // ---- (b) liquidation: drop the index, making A's long underwater.
            let drop = entry_total * (100 - drawdown_pct) / 100;
            set_stake_pool_total_lamports(&mut env, drop).await;

            // The ACCOUNT-level trigger (REQ-A2-2/D8): A holds one side (the
            // short PDA is pristine ⇒ zero contribution), and the drawdown's
            // unrealized loss now pushes `equity = deposited + pnl` below
            // `m(size, maintenance)` because (a) shrank A's ledger to its
            // reserved backing. Compute the gate INLINE, from the exact
            // `positions::pnl` + ceiling formula the handler uses.
            let rate_now = stake_pool_rate(&env).await;
            let apos_now = position_state(&env, &a.long).await.expect("A long");
            let pnl_sum = pnl_of(&apos_now, rate_now);
            let uc_a_before = user_collateral_state(&env, &a.user_collateral)
                .await
                .expect("A ledger before liquidate");
            assert!(
                account_is_liquidatable(uc_a_before.deposited, pnl_sum, apos_now.notional, 0),
                "the drawdown must leave A's account below maintenance"
            );
            let uc_c_before = user_collateral_state(&env, &c.user_collateral)
                .await
                .expect("liquidator ledger before")
                .deposited;
            let pool_before = market_state(&env).await.pnl_pool;
            let vb_before = vault_balance(&env).await;

            liquidate(&mut env, &a, &c, LONG, size)
                .await
                .expect("liquidate an underwater long");

            // The account-level transition (D8): the FULL liquidation of the
            // long releases its whole `m(size, im)` backing, credits the
            // liquidator `penalty(released)`, and books the clamped account
            // loss `min(max(0, -Σ upnl), deposited - reserved_after - reward)`
            // into the pool (reserved_after == 0 for a single side).
            let released = margin_required(size);
            let reward = liquidation_penalty(released);
            let seam = uc_a_before.deposited - reward;
            let loss = u64::try_from(pnl_sum.unsigned_abs()).expect("loss fits u64");
            let booked = loss.min(seam);
            let a_after = position_state(&env, &a.long).await.expect("A long after");
            assert_eq!(a_after.notional, 0, "the long is fully liquidated");
            assert_eq!(
                a_after.collateral, 0,
                "a fully liquidated side holds zero collateral"
            );
            let uc_a_after = user_collateral_state(&env, &a.user_collateral)
                .await
                .expect("A ledger post-liq");
            let uc_c_after = user_collateral_state(&env, &c.user_collateral)
                .await
                .expect("liquidator ledger post-liq");
            let vb_after = vault_balance(&env).await;

            // R-L/R-S3: the liquidator is credited exactly the penalty reward,
            // the victim pays the booked loss (collected into the pool) and the
            // reward, no ledger goes negative, and Σ(victim + liquidator +
            // pool) is conserved — a liquidation transfers value, never mints.
            assert_eq!(
                uc_c_after.deposited,
                uc_c_before + reward,
                "liquidator was not credited the penalty reward"
            );
            assert_eq!(
                uc_a_after.deposited,
                uc_a_before.deposited - booked - reward,
                "the victim pays the booked loss and the reward"
            );
            assert_eq!(uc_a_after.reserved, 0, "the single side released all backing");
            assert!(
                uc_a_after.reserved <= uc_a_after.deposited,
                "liquidated reserved > deposited"
            );
            assert_eq!(
                market_state(&env).await.pnl_pool,
                pool_before + booked,
                "the account loss is booked into the pool"
            );
            assert_eq!(
                (uc_a_after.deposited as u128)
                    + (uc_c_after.deposited as u128)
                    + (market_state(&env).await.pnl_pool as u128),
                (uc_a_before.deposited as u128)
                    + (uc_c_before as u128)
                    + (pool_before as u128),
                "a liquidation conserves Σ(victim + liquidator + pool)"
            );
            assert_eq!(vb_after, vb_before, "liquidation must not move vault tokens");
        });
    }
}
