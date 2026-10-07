//! Bank-style CPI integration tests for the operator-delegation surface
//! (product-v2 workstream A1, REQ-A1-1..A1-6; `.plan/07-10-2026/product-v2/`).
//!
//! Same harness pattern as `positions_cpi.rs` / `collateral_cpi.rs`: the real
//! Fructus program is loaded as a compiled SBF binary (Anchor 1.x routes CPI
//! through `solana-invoke`, which is SBF-only), SPL Token runs in-process, a
//! fake jitoSOL stake-pool account is the market-bound index source, and each
//! test builds its own fully-wired bank (market, collateral vault, minted
//! USDC, funded users, seeded order book).
//!
//! Scenarios (one per acceptance row, deterministic — no proptest here; the
//! pure-predicate half of OPERATOR-AUTH-MATRIX lives in `src/operator.rs`):
//!
//! * `set_operator_creates_rotates_revokes`      — SET-OPERATOR-CREATES-ROTATES-REVOKES
//! * `set_operator_is_user_only`                 — SET-OPERATOR-IS-USER-ONLY
//! * `operator_deposit_moves_funds_for_user`     — OPERATOR-DEPOSIT-MOVES-FUNDS-FOR-USER
//! * `operator_deposit_requires_approval`        — OPERATOR-DEPOSIT-REQUIRES-APPROVAL
//! * `operator_withdraw_pays_only_the_user`      — OPERATOR-WITHDRAW-PAYS-ONLY-THE-USER
//! * `operator_orders_attribute_to_the_user`     — OPERATOR-ORDERS-ATTRIBUTE-TO-THE-USER
//! * `operator_auth_matrix_rejects_unauthorized` — OPERATOR-AUTH-MATRIX (bank half)
//!
//! These tests are RED by design against the product-v2 stub: every `operator_*`
//! handler still returns `OperatorUnauthorized` unconditionally and
//! `set_operator` writes nothing. `bind(user, operator)` is the documented
//! one-time approval `[SPL approve(delegate = Operator PDA, u64::MAX),
//! set_operator(operator)]`, submitted as a single user-signed transaction.

use std::path::{Path, PathBuf};
use std::rc::Rc;

use anchor_lang::{AccountDeserialize, AccountSerialize, Discriminator, InstructionData};
use fructus::constants::{
    OPERATOR_SEED, ORDER_BOOK_SEED, PERP_MARKET_SEED, POSITION_SEED, USER_COLLATERAL_SEED,
    VAULT_SEED,
};
use fructus::error::FructusError;
use fructus::exchange::STAKE_POOL_PROGRAM_ID;
use fructus::state::{Operator, OrderBook, Position, UserCollateral};
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
/// Lamports used to fund the pre-created accounts (mint, users, operators).
const FUNDING_LAMPORTS: u64 = 10_000_000_000;
/// Notional of one fill-sized order, in USDC microunits (1 USDC).
const SIZE: u64 = 1_000_000;
/// Initial margin in basis points (10x leverage): margin == ceil(notional / 10).
const INITIAL_MARGIN_BPS: u16 = 1_000;
/// Position/open side encodings: 0 = Long/Bid, 1 = Short/Ask.
const LONG: u8 = 0;
const SHORT: u8 = 1;
/// Fake stake-pool `total_lamports` for the base snapshot (rate 1.0).
const BASE_TOTAL_LAMPORTS: u64 = 10_000_000_000_000;
/// Fake stake-pool `pool_token_supply` (rate 1.0 when `total_lamports` matches).
const BASE_POOL_TOKEN_SUPPLY: u64 = 10_000_000_000_000;

/// The system program id is the all-zero pubkey (`11111111111111111111111111111111`).
fn system_program_id() -> Pubkey {
    Pubkey::default()
}

/// Read-only, non-signer account meta.
fn ro(key: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(key, false)
}
/// Writable, non-signer account meta.
fn wr(key: Pubkey) -> AccountMeta {
    AccountMeta::new(key, false)
}
/// Read-only signer account meta.
fn signer(key: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(key, true)
}
/// Writable signer account meta.
fn signer_mut(key: Pubkey) -> AccountMeta {
    AccountMeta::new(key, true)
}

/// Locate the compiled Fructus SBF binary.
///
/// The documented bank/e2e build flow (docs/testing.md) stages the artifact at
/// `target/deploy/fructus.so` (`cargo build-sbf --arch v0 … --sbf-out-dir
/// target/deploy-v0` + `cp`), so that copy is preferred; the plain
/// `cargo build-sbf` leftover under `target/sbpf-solana-solana/release/` is a
/// different (non-v0) byte image and only a fallback.
fn find_fructus_so() -> Option<PathBuf> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        manifest.join("../../target/deploy/fructus.so"),
        manifest.join("../../target/sbpf-solana-solana/release/fructus.so"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

/// Bytes for a fake SPL Stake Pool account, enough for the handler's
/// `read_stake_pool` validation to succeed: the `StakePool` account-type
/// discriminator (byte 0) plus non-zero `total_lamports` / `pool_token_supply`
/// at the canonical offsets (258 / 266, with the `account_type` prefix — do not
/// "fix" to 257/265).
fn fake_stake_pool_data() -> Vec<u8> {
    let mut data = vec![0u8; 274];
    data[0] = 1; // AccountType::StakePool
    data[258..266].copy_from_slice(&BASE_TOTAL_LAMPORTS.to_le_bytes()); // total_lamports
    data[266..274].copy_from_slice(&BASE_POOL_TOKEN_SUPPLY.to_le_bytes()); // pool_token_supply
    data
}

/// Serialized, initialized SPL Token `Account` state for a pre-funded account.
///
/// Used to seed token accounts directly in the bank (the modern ATA program
/// unconditionally initializes the Token-2022 `ImmutableOwner` extension, which
/// plain Tokenkeg rejects).
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

/// Rent-exempt minimum for an account of `size` bytes.
fn rent_min(size: usize) -> u64 {
    solana_rent::Rent::default().minimum_balance(size).max(1)
}

/// One `(market, user)` party: signer keypair (shared via `Rc` so a `User` is
/// cheaply cloneable) plus the derived PDAs.
#[derive(Clone)]
struct User {
    keypair: Rc<Keypair>,
    ata: Pubkey,
    user_collateral: Pubkey,
    long: Pubkey,
    short: Pubkey,
}

impl User {
    fn pubkey(&self) -> Pubkey {
        self.keypair.pubkey()
    }

    fn position(&self, side: u8) -> Pubkey {
        if side == LONG {
            self.long
        } else {
            self.short
        }
    }
}

/// A fully-wired test environment: program + SPL programs loaded, collateral
/// mint created, two funded users (A = subject, B = maker) each with a funded
/// ATA, the `PerpMarket`, the seeded `OrderBook`, and the collateral vault.
/// Users are NOT deposited in `setup` — each test seeds the ledgers it needs
/// through the direct (implemented) `deposit_collateral` path so operator
/// scenarios stay orthogonal to operator-deposit behaviour.
struct Env {
    ctx: ProgramTestContext,
    market: Pubkey,
    vault: Pubkey,
    mint: Pubkey,
    order_book: Pubkey,
    stake_pool: Pubkey,
    a: User,
    b: User,
}

async fn setup() -> Option<Env> {
    let program_id = fructus::ID;

    let so = match find_fructus_so() {
        Some(so) => so,
        None => {
            eprintln!(
                "skipping operator CPI test: fructus.so not found; \
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
            lamports: rent_min(so_bytes.len()),
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

    // Two funded users + their (empty) ATAs, seeded directly in the bank.
    let mut user_seeds = Vec::with_capacity(2);
    for _ in 0..2 {
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

    let market = Pubkey::find_program_address(&[PERP_MARKET_SEED], &program_id).0;
    let vault = Pubkey::find_program_address(&[VAULT_SEED], &program_id).0;

    // Seed a fully-initialized OrderBook directly in the bank (byte-identical
    // to what `initialize_order_book` writes: discriminator + zeroed struct
    // with market/bump set) — the same shortcut `positions_cpi` takes.
    let (order_book, order_book_bump) =
        Pubkey::find_program_address(&[ORDER_BOOK_SEED, market.as_ref()], &program_id);
    pt.add_account(
        order_book,
        Account {
            lamports: rent_min(8 + OrderBook::LEN),
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
            wr(market),                     // market (init)
            ro(stake_pool),                 // index_source
            signer(ctx.payer.pubkey()),     // authority (signer)
            signer_mut(ctx.payer.pubkey()), // payer (signer, mut)
            ro(system_program_id()),        // system_program
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
        a: make_user(&market, user_seeds.remove(0)),
        b: make_user(&market, user_seeds.remove(0)),
    };

    // 4. Collateral vault (authority-gated). Ledgers are deposited per-test.
    initialize_vault(&mut env)
        .await
        .expect("initialize_collateral_vault");

    Some(env)
}

/// Derive a `User`'s PDAs from the market key.
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

/// The per-`(market, user)` delegation-record PDA (`[OPERATOR_SEED, market, user]`).
fn operator_pda(market: &Pubkey, user: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[OPERATOR_SEED, market.as_ref(), user.as_ref()],
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

/// Submit one instruction from `fee_payer`'s transaction **without** the
/// subject's signature, while the instruction still lists the subject as a
/// signer. The runtime's signature verification is the only gate that must
/// reject this (`Transaction::sign` requires every listed signer, so the
/// transaction is built and then only partially signed).
async fn submit_without_subject_signature(
    env: &mut Env,
    ix: Instruction,
    fee_payer: &Keypair,
) -> Result<(), BanksClientError> {
    let blockhash = env.ctx.get_new_latest_blockhash().await.unwrap();
    let mut tx = Transaction::new_with_payer(&[ix], Some(&fee_payer.pubkey()));
    tx.partial_sign(&[fee_payer], blockhash);
    env.ctx.banks_client.process_transaction(tx).await
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

/// Assert a transaction failed with `OperatorUnauthorized`, with scenario context.
fn assert_operator_unauthorized(result: Result<(), BanksClientError>, what: &str) {
    let code = u32::from(FructusError::OperatorUnauthorized);
    match result {
        Ok(()) => panic!("{what}: expected OperatorUnauthorized (code {code}), got Ok"),
        Err(BanksClientError::TransactionError(TransactionError::InstructionError(
            _,
            SolanaInstructionError::Custom(c),
        ))) => assert_eq!(c, code, "{what}: wrong anchor error code"),
        Err(e) => panic!("{what}: expected OperatorUnauthorized (code {code}), got {e:?}"),
    }
}

// --- Instruction builders ----------------------------------------------------
// Account order matches the `#[derive(Accounts)]` structs in lib.rs and the
// PRD Appendix (normative), top to bottom.

/// Account data for a fully-initialized `OrderBook` (discriminator + zeroed
/// struct with `market`/`bump` set).
fn initialized_order_book_data(market: &Pubkey, bump: u8) -> Vec<u8> {
    let mut book = OrderBook::default();
    book.market = *market;
    book.bump = bump;
    let mut data = Vec::with_capacity(8 + OrderBook::LEN);
    data.extend_from_slice(<OrderBook as Discriminator>::DISCRIMINATOR);
    data.extend_from_slice(bytemuck::bytes_of(&book));
    data
}

/// `initialize_collateral_vault`: market, authority (S), payer (S, mut),
/// vault (mut), collateral_mint, system_program, token_program.
async fn initialize_vault(env: &mut Env) -> Result<(), BanksClientError> {
    let data = fructus::instruction::InitializeCollateralVault.data();
    let authority = env.ctx.payer.pubkey();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            ro(env.market),
            signer(authority),
            signer_mut(authority),
            wr(env.vault),
            ro(env.mint),
            ro(system_program_id()),
            ro(spl_token::id()),
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[]).await
}

/// Direct (user-signed) `deposit_collateral` — used to seed ledgers: user
/// (S, mut), market (mut), user_collateral (mut), vault (mut), user_ata (mut),
/// collateral_mint, system_program, token_program.
async fn deposit(env: &mut Env, user: &User, amount: u64) -> Result<(), BanksClientError> {
    let data = fructus::instruction::DepositCollateral { amount }.data();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            signer_mut(user.pubkey()),
            wr(env.market),
            wr(user.user_collateral),
            wr(env.vault),
            wr(user.ata),
            ro(env.mint),
            ro(system_program_id()),
            ro(spl_token::id()),
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[user.keypair.as_ref()]).await
}

/// Direct (owner-signed) `place_limit_order` — used for maker counterparties:
/// order_book (mut), market, index_source, owner (S).
async fn place_limit_order(
    env: &mut Env,
    user: &User,
    side: u8,
    price: u64,
    size: u64,
) -> Result<(), BanksClientError> {
    let data = fructus::instruction::PlaceLimitOrder { side, price, size }.data();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            wr(env.order_book),
            ro(env.market),
            ro(env.stake_pool),
            signer(user.pubkey()),
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[user.keypair.as_ref()]).await
}

/// SPL `approve`: delegate the user's ATA to `delegate` for `amount`.
async fn approve(
    env: &mut Env,
    user: &User,
    delegate: &Pubkey,
    amount: u64,
) -> Result<(), BanksClientError> {
    let ix = spl_token::instruction::approve(
        &spl_token::id(),
        &user.ata,
        delegate,
        &user.pubkey(),
        &[],
        amount,
    )
    .expect("spl approve builds");
    submit(&mut env.ctx, vec![ix], &[user.keypair.as_ref()]).await
}

/// `set_operator(operator)` — pure builder; the subject user is the signer:
/// user (S, mut), market, operator_record (mut), system_program.
fn set_operator_ix(env: &Env, user: &User, operator: Pubkey) -> Instruction {
    let data = fructus::instruction::SetOperator { operator }.data();
    Instruction {
        program_id: fructus::ID,
        accounts: vec![
            signer_mut(user.pubkey()),
            ro(env.market),
            wr(operator_pda(&env.market, &user.pubkey())),
            ro(system_program_id()),
        ],
        data,
    }
}

/// Submit `set_operator` with the subject's own signature.
async fn set_operator(
    env: &mut Env,
    user: &User,
    operator: Pubkey,
) -> Result<(), BanksClientError> {
    let ix = set_operator_ix(env, user, operator);
    submit(&mut env.ctx, vec![ix], &[user.keypair.as_ref()]).await
}

/// `bind(user, operator)`: the one-time delegation approval, one user-signed
/// transaction carrying `[SPL approve(delegate = Operator PDA, u64::MAX),
/// set_operator(operator)]`.
async fn bind(env: &mut Env, user: &User, operator: Pubkey) -> Result<(), BanksClientError> {
    let approve_ix = spl_token::instruction::approve(
        &spl_token::id(),
        &user.ata,
        &operator_pda(&env.market, &user.pubkey()),
        &user.pubkey(),
        &[],
        u64::MAX,
    )
    .expect("spl approve builds");
    let set_ix = set_operator_ix(env, user, operator);
    submit(
        &mut env.ctx,
        vec![approve_ix, set_ix],
        &[user.keypair.as_ref()],
    )
    .await
}

/// `operator_deposit_collateral(amount)` — the operator is the only signer:
/// operator (S, mut), user, market (mut), user_collateral (mut),
/// operator_record, vault (mut), user_ata (mut), collateral_mint,
/// token_program, system_program.
async fn op_deposit(
    env: &mut Env,
    operator: &Keypair,
    subject: &User,
    amount: u64,
) -> Result<(), BanksClientError> {
    let data = fructus::instruction::OperatorDepositCollateral { amount }.data();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            signer_mut(operator.pubkey()),
            ro(subject.pubkey()),
            wr(env.market),
            wr(subject.user_collateral),
            ro(operator_pda(&env.market, &subject.pubkey())),
            wr(env.vault),
            wr(subject.ata),
            ro(env.mint),
            ro(spl_token::id()),
            ro(system_program_id()),
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[operator]).await
}

/// `operator_withdraw_collateral(amount)` to the subject's own ATA.
async fn op_withdraw(
    env: &mut Env,
    operator: &Keypair,
    subject: &User,
    amount: u64,
) -> Result<(), BanksClientError> {
    op_withdraw_to(env, operator, subject, amount, &subject.ata).await
}

/// `operator_withdraw_collateral(amount)` to an arbitrary (attacker-chosen)
/// `user_ata`: operator (S), user, market (mut), user_collateral (mut),
/// operator_record, vault (mut), user_ata (mut), collateral_mint,
/// index_source, position_long, position_short, token_program.
async fn op_withdraw_to(
    env: &mut Env,
    operator: &Keypair,
    subject: &User,
    amount: u64,
    user_ata: &Pubkey,
) -> Result<(), BanksClientError> {
    let data = fructus::instruction::OperatorWithdrawCollateral { amount }.data();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            signer(operator.pubkey()),
            ro(subject.pubkey()),
            wr(env.market),
            wr(subject.user_collateral),
            ro(operator_pda(&env.market, &subject.pubkey())),
            wr(env.vault),
            wr(*user_ata),
            ro(env.mint),
            ro(env.stake_pool),
            ro(subject.long),
            ro(subject.short),
            ro(spl_token::id()),
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[operator]).await
}

/// `operator_open_position(side, size, price)` — `price == 0` is a market (IOC)
/// order: operator (S, mut), user, market, order_book (mut), index_source,
/// position (mut), user_collateral (mut), operator_record, system_program.
async fn op_open(
    env: &mut Env,
    operator: &Keypair,
    subject: &User,
    side: u8,
    size: u64,
    price: u64,
) -> Result<(), BanksClientError> {
    let data = fructus::instruction::OperatorOpenPosition { side, size, price }.data();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            signer_mut(operator.pubkey()),
            ro(subject.pubkey()),
            ro(env.market),
            wr(env.order_book),
            ro(env.stake_pool),
            wr(subject.position(side)),
            wr(subject.user_collateral),
            ro(operator_pda(&env.market, &subject.pubkey())),
            ro(system_program_id()),
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[operator]).await
}

/// `operator_close_position(side, size)`: operator (S), user, market,
/// order_book (mut), index_source, position (mut), user_collateral (mut),
/// operator_record.
async fn op_close(
    env: &mut Env,
    operator: &Keypair,
    subject: &User,
    side: u8,
    size: u64,
) -> Result<(), BanksClientError> {
    let data = fructus::instruction::OperatorClosePosition { side, size }.data();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            signer(operator.pubkey()),
            ro(subject.pubkey()),
            ro(env.market),
            wr(env.order_book),
            ro(env.stake_pool),
            wr(subject.position(side)),
            wr(subject.user_collateral),
            ro(operator_pda(&env.market, &subject.pubkey())),
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[operator]).await
}

/// Arguments for the two book-order operator instructions.
#[derive(Clone, Copy, Debug)]
enum OpOrderArgs {
    Limit { side: u8, price: u64, size: u64 },
    Market { side: u8, size: u64 },
}

/// `operator_place_limit_order(side, price, size)` and, with `size` only,
/// `operator_place_market_order(side, size)` — same account list: operator (S),
/// user, market, order_book (mut), index_source, operator_record.
async fn op_order(
    env: &mut Env,
    operator: &Keypair,
    subject: &User,
    args: OpOrderArgs,
) -> Result<(), BanksClientError> {
    let data = match args {
        OpOrderArgs::Limit { side, price, size } => {
            fructus::instruction::OperatorPlaceLimitOrder { side, price, size }.data()
        }
        OpOrderArgs::Market { side, size } => {
            fructus::instruction::OperatorPlaceMarketOrder { side, size }.data()
        }
    };
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            signer(operator.pubkey()),
            ro(subject.pubkey()),
            ro(env.market),
            wr(env.order_book),
            ro(env.stake_pool),
            ro(operator_pda(&env.market, &subject.pubkey())),
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[operator]).await
}

/// `operator_cancel_order(seq)`: operator (S), user, market, order_book (mut),
/// operator_record (no index_source on this one).
async fn op_cancel(
    env: &mut Env,
    operator: &Keypair,
    subject: &User,
    seq: u64,
) -> Result<(), BanksClientError> {
    let data = fructus::instruction::OperatorCancelOrder { seq }.data();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            signer(operator.pubkey()),
            ro(subject.pubkey()),
            ro(env.market),
            wr(env.order_book),
            ro(operator_pda(&env.market, &subject.pubkey())),
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[operator]).await
}

// --- The operator surface as a dispatchable set (auth-matrix test) ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OpIx {
    Deposit,
    Withdraw,
    Open,
    Close,
    Limit,
    Market,
    Cancel,
}

/// The seven record-gated `operator_*` instructions.
const OP_IXS: [OpIx; 7] = [
    OpIx::Deposit,
    OpIx::Withdraw,
    OpIx::Open,
    OpIx::Close,
    OpIx::Limit,
    OpIx::Market,
    OpIx::Cancel,
];

impl OpIx {
    fn name(self) -> &'static str {
        match self {
            OpIx::Deposit => "operator_deposit_collateral",
            OpIx::Withdraw => "operator_withdraw_collateral",
            OpIx::Open => "operator_open_position",
            OpIx::Close => "operator_close_position",
            OpIx::Limit => "operator_place_limit_order",
            OpIx::Market => "operator_place_market_order",
            OpIx::Cancel => "operator_cancel_order",
        }
    }
}

/// Invoke one `operator_*` instruction as `operator` for `subject`, with
/// minimal-but-valid arguments (so only the authorization check can reject it).
async fn submit_op(
    env: &mut Env,
    ix: OpIx,
    operator: &Keypair,
    subject: &User,
) -> Result<(), BanksClientError> {
    match ix {
        OpIx::Deposit => op_deposit(env, operator, subject, 1).await,
        OpIx::Withdraw => op_withdraw(env, operator, subject, 1).await,
        OpIx::Open => op_open(env, operator, subject, LONG, 1, 0).await,
        OpIx::Close => op_close(env, operator, subject, LONG, 1).await,
        OpIx::Limit => {
            op_order(
                env,
                operator,
                subject,
                OpOrderArgs::Limit {
                    side: LONG,
                    price: 50_000,
                    size: 1,
                },
            )
            .await
        }
        OpIx::Market => {
            op_order(
                env,
                operator,
                subject,
                OpOrderArgs::Market {
                    side: LONG,
                    size: 1,
                },
            )
            .await
        }
        OpIx::Cancel => op_cancel(env, operator, subject, 0).await,
    }
}

// --- Bank-state readers ------------------------------------------------------

async fn bank_account(env: &Env, key: &Pubkey) -> Option<Account> {
    env.ctx.banks_client.get_account(*key).await.unwrap()
}

async fn account_bytes(env: &Env, key: &Pubkey) -> Option<Vec<u8>> {
    bank_account(env, key).await.map(|a| a.data)
}

async fn record_state(env: &Env, subject: &User) -> Option<Operator> {
    let account = bank_account(env, &operator_pda(&env.market, &subject.pubkey())).await?;
    let mut data: &[u8] = &account.data;
    Operator::try_deserialize(&mut data).ok()
}

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
        .expect("token account exists");
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

/// `margin_required(notional)` mirror of `positions::margin_required` for the
/// market's `INITIAL_MARGIN_BPS`: CEILING `(notional * bps + 9_999) / 10_000`.
fn margin_required(notional: u64) -> u64 {
    (notional as u128 * INITIAL_MARGIN_BPS as u128).div_ceil(10_000) as u64
}

// --- Raw byte views of the zero-copy OrderBook account ----------------------
// Layout mirrors `positions_cpi.rs`: `[8-byte discriminator][header (88) +
// bids (16×64) + asks (16×64) + …]`.

const OB_BIDS_OFF: usize = 8 + 88; // discriminator + header
const OB_ASKS_OFF: usize = OB_BIDS_OFF + 16 * 64;
const OB_EVENTS_OFF: usize = OB_ASKS_OFF + 16 * 64;

#[derive(Debug, Clone)]
struct OrderView {
    active: u8,
    owner: Pubkey,
    price: u64,
    size: u64,
    seq: u64,
}

#[derive(Debug, Clone)]
struct EventView {
    kind: u8,
    side: u8,
    owner: Pubkey,
    counterparty: Pubkey,
    price: u64,
    size: u64,
}

#[derive(Debug, Clone)]
struct BookView {
    best_bid: u64,
    best_ask: u64,
    write_cursor: u64,
    bids: Vec<OrderView>,
    asks: Vec<OrderView>,
    events: Vec<EventView>,
}

impl BookView {
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
    let account = bank_account(env, &env.order_book)
        .await
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
        kind: data[base + 105],
        side: data[base + 106],
        owner: read_pubkey(data, base + 24),
        counterparty: read_pubkey(data, base + 56),
        price: read_u64(data, base + 8),
        size: read_u64(data, base + 16),
    }
}

fn read_u64(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().expect("u64 slice"))
}

fn read_pubkey(data: &[u8], offset: usize) -> Pubkey {
    Pubkey::new_from_array(data[offset..offset + 32].try_into().expect("pubkey slice"))
}

// --- Bank-mutation helpers ---------------------------------------------------

/// Create a fresh funded system account (operator signers must be able to pay
/// the lazy rent for the subject's ledger/position PDAs).
async fn funded_keypair(env: &mut Env) -> Keypair {
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
    keypair
}

/// Create a fresh funded party (system account + ATA + minted USDC) with no
/// `UserCollateral` ledger.
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

/// Seed a token account at an arbitrary address (used for hostile destinations).
async fn seed_token_account(
    env: &mut Env,
    key: &Pubkey,
    mint: &Pubkey,
    owner: &Pubkey,
    amount: u64,
) {
    env.ctx.set_account(
        key,
        &AccountSharedData::from(Account {
            lamports: FUNDING_LAMPORTS,
            data: token_account_data(mint, owner, amount),
            owner: spl_token::id(),
            executable: false,
            rent_epoch: 0,
        }),
    );
}

/// Install a system-owned (empty) account at the subject's operator PDA — the
/// squat the handler must reject with `OperatorPdaSquatted`.
async fn squat_operator_pda(env: &mut Env, subject: &User) {
    let pda = operator_pda(&env.market, &subject.pubkey());
    env.ctx.set_account(
        &pda,
        &AccountSharedData::from(Account {
            lamports: FUNDING_LAMPORTS,
            data: vec![],
            owner: system_program_id(),
            executable: false,
            rent_epoch: 0,
        }),
    );
}

/// Write a program-owned `Operator` record directly at the subject's PDA with
/// caller-chosen field contents — the only way to produce the "record scoped to
/// a different market" state (`set_operator` always stamps the live market).
async fn seed_operator_record(
    env: &mut Env,
    subject: &Pubkey,
    record_market: &Pubkey,
    record_user: &Pubkey,
    record_operator: &Pubkey,
) {
    let pda = operator_pda(&env.market, subject);
    let (_, bump) = Pubkey::find_program_address(
        &[OPERATOR_SEED, env.market.as_ref(), subject.as_ref()],
        &fructus::ID,
    );
    let record = Operator {
        market: *record_market,
        user: *record_user,
        operator: *record_operator,
        bump,
    };
    let mut data = Vec::new();
    record
        .try_serialize(&mut data)
        .expect("serialize operator record");
    env.ctx.set_account(
        &pda,
        &AccountSharedData::from(Account {
            lamports: rent_min(data.len()),
            data,
            owner: fructus::ID,
            executable: false,
            rent_epoch: 0,
        }),
    );
}

/// Everything a rejected attempt must leave untouched, for one subject.
#[derive(Debug, PartialEq, Eq)]
struct SubjectState {
    book: Vec<u8>,
    ledger: Option<Vec<u8>>,
    long: Option<Vec<u8>>,
    short: Option<Vec<u8>>,
    ata: u64,
    vault: u64,
}

async fn subject_state(env: &Env, subject: &User) -> SubjectState {
    SubjectState {
        book: account_bytes(env, &env.order_book)
            .await
            .expect("order book"),
        ledger: account_bytes(env, &subject.user_collateral).await,
        long: account_bytes(env, &subject.long).await,
        short: account_bytes(env, &subject.short).await,
        ata: ata_balance(env, &subject.ata).await,
        vault: vault_balance(env).await,
    }
}

fn assert_state_unchanged(before: &SubjectState, after: &SubjectState, what: &str) {
    assert_eq!(
        after.ledger, before.ledger,
        "{what}: subject ledger changed"
    );
    assert_eq!(
        after.long, before.long,
        "{what}: subject long position changed"
    );
    assert_eq!(
        after.short, before.short,
        "{what}: subject short position changed"
    );
    assert_eq!(after.ata, before.ata, "{what}: subject ATA balance changed");
    assert_eq!(after.vault, before.vault, "{what}: vault balance changed");
    assert!(
        after.book == before.book,
        "{what}: order book was mutated by a rejected attempt"
    );
}

// --- Test 1: SET-OPERATOR-CREATES-ROTATES-REVOKES (REQ-A1-2) ----------------

/// `bind` lazily creates the per-`(market, user)` record; `set_operator`
/// overwrites it on rotate; `Pubkey::default()` stores the revoke state (the
/// record is kept — program-owned, rent-funded, never closed); re-binding
/// restores; a system-owned squat on the PDA is rejected with
/// `OperatorPdaSquatted` and never reclaimed.
#[tokio::test]
async fn set_operator_creates_rotates_revokes() {
    let Some(mut env) = setup().await else {
        return;
    };
    let a = env.a.clone();
    let op1 = funded_keypair(&mut env).await;
    let op2 = funded_keypair(&mut env).await;
    let pda = operator_pda(&env.market, &a.pubkey());

    // 1. Lazily created by the user's bind (approve + set_operator).
    bind(&mut env, &a, op1.pubkey())
        .await
        .expect("bind the first operator");
    let rec = record_state(&env, &a)
        .await
        .expect("record exists and decodes after the first bind");
    assert_eq!(rec.operator, op1.pubkey(), "the operator field is stored");
    assert_eq!(rec.market, env.market, "record scoped to the market");
    assert_eq!(rec.user, a.pubkey(), "record scoped to the subject");
    let acct = bank_account(&env, &pda)
        .await
        .expect("record account exists after create");
    assert_eq!(acct.owner, fructus::ID, "record is program-owned");
    assert!(
        acct.lamports >= rent_min(8 + Operator::LEN),
        "record is rent-funded"
    );
    assert_eq!(
        acct.data.len(),
        8 + Operator::LEN,
        "97-byte payload + discriminator"
    );
    let bound_bytes = acct.data.clone();

    // 2. Rotate: the record is overwritten with the second key.
    set_operator(&mut env, &a, op2.pubkey())
        .await
        .expect("rotate to the second operator");
    let rec = record_state(&env, &a)
        .await
        .expect("record still exists after rotate");
    assert_eq!(rec.operator, op2.pubkey(), "rotated to the second key");
    assert_eq!(rec.market, env.market);
    assert_eq!(rec.user, a.pubkey());

    // 3. Revoke: stored as Pubkey::default(), the account is kept (no close).
    set_operator(&mut env, &a, Pubkey::default())
        .await
        .expect("revoke");
    let rec = record_state(&env, &a)
        .await
        .expect("record still decodes after revoke (never closed)");
    assert_eq!(
        rec.operator,
        Pubkey::default(),
        "revoke state is Pubkey::default()"
    );
    let acct = bank_account(&env, &pda)
        .await
        .expect("record account kept after revoke");
    assert_eq!(acct.owner, fructus::ID, "still program-owned after revoke");
    assert!(
        acct.lamports >= rent_min(8 + Operator::LEN),
        "still rent-funded after revoke"
    );
    assert_ne!(acct.data, bound_bytes, "the stored bytes changed on revoke");

    // 4. Re-bind restores a live delegation.
    set_operator(&mut env, &a, op1.pubkey())
        .await
        .expect("re-bind");
    let rec = record_state(&env, &a)
        .await
        .expect("record exists after re-bind");
    assert_eq!(rec.operator, op1.pubkey(), "re-bind restores");

    // 5. A system-owned account squatting the PDA is rejected, never reclaimed.
    let squatted_user = fresh_user(&mut env).await;
    squat_operator_pda(&mut env, &squatted_user).await;
    assert_anchor_error(
        set_operator(&mut env, &squatted_user, op1.pubkey()).await,
        FructusError::OperatorPdaSquatted,
    );
    let squat = bank_account(&env, &operator_pda(&env.market, &squatted_user.pubkey()))
        .await
        .expect("squat account kept");
    assert_eq!(
        squat.owner,
        system_program_id(),
        "the squat is not reclaimed"
    );
}

// --- Test 2: SET-OPERATOR-IS-USER-ONLY (REQ-A1-2) ---------------------------

/// Only the subject user's signature mutates the record: a stranger signing
/// while the subject is listed as signer (and the operator key itself) cannot
/// write it; the record bytes stay identical; the user can still rotate and
/// revoke afterwards.
#[tokio::test]
async fn set_operator_is_user_only() {
    let Some(mut env) = setup().await else {
        return;
    };
    let a = env.a.clone();
    let op = funded_keypair(&mut env).await;
    let stranger = funded_keypair(&mut env).await;
    let pda = operator_pda(&env.market, &a.pubkey());

    // 1. The subject's own signature creates the record.
    bind(&mut env, &a, op.pubkey())
        .await
        .expect("the subject binds an operator");
    let rec = record_state(&env, &a)
        .await
        .expect("record exists after the subject-signed bind");
    assert_eq!(rec.operator, op.pubkey());
    let before = account_bytes(&env, &pda).await.expect("record bytes");

    // 2. A transaction that lists the subject as signer but withholds the
    //    subject's signature must fail in signature verification.
    let impostor_ix = set_operator_ix(&env, &a, stranger.pubkey());
    let result = submit_without_subject_signature(&mut env, impostor_ix, &stranger).await;
    assert!(
        result.is_err(),
        "set_operator without the subject's signature must fail"
    );
    assert_eq!(
        account_bytes(&env, &pda).await,
        Some(before.clone()),
        "record byte-unchanged by the missing-signature attempt"
    );

    // 3. The delegated operator key cannot rewrite the record either.
    let operator_ix = set_operator_ix(&env, &a, op.pubkey());
    let result = submit_without_subject_signature(&mut env, operator_ix, &op).await;
    assert!(
        result.is_err(),
        "set_operator signed by the operator key (subject unsigned) must fail"
    );
    assert_eq!(
        account_bytes(&env, &pda).await,
        Some(before.clone()),
        "record byte-unchanged by the operator-key attempt"
    );

    // 4. The user can still rotate, then revoke.
    set_operator(&mut env, &a, stranger.pubkey())
        .await
        .expect("the user rotates");
    let rec = record_state(&env, &a).await.expect("record exists");
    assert_eq!(rec.operator, stranger.pubkey(), "user-signed rotate lands");
    set_operator(&mut env, &a, Pubkey::default())
        .await
        .expect("the user revokes");
    let rec = record_state(&env, &a).await.expect("record exists");
    assert_eq!(rec.operator, Pubkey::default(), "user-signed revoke lands");
}

// --- Test 3: OPERATOR-DEPOSIT-MOVES-FUNDS-FOR-USER (REQ-A1-3) ---------------

/// With the bind approval in place, `operator_deposit_collateral` moves USDC
/// user ATA → vault and credits the subject's ledger with the operator as the
/// only signer; a second deposit accumulates; amount 0 is `InvalidSize`.
#[tokio::test]
async fn operator_deposit_moves_funds_for_user() {
    let Some(mut env) = setup().await else {
        return;
    };
    let a = env.a.clone();
    let op = funded_keypair(&mut env).await;
    bind(&mut env, &a, op.pubkey())
        .await
        .expect("bind + approve (the one-time user signature)");

    let before_ata = ata_balance(&env, &a.ata).await;
    let before_vault = vault_balance(&env).await;

    // Only the operator signs this transaction.
    op_deposit(&mut env, &op, &a, 300_000)
        .await
        .expect("operator deposit moves user -> vault");
    assert_eq!(
        ata_balance(&env, &a.ata).await,
        before_ata - 300_000,
        "subject ATA debited"
    );
    assert_eq!(
        vault_balance(&env).await,
        before_vault + 300_000,
        "vault credited"
    );
    let uc = user_collateral_state(&env, &a.user_collateral)
        .await
        .expect("ledger lazily created by the operator deposit");
    assert_eq!(uc.deposited, 300_000, "subject ledger credited");
    assert_eq!(uc.reserved, 0);

    // A second deposit accumulates on the same ledger.
    op_deposit(&mut env, &op, &a, 200_000)
        .await
        .expect("second operator deposit");
    let uc = user_collateral_state(&env, &a.user_collateral)
        .await
        .expect("ledger exists");
    assert_eq!(uc.deposited, 500_000, "deposits accumulate");
    assert_eq!(ata_balance(&env, &a.ata).await, before_ata - 500_000);
    assert_eq!(vault_balance(&env).await, before_vault + 500_000);

    // Nothing is ever booked under the operator's own key.
    assert!(
        user_collateral_state(&env, &user_collateral_pda(&env.market, &op.pubkey()))
            .await
            .is_none(),
        "no ledger under the operator key"
    );

    // Amount 0 is rejected before any movement.
    assert_anchor_error(
        op_deposit(&mut env, &op, &a, 0).await,
        FructusError::InvalidSize,
    );
    assert_eq!(
        ata_balance(&env, &a.ata).await,
        before_ata - 500_000,
        "ATA unchanged by the zero-amount reject"
    );
    assert_eq!(vault_balance(&env).await, before_vault + 500_000);
    let uc = user_collateral_state(&env, &a.user_collateral)
        .await
        .expect("ledger exists");
    assert_eq!(uc.deposited, 500_000, "ledger unchanged by the reject");
}

// --- Test 4: OPERATOR-DEPOSIT-REQUIRES-APPROVAL (REQ-A1-3) ------------------

/// Without an SPL approval ≥ amount the instruction fails and every balance is
/// unchanged; with the exact allowance it succeeds.
#[tokio::test]
async fn operator_deposit_requires_approval() {
    let Some(mut env) = setup().await else {
        return;
    };
    let a = env.a.clone();
    let op = funded_keypair(&mut env).await;
    let pda = operator_pda(&env.market, &a.pubkey());

    // (a) Record only — no SPL approval at all.
    set_operator(&mut env, &a, op.pubkey())
        .await
        .expect("set operator without approving");
    let before_ata = ata_balance(&env, &a.ata).await;
    let before_vault = vault_balance(&env).await;
    let result = op_deposit(&mut env, &op, &a, 10_000).await;
    assert!(result.is_err(), "deposit without an SPL approval must fail");
    assert_eq!(
        ata_balance(&env, &a.ata).await,
        before_ata,
        "no ATA movement without approval"
    );
    assert_eq!(vault_balance(&env).await, before_vault);
    assert!(
        user_collateral_state(&env, &a.user_collateral)
            .await
            .is_none(),
        "no ledger mutation persists without approval"
    );

    // (b) Short allowance: approve 5, deposit 6.
    approve(&mut env, &a, &pda, 5)
        .await
        .expect("approve a 5-microunit allowance");
    let result = op_deposit(&mut env, &op, &a, 6).await;
    assert!(
        result.is_err(),
        "deposit above the approved allowance must fail"
    );
    assert_eq!(ata_balance(&env, &a.ata).await, before_ata);
    assert_eq!(vault_balance(&env).await, before_vault);
    assert!(
        user_collateral_state(&env, &a.user_collateral)
            .await
            .is_none(),
        "no ledger mutation persists under a short allowance"
    );

    // (c) Positive leg: the exact allowance is enough.
    approve(&mut env, &a, &pda, 6)
        .await
        .expect("approve the exact allowance");
    op_deposit(&mut env, &op, &a, 6)
        .await
        .expect("exact-allowance deposit succeeds");
    assert_eq!(ata_balance(&env, &a.ata).await, before_ata - 6);
    assert_eq!(vault_balance(&env).await, before_vault + 6);
    let uc = user_collateral_state(&env, &a.user_collateral)
        .await
        .expect("ledger created");
    assert_eq!(uc.deposited, 6);
}

// --- Test 5: OPERATOR-WITHDRAW-PAYS-ONLY-THE-USER (REQ-A1-4) ----------------

/// The operator can only pay the subject's own ATA: the own-ATA call succeeds
/// (the equity gate sees no positions ⇒ req = 0 / pnl = 0), while a
/// foreign-owned destination and a wrong-mint destination both fail with no
/// token movement.
#[tokio::test]
async fn operator_withdraw_pays_only_the_user() {
    let Some(mut env) = setup().await else {
        return;
    };
    let a = env.a.clone();
    let op = funded_keypair(&mut env).await;
    let mint = env.mint;

    // Seed the ledger through the direct path (operator deposits are exercised
    // by the two deposit tests above).
    deposit(&mut env, &a, 1_000_000)
        .await
        .expect("subject deposits");
    bind(&mut env, &a, op.pubkey())
        .await
        .expect("bind + approve");

    // 1. To the subject's own ATA: succeeds.
    let before_ata = ata_balance(&env, &a.ata).await;
    let before_vault = vault_balance(&env).await;
    op_withdraw(&mut env, &op, &a, 400_000)
        .await
        .expect("operator withdraw to the subject's own ATA");
    assert_eq!(
        ata_balance(&env, &a.ata).await,
        before_ata + 400_000,
        "the subject's ATA is paid"
    );
    assert_eq!(
        vault_balance(&env).await,
        before_vault - 400_000,
        "tokens left the vault"
    );
    let uc = user_collateral_state(&env, &a.user_collateral)
        .await
        .expect("ledger exists");
    assert_eq!(uc.deposited, 600_000, "ledger debited");

    // 2. A foreign-owned destination fails; nothing moves.
    let f = funded_keypair(&mut env).await;
    let foreign_ata = get_associated_token_address(&f.pubkey(), &mint);
    seed_token_account(&mut env, &foreign_ata, &mint, &f.pubkey(), 0).await;
    let result = op_withdraw_to(&mut env, &op, &a, 100_000, &foreign_ata).await;
    assert!(
        result.is_err(),
        "a foreign-owned destination must be rejected"
    );
    assert_eq!(
        ata_balance(&env, &foreign_ata).await,
        0,
        "the foreign account received nothing"
    );
    assert_eq!(vault_balance(&env).await, before_vault - 400_000);
    assert_eq!(
        user_collateral_state(&env, &a.user_collateral)
            .await
            .unwrap()
            .deposited,
        600_000,
        "ledger untouched by the foreign-destination reject"
    );

    // 3. A wrong-mint destination fails; nothing moves.
    let other_mint = funded_keypair(&mut env).await;
    let wrong_mint_ata = get_associated_token_address(&a.pubkey(), &other_mint.pubkey());
    seed_token_account(
        &mut env,
        &wrong_mint_ata,
        &other_mint.pubkey(),
        &a.pubkey(),
        0,
    )
    .await;
    let result = op_withdraw_to(&mut env, &op, &a, 100_000, &wrong_mint_ata).await;
    assert!(result.is_err(), "a wrong-mint destination must be rejected");
    assert_eq!(
        ata_balance(&env, &wrong_mint_ata).await,
        0,
        "the wrong-mint account received nothing"
    );
    assert_eq!(vault_balance(&env).await, before_vault - 400_000);
    assert_eq!(
        user_collateral_state(&env, &a.user_collateral)
            .await
            .unwrap()
            .deposited,
        600_000,
        "ledger untouched by the wrong-mint reject"
    );

    // 4. The operator still has no ledger or positions of its own.
    assert!(
        user_collateral_state(&env, &user_collateral_pda(&env.market, &op.pubkey()))
            .await
            .is_none(),
        "no ledger under the operator key"
    );
    assert!(
        position_state(&env, &position_pda(&env.market, &op.pubkey(), LONG))
            .await
            .is_none(),
        "no position under the operator key"
    );
}

// --- Test 6: OPERATOR-ORDERS-ATTRIBUTE-TO-THE-USER (REQ-A1-5) ---------------

/// Every order/position an operator places, opens, closes or cancels is
/// attributed to the SUBJECT user: the book row is owned by the subject, the
/// position PDA under the subject's key is created/updated, the subject's
/// ledger reserves and releases margin, and nothing ever appears under the
/// operator's own key.
#[tokio::test]
async fn operator_orders_attribute_to_the_user() {
    let Some(mut env) = setup().await else {
        return;
    };
    let a = env.a.clone(); // subject
    let b = env.b.clone(); // maker counterparty
    let op = funded_keypair(&mut env).await;
    let op_pub = op.pubkey();

    deposit(&mut env, &a, 1_000_000)
        .await
        .expect("subject deposits margin");
    deposit(&mut env, &b, 1_000_000)
        .await
        .expect("maker deposits");
    bind(&mut env, &a, op.pubkey())
        .await
        .expect("bind + approve");

    // 1. A limit order placed by the operator rests under the SUBJECT's key.
    let pa = 90_000u64;
    op_order(
        &mut env,
        &op,
        &a,
        OpOrderArgs::Limit {
            side: LONG,
            price: pa,
            size: SIZE,
        },
    )
    .await
    .expect("operator places a resting limit order for the subject");
    let book = book_view(&env).await;
    assert_eq!(book.best_bid, pa);
    assert_eq!(book.resting_bids(), 1);
    assert_eq!(book.write_cursor, 0, "a resting order emits no event");
    let slot = book
        .bids
        .iter()
        .find(|o| o.active != 0)
        .expect("the subject's resting bid")
        .clone();
    assert_eq!(
        slot.owner,
        a.pubkey(),
        "order attributed to the SUBJECT, not the operator"
    );
    assert_ne!(slot.owner, op_pub, "never the operator key");
    assert_eq!(slot.price, pa);
    assert_eq!(slot.size, SIZE);
    let cancel_seq = slot.seq;

    // 2. The operator cancels the subject's resting order.
    op_cancel(&mut env, &op, &a, cancel_seq)
        .await
        .expect("operator cancels the subject's order");
    let book = book_view(&env).await;
    assert_eq!(book.resting_bids(), 0, "the subject's order was removed");
    assert_eq!(book.best_bid, 0);

    // 3. Maker B rests an ask; the operator opens a long for the subject.
    let pb = 200_000u64;
    place_limit_order(&mut env, &b, SHORT, pb, SIZE)
        .await
        .expect("maker B rests an ask");
    let book = book_view(&env).await;
    assert_eq!(book.best_ask, pb, "maker B's ask rests at its price");
    op_open(&mut env, &op, &a, LONG, SIZE, 0)
        .await
        .expect("operator opens a long for the subject");
    let pos = position_state(&env, &a.long)
        .await
        .expect("the SUBJECT's position is created");
    assert_eq!(
        pos.owner,
        a.pubkey(),
        "position attributed to the SUBJECT, not the operator"
    );
    assert_ne!(pos.owner, op_pub);
    assert_eq!(pos.notional, SIZE);
    assert_eq!(pos.side, LONG);
    assert_eq!(pos.collateral, margin_required(SIZE));
    assert!(
        position_state(&env, &position_pda(&env.market, &op_pub, LONG))
            .await
            .is_none(),
        "no long position appears under the operator key"
    );
    assert!(
        position_state(&env, &position_pda(&env.market, &op_pub, SHORT))
            .await
            .is_none(),
        "no short position appears under the operator key"
    );
    let uc_a = user_collateral_state(&env, &a.user_collateral)
        .await
        .expect("subject ledger");
    assert_eq!(
        uc_a.reserved,
        margin_required(SIZE),
        "the SUBJECT's ledger reserved the margin"
    );
    assert!(
        user_collateral_state(&env, &user_collateral_pda(&env.market, &op_pub))
            .await
            .is_none(),
        "no ledger appears under the operator key"
    );
    let book = book_view(&env).await;
    assert_eq!(book.resting_asks(), 0, "maker B's ask was consumed");
    assert_eq!(book.best_ask, 0, "the ask side is empty after the fill");
    let ev = book.event(0);
    assert_eq!(ev.kind, 0, "the crossing fill is recorded");
    assert_eq!(ev.side, SHORT, "the maker rested on the ask side");
    assert_eq!(ev.owner, b.pubkey(), "the maker event belongs to B");
    assert_eq!(
        ev.counterparty,
        a.pubkey(),
        "the taker is the SUBJECT, not the operator"
    );
    assert_eq!(ev.price, pb);
    assert_eq!(ev.size, SIZE);

    // 4. Maker B rests a bid; the operator closes the subject's long.
    let pc = 100_000u64;
    place_limit_order(&mut env, &b, LONG, pc, SIZE)
        .await
        .expect("maker B rests a bid");
    op_close(&mut env, &op, &a, LONG, SIZE)
        .await
        .expect("operator closes the subject's long");
    let pos = position_state(&env, &a.long)
        .await
        .expect("the subject's position is retained");
    assert_eq!(pos.owner, a.pubkey(), "still the subject's position");
    assert_eq!(pos.notional, 0, "reduced to zero");
    assert_eq!(pos.collateral, 0, "margin released");
    let uc_a = user_collateral_state(&env, &a.user_collateral)
        .await
        .expect("subject ledger");
    assert_eq!(uc_a.reserved, 0, "subject ledger released all margin");
    assert_eq!(uc_a.deposited, 1_000_000);
    let book = book_view(&env).await;
    assert_eq!(book.resting_bids(), 0, "maker B's bid was consumed");
}

// --- Test 7: OPERATOR-AUTH-MATRIX (REQ-A1-6, bank half) ---------------------

/// For every record-gated `operator_*` instruction × {no record, revoked
/// record, wrong-key signer, record scoped to another market} the call fails
/// with `OperatorUnauthorized` and mutates nothing. Positive control: a
/// properly bound operator CAN act (this leg is RED against the stub). The 8th
/// new instruction, `set_operator`, is the record's own writer — it is not
/// record-gated, so its unauthorized shape (a non-user signer) is asserted
/// separately below.
#[tokio::test]
async fn operator_auth_matrix_rejects_unauthorized() {
    let Some(mut env) = setup().await else {
        return;
    };

    // (a) no record at all.
    let s_none = fresh_user(&mut env).await;
    deposit(&mut env, &s_none, 1_000_000)
        .await
        .expect("seed ledger (withdraw deserializes Account<UserCollateral>)");
    let op_none = funded_keypair(&mut env).await;

    // (b) revoked record (bind then revoke).
    let s_rev = fresh_user(&mut env).await;
    deposit(&mut env, &s_rev, 1_000_000)
        .await
        .expect("seed ledger");
    let op_rev = funded_keypair(&mut env).await;
    bind(&mut env, &s_rev, op_rev.pubkey())
        .await
        .expect("bind before revoke");
    set_operator(&mut env, &s_rev, Pubkey::default())
        .await
        .expect("revoke");

    // (c) a valid record, but a different signer.
    let s_wk = fresh_user(&mut env).await;
    deposit(&mut env, &s_wk, 1_000_000)
        .await
        .expect("seed ledger");
    let op_wk = funded_keypair(&mut env).await;
    let wrong_key = funded_keypair(&mut env).await;
    bind(&mut env, &s_wk, op_wk.pubkey())
        .await
        .expect("bind the real operator");

    // (d) a program-owned record whose fields are scoped to another market
    // (impossible to produce via set_operator, so seeded directly).
    let s_wm = fresh_user(&mut env).await;
    deposit(&mut env, &s_wm, 1_000_000)
        .await
        .expect("seed ledger");
    let op_wm = funded_keypair(&mut env).await;
    let foreign_market = Pubkey::new_from_array([7u8; 32]);
    seed_operator_record(
        &mut env,
        &s_wm.pubkey(),
        &foreign_market,
        &s_wm.pubkey(),
        &op_wm.pubkey(),
    )
    .await;

    let cases: Vec<(&str, User, Keypair)> = vec![
        ("no-record", s_none, op_none),
        ("revoked", s_rev, op_rev),
        ("wrong-key-signer", s_wk, wrong_key),
        ("wrong-market-record", s_wm, op_wm),
    ];

    for (state, subject, signer) in &cases {
        for kind in OP_IXS {
            let what = format!("{} under {}", kind.name(), state);
            let before = subject_state(&env, subject).await;
            assert_operator_unauthorized(submit_op(&mut env, kind, signer, subject).await, &what);
            let after = subject_state(&env, subject).await;
            assert_state_unchanged(&before, &after, &what);
        }
    }

    // --- The 8th new instruction: `set_operator` ---------------------------
    // Not record-gated (it writes the record); its unauthorized shape is a
    // transaction that lists the subject as signer but withholds the subject's
    // signature — rejected by the runtime, leaving the record byte-identical.
    let q = fresh_user(&mut env).await;
    let q_pda = operator_pda(&env.market, &q.pubkey());
    let impostor = funded_keypair(&mut env).await;
    let before = account_bytes(&env, &q_pda).await;
    let impostor_ix = set_operator_ix(&env, &q, Pubkey::new_from_array([5u8; 32]));
    let result = submit_without_subject_signature(&mut env, impostor_ix, &impostor).await;
    assert!(
        result.is_err(),
        "set_operator without the subject's signature must fail"
    );
    assert_eq!(
        account_bytes(&env, &q_pda).await,
        before,
        "the impostor left the record byte-identical"
    );

    // --- Positive control: a properly bound operator CAN act ---------------
    let p = fresh_user(&mut env).await;
    let op_p = funded_keypair(&mut env).await;
    bind(&mut env, &p, op_p.pubkey())
        .await
        .expect("positive-control bind");
    let pp = 77_777u64;
    op_order(
        &mut env,
        &op_p,
        &p,
        OpOrderArgs::Limit {
            side: LONG,
            price: pp,
            size: SIZE,
        },
    )
    .await
    .expect("a properly bound operator CAN place a limit order");
    let book = book_view(&env).await;
    let slot = book
        .bids
        .iter()
        .find(|o| o.active != 0)
        .expect("the positive-control order rests");
    assert_eq!(
        slot.owner,
        p.pubkey(),
        "positive-control order attributed to the subject"
    );
    assert_ne!(slot.owner, op_p.pubkey());
    assert_eq!(book.best_bid, pp);
}

// --- Harness guard -----------------------------------------------------------

/// Every bank CPI test body is `let Some(mut env) = setup(..) else { return; }`,
/// so `cargo test --workspace` reports green while silently skipping all
/// assertions whenever the SBF binary is missing (or runs a stale binary). This
/// guard converts that silent skip/staleness into a hard failure — the
/// acceptance rows above require the tests to actually execute.
#[test]
fn cpi_binary_is_present_and_fresh() {
    let so = find_fructus_so().expect(
        "fructus.so not built; every operator CPI test below silently skips under \
         `cargo test --workspace` (the acceptance rows require them to actually run)",
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
