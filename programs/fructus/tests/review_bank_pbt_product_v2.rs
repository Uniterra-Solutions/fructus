//! Review B1 — adversarial property-test modelling of the product-v2 program
//! (program side), **layers 2–3: handler interaction + live-bank integration**.
//!
//! New review artifact (never edits an existing suite). It drives the REAL
//! compiled program on an in-process bank and asserts the account-level safety
//! invariants after EVERY step, plus the interaction contracts the acceptance
//! propositions name:
//!
//! * `operator_record_x_money_pairwise_matrix_two_sided` — the ordered
//!   {bind, rotate, revoke} × {deposit, withdraw, open, close, limit, market,
//!   cancel} matrix on a subject holding BOTH a long and a short position:
//!   every record state is followed by every money op, signed by the active and
//!   by an inactive key; inactive/revoked attempts must fail `OperatorUnauthorized`
//!   with byte-identical state, authorized attempts must not be rejected by the
//!   auth gate, and the invariants hold after every step.
//! * `two_sided_liquidation_conserves_and_touches_one_side` (PBT) — the
//!   account-level `liquidate` on a straddled two-side account: the targeted
//!   side only moves, the other side is byte-identical, the victim / liquidator
//!   / pool are conserved (no value creation), `reserved == Σ m(n_i, im)` after,
//!   and a second (full) liquidation closes the side.
//! * `withdraw_gate_pnl_sign_flips_bank` — the withdraw equity gate against
//!   positive and negative Σ upnl: the gate bites exactly at
//!   `deposited + pnl_sum − reserved` when PnL is negative and the free seam
//!   binds otherwise; a refused withdrawal moves nothing.
//! * `operator_sequence_invariants_and_no_under_margin_miss` (PBT) — random
//!   op sequences (including index pokes) over one live bank: the invariants
//!   hold after every step, revoke-then-operator-op is rejected mid-sequence,
//!   and the end-state liquidation gate mirrors the account-level predicate
//!   (no under-margin liquidation miss once the TWAP window is satisfied).
//! * `operator_cancel_event_ring_backpressure` — `orderbook::cancel` through
//!   the operator path vs the bounded event ring: cancel events are appended
//!   with the right seq/owner/serde bytes, a full ring drops cancel events
//!   (documented backpressure) while fills fail loudly with `BookFull`, and a
//!   crank drain re-opens the ring (no stuck state).
//!
//! Invariants asserted after every step (`assert_safety_invariants`):
//! * per party: `reserved == m(long, im) + m(short, im)` over the STORED
//!   positions (missing/closed sides contribute 0);
//! * per party: `deposited >= reserved` (the free seam);
//! * per live position: `collateral == m(notional, im)`;
//! * token conservation: `vault == Σ deposited + pnl_pool` across every party
//!   that holds a ledger (deposits/withdrawals move both sides; liquidations
//!   are zero-sum transfers);
//! * book cache: `best_bid`/`best_ask` equal the raw-slot max/min and no
//!   resting order carries price 0.

use std::path::{Path, PathBuf};
use std::rc::Rc;

use anchor_lang::{AccountDeserialize, Discriminator, InstructionData};
use fructus::constants::{
    EVENT_QUEUE_LEN, LIQUIDATION_PENALTY_BPS, MAX_ORDERS_PER_SIDE, OPERATOR_SEED, ORDER_BOOK_SEED,
    PERP_MARKET_SEED, POSITION_SEED, USER_COLLATERAL_SEED, VAULT_SEED,
};
use fructus::error::FructusError;
use fructus::exchange::STAKE_POOL_PROGRAM_ID;
use fructus::positions::{pnl, PositionSide};
use fructus::state::{Operator, OrderBook, PerpMarket, Position, UserCollateral};
use proptest::prelude::*;
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
/// Initial margin in basis points (10x leverage): margin == ceil(notional / 10).
const INITIAL_MARGIN_BPS: u16 = 1_000;
/// Maintenance margin in basis points (market init, the liquidation trigger).
const MAINTENANCE_MARGIN_BPS: u16 = 500;
/// Position/open side encodings: 0 = Long/Bid, 1 = Short/Ask.
const LONG: u8 = 0;
const SHORT: u8 = 1;
/// Fake stake-pool `total_lamports` for the base snapshot (rate 1.0).
const BASE_TOTAL_LAMPORTS: u64 = 10_000_000_000_000;
/// Fake stake-pool `pool_token_supply` (rate 1.0 when `total_lamports` matches).
const BASE_POOL_TOKEN_SUPPLY: u64 = 10_000_000_000_000;

// ---------------------------------------------------------------------------
// Harness (mirrors the established bank-suite pattern; self-contained)
// ---------------------------------------------------------------------------

fn system_program_id() -> Pubkey {
    Pubkey::default()
}

fn ro(key: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(key, false)
}
fn wr(key: Pubkey) -> AccountMeta {
    AccountMeta::new(key, false)
}
fn signer(key: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(key, true)
}
fn signer_mut(key: Pubkey) -> AccountMeta {
    AccountMeta::new(key, true)
}

fn find_fructus_so() -> Option<PathBuf> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        manifest.join("../../target/deploy/fructus.so"),
        manifest.join("../../target/sbpf-solana-solana/release/fructus.so"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

fn fake_stake_pool_data() -> Vec<u8> {
    let mut data = vec![0u8; 274];
    data[0] = 1; // AccountType::StakePool
    data[258..266].copy_from_slice(&BASE_TOTAL_LAMPORTS.to_le_bytes());
    data[266..274].copy_from_slice(&BASE_POOL_TOKEN_SUPPLY.to_le_bytes());
    data
}

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

fn rent_min(size: usize) -> u64 {
    solana_rent::Rent::default().minimum_balance(size).max(1)
}

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

struct Env {
    ctx: ProgramTestContext,
    market: Pubkey,
    vault: Pubkey,
    mint: Pubkey,
    order_book: Pubkey,
    stake_pool: Pubkey,
    a: User,
    b: User,
    c: User,
}

async fn setup() -> Option<Env> {
    let program_id = fructus::ID;
    let so = match find_fructus_so() {
        Some(so) => so,
        None => {
            eprintln!("skipping bank test: fructus.so not found (build-sbf first)");
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

    let mut user_seeds = Vec::with_capacity(3);
    for _ in 0..3 {
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

    let data = fructus::instruction::InitializeMarket {
        collateral_mint: mint.pubkey(),
        funding_k: 100_000,
        max_funding: 10_000,
        funding_epoch_slots: 1_000,
        initial_margin_bps: INITIAL_MARGIN_BPS,
        maintenance_margin_bps: MAINTENANCE_MARGIN_BPS,
    }
    .data();
    let ix = Instruction {
        program_id,
        accounts: vec![
            wr(market),
            ro(stake_pool),
            signer(ctx.payer.pubkey()),
            signer_mut(ctx.payer.pubkey()),
            ro(system_program_id()),
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
        c: make_user(&market, user_seeds.remove(0)),
    };

    initialize_vault(&mut env)
        .await
        .expect("initialize_collateral_vault");
    Some(env)
}

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

fn error_code(result: &Result<(), BanksClientError>) -> Option<u32> {
    match result {
        Ok(()) => None,
        Err(BanksClientError::TransactionError(TransactionError::InstructionError(
            _,
            SolanaInstructionError::Custom(c),
        ))) => Some(*c),
        Err(_) => None,
    }
}

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

// --- Instruction builders ---------------------------------------------------

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

async fn withdraw_direct(env: &mut Env, user: &User, amount: u64) -> Result<(), BanksClientError> {
    let data = fructus::instruction::WithdrawCollateral { amount }.data();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            signer(user.pubkey()),
            wr(env.market),
            wr(user.user_collateral),
            wr(env.vault),
            wr(user.ata),
            ro(env.mint),
            ro(env.stake_pool),
            ro(user.long),
            ro(user.short),
            ro(spl_token::id()),
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[user.keypair.as_ref()]).await
}

async fn open_position(
    env: &mut Env,
    user: &User,
    side: u8,
    size: u64,
    price: u64,
) -> Result<(), BanksClientError> {
    let data = fructus::instruction::OpenPosition { side, size, price }.data();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            signer_mut(user.pubkey()),
            ro(env.market),
            wr(env.order_book),
            ro(env.stake_pool),
            wr(user.position(side)),
            wr(user.user_collateral),
            ro(system_program_id()),
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[user.keypair.as_ref()]).await
}

/// Direct (owner-signed) `place_limit_order`.
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

/// Direct (owner-signed) `cancel_order` (no index_source on this struct).
async fn cancel_direct(env: &mut Env, user: &User, seq: u64) -> Result<(), BanksClientError> {
    let data = fructus::instruction::CancelOrder { seq }.data();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![wr(env.order_book), ro(env.market), signer(user.pubkey())],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[user.keypair.as_ref()]).await
}

/// Permissionless `crank` (drain the event ring in batches of 8).
async fn crank(env: &mut Env) -> Result<(), BanksClientError> {
    let data = fructus::instruction::Crank.data();
    let cranker = env.ctx.payer.pubkey();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            wr(env.order_book),
            ro(env.market),
            ro(env.stake_pool),
            signer(cranker),
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[]).await
}

/// SPL `approve` for the bind flow (kept beside `bind` for the documented
/// two-instruction composition).
#[allow(dead_code)]
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

async fn set_operator(
    env: &mut Env,
    user: &User,
    operator: Pubkey,
) -> Result<(), BanksClientError> {
    let ix = set_operator_ix(env, user, operator);
    submit(&mut env.ctx, vec![ix], &[user.keypair.as_ref()]).await
}

/// The documented one-time bind: `[approve(Operator PDA, u64::MAX), set_operator]`.
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

// --- Operator instruction builders -------------------------------------------

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

async fn op_withdraw(
    env: &mut Env,
    operator: &Keypair,
    subject: &User,
    amount: u64,
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
            wr(subject.ata),
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

#[derive(Clone, Copy, Debug)]
enum OpOrderArgs {
    Limit { side: u8, price: u64, size: u64 },
    Market { side: u8, size: u64 },
}

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
            wr(env.market),
            wr(victim.position(side)),
            ro(victim.position(1 - side)),
            wr(victim.user_collateral),
            wr(env.order_book),
            ro(env.stake_pool),
            signer(liquidator.pubkey()),
            wr(liquidator.user_collateral),
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[liquidator.keypair.as_ref()]).await
}

// --- Bank-state readers ------------------------------------------------------

async fn bank_account(env: &Env, key: &Pubkey) -> Option<Account> {
    env.ctx.banks_client.get_account(*key).await.unwrap()
}

async fn account_data(env: &Env, key: &Pubkey) -> Option<Vec<u8>> {
    bank_account(env, key).await.map(|a| a.data)
}

async fn record_state(env: &Env, subject: &User) -> Option<Operator> {
    let account = bank_account(env, &operator_pda(&env.market, &subject.pubkey())).await?;
    let mut data: &[u8] = &account.data;
    Operator::try_deserialize(&mut data).ok()
}

async fn position_state(env: &Env, key: &Pubkey) -> Option<Position> {
    let account = bank_account(env, key).await?;
    let mut data: &[u8] = &account.data;
    Position::try_deserialize(&mut data).ok()
}

async fn user_collateral_state(env: &Env, key: &Pubkey) -> Option<UserCollateral> {
    let account = bank_account(env, key).await?;
    let mut data: &[u8] = &account.data;
    UserCollateral::try_deserialize(&mut data).ok()
}

async fn market_state(env: &Env) -> PerpMarket {
    let account = bank_account(env, &env.market).await.expect("market exists");
    let mut data: &[u8] = &account.data;
    PerpMarket::try_deserialize(&mut data).expect("market deserializes")
}

async fn ata_balance(env: &Env, ata: &Pubkey) -> u64 {
    let account = bank_account(env, ata).await.expect("token account exists");
    TokenAccount::unpack(&account.data).unwrap().amount
}

async fn vault_balance(env: &Env) -> u64 {
    ata_balance(env, &env.vault).await
}

// --- Pure mirrors (independent expectations) ---------------------------------

/// `margin_required(notional, bps)` mirror (ceiling `(n·bps + 9999) / 10_000`).
fn margin_required_bps(notional: u64, bps: u16) -> u64 {
    (notional as u128 * bps as u128).div_ceil(10_000) as u64
}

fn margin_required(notional: u64) -> u64 {
    margin_required_bps(notional, INITIAL_MARGIN_BPS)
}

/// Account equity `deposited + Σ upnl`, signed.
fn account_equity(deposited: u64, pnl_sum: i128) -> i128 {
    (deposited as i128).saturating_add(pnl_sum)
}

/// The account-level liquidatable predicate (REQ-A2-1/D8): exposure > 0 and a
/// STRICT `equity < Σ m(n_i, maintenance)`.
fn account_is_liquidatable(deposited: u64, pnl_sum: i128, n_long: u64, n_short: u64) -> bool {
    n_long + n_short > 0
        && account_equity(deposited, pnl_sum)
            < (margin_required_bps(n_long, MAINTENANCE_MARGIN_BPS) as i128
                + margin_required_bps(n_short, MAINTENANCE_MARGIN_BPS) as i128)
}

/// Signed unrealized PnL of one stored position against `rate` (the exact
/// `positions::pnl` call the handlers make — the un-stubbed pure function).
fn pnl_of(position: &Position, rate: (u64, u64)) -> i128 {
    let side = if position.side == LONG {
        PositionSide::Long
    } else {
        PositionSide::Short
    };
    pnl(
        position.entry_n_sum,
        position.entry_d_sum,
        rate.0,
        rate.1,
        position.notional,
        side,
    )
    .expect("pnl is total in the bank band")
}

/// The liquidator penalty ceiling `ceil(released × 500 / 10_000)`.
fn liquidation_penalty(released: u64) -> u64 {
    (released as u128 * LIQUIDATION_PENALTY_BPS as u128).div_ceil(10_000) as u64
}

async fn stake_pool_rate(env: &Env) -> (u64, u64) {
    let account = bank_account(env, &env.stake_pool)
        .await
        .expect("stake pool");
    (read_u64(&account.data, 258), read_u64(&account.data, 266))
}

async fn set_stake_pool_total_lamports(env: &mut Env, total_lamports: u64) {
    let account = bank_account(env, &env.stake_pool)
        .await
        .expect("stake pool");
    let mut patched = account.clone();
    patched.data[258..266].copy_from_slice(&total_lamports.to_le_bytes());
    env.ctx
        .set_account(&env.stake_pool, &AccountSharedData::from(patched));
}

// --- Raw byte views of the zero-copy OrderBook account -----------------------

const OB_BIDS_OFF: usize = 8 + 88;
const OB_ASKS_OFF: usize = OB_BIDS_OFF + 16 * 64;
const OB_EVENTS_OFF: usize = OB_ASKS_OFF + 16 * 64;
const OB_OBS_OFF: usize = OB_EVENTS_OFF + EVENT_QUEUE_LEN * 112;

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

#[derive(Debug, Clone)]
struct ObservationView {
    slot: u64,
}

#[derive(Debug, Clone)]
struct BookView {
    best_bid: u64,
    best_ask: u64,
    read_cursor: u64,
    write_cursor: u64,
    bids: Vec<OrderView>,
    asks: Vec<OrderView>,
    events: Vec<EventView>,
    observations: Vec<ObservationView>,
}

impl BookView {
    fn active_bids(&self) -> usize {
        self.bids.iter().filter(|o| o.active != 0).count()
    }
    fn active_asks(&self) -> usize {
        self.asks.iter().filter(|o| o.active != 0).count()
    }
    fn resting_of(&self, owner: &Pubkey) -> Vec<&OrderView> {
        self.bids
            .iter()
            .chain(self.asks.iter())
            .filter(|o| o.active != 0 && o.owner == *owner)
            .collect()
    }
    fn event(&self, slot: usize) -> &EventView {
        &self.events[slot]
    }
}

async fn book_view(env: &Env) -> BookView {
    let account = bank_account(env, &env.order_book)
        .await
        .expect("order book exists");
    let data = &account.data;
    let mut bids = Vec::with_capacity(MAX_ORDERS_PER_SIDE);
    let mut asks = Vec::with_capacity(MAX_ORDERS_PER_SIDE);
    let mut events = Vec::with_capacity(EVENT_QUEUE_LEN);
    let mut observations = Vec::with_capacity(16);
    for i in 0..MAX_ORDERS_PER_SIDE {
        bids.push(read_order(data, OB_BIDS_OFF + i * 64));
        asks.push(read_order(data, OB_ASKS_OFF + i * 64));
    }
    for i in 0..EVENT_QUEUE_LEN {
        events.push(read_event(data, OB_EVENTS_OFF + i * 112));
    }
    for i in 0..16 {
        let base = OB_OBS_OFF + i * 32;
        observations.push(ObservationView {
            slot: read_u64(data, base),
        });
    }
    BookView {
        best_bid: read_u64(data, 16),
        best_ask: read_u64(data, 24),
        read_cursor: read_u64(data, 32),
        write_cursor: read_u64(data, 40),
        bids,
        asks,
        events,
        observations,
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

// --- Bank-mutation helpers ---------------------------------------------------

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

// --- The invariant battery ---------------------------------------------------

/// The account-level safety invariants, asserted after EVERY step. Panics on
/// violation (inside `proptest` this shrinks like `prop_assert`).
async fn assert_safety_invariants(env: &Env, users: &[&User], context: &str) {
    let book = book_view(env).await;
    let market = market_state(env).await;
    let vault = vault_balance(env).await;
    let mut sum_deposited: u128 = 0;

    for user in users {
        let key = user.pubkey();
        let Some(uc) = user_collateral_state(env, &user.user_collateral).await else {
            continue; // no ledger => never touched the vault
        };
        let long = position_state(env, &user.long).await;
        let short = position_state(env, &user.short).await;
        let req = |p: &Option<Position>| -> u64 {
            p.as_ref()
                .map(|p| margin_required_bps(p.notional, INITIAL_MARGIN_BPS))
                .unwrap_or(0)
        };
        assert_eq!(
            uc.reserved,
            req(&long) + req(&short),
            "{context}: {key} reserved {} != Σ m(n_i, im) {} (long {:?}, short {:?})",
            uc.reserved,
            req(&long) + req(&short),
            long.as_ref().map(|p| p.notional),
            short.as_ref().map(|p| p.notional),
        );
        assert!(
            uc.deposited >= uc.reserved,
            "{context}: {key} free seam broken: deposited {} < reserved {}",
            uc.deposited,
            uc.reserved
        );
        for (name, p) in [("long", &long), ("short", &short)] {
            if let Some(p) = p {
                assert_eq!(
                    p.collateral,
                    margin_required_bps(p.notional, INITIAL_MARGIN_BPS),
                    "{context}: {key} {name} collateral {} != m({}, {})",
                    p.collateral,
                    p.notional,
                    INITIAL_MARGIN_BPS
                );
            }
        }
        sum_deposited += uc.deposited as u128;
    }

    // Token conservation: the vault holds exactly Σ deposited + pool.
    assert_eq!(
        vault as u128,
        sum_deposited + market.pnl_pool as u128,
        "{context}: vault {vault} != Σ deposited ({sum_deposited}) + pool ({})",
        market.pnl_pool
    );

    // Book cache consistency (the cached best_* must equal the raw slots).
    let best_bid = book
        .bids
        .iter()
        .filter(|o| o.active != 0)
        .map(|o| o.price)
        .max()
        .unwrap_or(0);
    let best_ask = book
        .asks
        .iter()
        .filter(|o| o.active != 0)
        .map(|o| o.price)
        .min()
        .unwrap_or(0);
    assert_eq!(book.best_bid, best_bid, "{context}: cached best_bid drift");
    assert_eq!(book.best_ask, best_ask, "{context}: cached best_ask drift");
    for o in book.bids.iter().chain(book.asks.iter()) {
        if o.active != 0 {
            assert!(o.price != 0, "{context}: a resting order carries price 0");
            assert!(o.size > 0, "{context}: a resting order carries size 0");
        }
    }
}

/// Raw bytes of every account an operator/bank step can touch (used for
/// byte-identity checks on rejected instructions).
async fn touched_accounts(env: &Env, s: &User) -> Vec<(Pubkey, Option<Vec<u8>>)> {
    let keys = [
        env.order_book,
        env.market,
        env.vault,
        s.user_collateral,
        s.long,
        s.short,
        operator_pda(&env.market, &s.pubkey()),
        s.ata,
        env.b.user_collateral,
        env.b.long,
        env.b.short,
        env.b.ata,
        env.c.user_collateral,
        env.c.ata,
    ];
    let mut out = Vec::with_capacity(keys.len());
    for key in keys {
        out.push((key, account_data(env, &key).await));
    }
    out
}

fn assert_bytes_identical(
    before: &[(Pubkey, Option<Vec<u8>>)],
    after: &[(Pubkey, Option<Vec<u8>>)],
    what: &str,
) {
    assert_eq!(before.len(), after.len());
    for ((k, a), (_, b)) in before.iter().zip(after.iter()) {
        assert_eq!(
            a, b,
            "{what}: account {k} changed on a rejected instruction"
        );
    }
}

/// Drain the ring to empty (up to 4 bounded crank batches of 8).
async fn drain_ring(env: &mut Env, context: &str) {
    for _ in 0..5 {
        let book = book_view(env).await;
        if book.read_cursor >= book.write_cursor {
            return;
        }
        crank(env)
            .await
            .unwrap_or_else(|e| panic!("{context}: crank failed: {e:?}"));
    }
    // The ring holds EVENT_QUEUE_LEN entries; 5 batches cover it.
}

fn first_resting_seq(book: &BookView, owner: &Pubkey) -> Option<u64> {
    book.resting_of(owner).first().map(|o| o.seq)
}

// ---------------------------------------------------------------------------
// T1 — liquidation × both sides (PBT): targeted side only, other side
// byte-identical, pool/liquidator/victim conservation.
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(proptest::test_runner::Config::with_cases(10))]

    /// REQ-A2-2 / LIQUIDATE-RELEASES-ONLY-THE-TARGETED-SIDE +
    /// LIQUIDATION-CONSERVES-ACCOUNT-VALUE, on a straddled two-side account
    /// (long entered high, short entered low — the documented way an account
    /// goes under maintenance with both sides live). Both target sides are
    /// modelled (`target_side`). The liquidation must
    /// (a) move only the targeted side — the other side and every counterparty
    /// account byte-identical, (b) release exactly `m(n, im) − m(n−amount, im)`
    /// and pay the ceiling penalty, (c) book `min(max(0, −Σ upnl), seam)` into
    /// the pool, (d) conserve Σ(victim + liquidator + pool) and the vault, and
    /// (e) leave `reserved == Σ m(n_i', im)`.
    #[test]
    fn two_sided_liquidation_conserves_and_touches_one_side(
        hi_num in 10_800_000_000_000u64..=11_500_000_000_000u64,
        lo_num in 8_500_000_000_000u64..=9_500_000_000_000u64,
        size in 500_000u64..=2_000_000u64,
        frac in 1u64..=4u64,
        target_side in 0u8..=1u8,
    ) {
        let mid_num = (hi_num + lo_num) / 2;
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(async {
            let Some(mut env) = setup().await else { return; };
            let s = env.a.clone();
            let m = env.b.clone();
            let l = env.c.clone();
            let m_size = margin_required(size);

            // The victim's ledger backs BOTH sides at the initial ratio.
            deposit(&mut env, &s, 2 * m_size).await.expect("victim deposit");
            deposit(&mut env, &l, 1_000).await.expect("liquidator ledger");
            deposit(&mut env, &m, 1_000).await.expect("maker ledger");

            // Long entered HIGH (hi index): b rests an ask, s takes it.
            set_stake_pool_total_lamports(&mut env, hi_num).await;
            place_limit_order(&mut env, &m, SHORT, 500_000, size)
                .await
                .expect("maker ask rests");
            open_position(&mut env, &s, LONG, size, 0)
                .await
                .expect("long fills at the high index");

            // Short entered LOW (lo index): b rests a bid, s takes it.
            set_stake_pool_total_lamports(&mut env, lo_num).await;
            place_limit_order(&mut env, &m, LONG, 400_000, size)
                .await
                .expect("maker bid rests");
            open_position(&mut env, &s, SHORT, size, 0)
                .await
                .expect("short fills at the low index");

            // Both sides lose at the mid index => the account is under total
            // maintenance even though each side was opened backed at 10%.
            set_stake_pool_total_lamports(&mut env, mid_num).await;

            let long_pre = position_state(&env, &s.long).await.expect("long exists");
            let short_pre = position_state(&env, &s.short).await.expect("short exists");
            let open_slot = long_pre.open_slot.max(short_pre.open_slot);
            env.ctx
                .warp_to_slot(open_slot.wrapping_add(1_001))
                .expect("warp past the TWAP window");

            let rate = stake_pool_rate(&env).await;
            assert_eq!(rate.0, mid_num, "mid index in effect");
            let pnl_long = pnl_of(&long_pre, rate);
            let pnl_short = pnl_of(&short_pre, rate);
            let pnl_sum = pnl_long + pnl_short;
            let uc_pre = user_collateral_state(&env, &s.user_collateral)
                .await
                .expect("victim ledger");
            assert!(
                account_is_liquidatable(uc_pre.deposited, pnl_sum, long_pre.notional, short_pre.notional),
                "premise: the straddled account must be under total maintenance \
                 (pnl_sum={pnl_sum}, deposited={}, n=({}, {}))",
                uc_pre.deposited, long_pre.notional, short_pre.notional
            );

            // Untouched-side baselines.
            let other_bytes = account_data(&env, &s.position(1 - target_side)).await;
            let m_uc_bytes = account_data(&env, &m.user_collateral).await;
            let m_long_bytes = account_data(&env, &m.long).await;
            let m_short_bytes = account_data(&env, &m.short).await;
            let book_bytes = account_data(&env, &env.order_book).await;
            let vault_pre = vault_balance(&env).await;
            let pool_pre = market_state(&env).await.pnl_pool;
            let liq_pre = user_collateral_state(&env, &l.user_collateral)
                .await
                .expect("liquidator ledger")
                .deposited;

            // ---- partial liquidation of the TARGETED side --------------------
            let amount = ((size * frac) / 4).max(1);
            liquidate(&mut env, &s, &l, target_side, amount)
                .await
                .expect("the under-margin account must liquidate");

            let t_post = position_state(&env, &s.position(target_side))
                .await
                .expect("targeted side survives");
            assert_eq!(t_post.notional, size - amount, "targeted notional reduced");
            assert_eq!(
                t_post.collateral,
                margin_required(size - amount),
                "targeted collateral released to m(n-amount, im)"
            );
            assert_eq!(
                account_data(&env, &s.position(1 - target_side)).await,
                other_bytes,
                "the untargeted side must be byte-identical"
            );
            assert_eq!(account_data(&env, &m.user_collateral).await, m_uc_bytes);
            assert_eq!(account_data(&env, &m.long).await, m_long_bytes);
            assert_eq!(account_data(&env, &m.short).await, m_short_bytes);
            assert_eq!(
                account_data(&env, &env.order_book).await, book_bytes,
                "liquidate must not mutate the book"
            );
            assert_eq!(vault_balance(&env).await, vault_pre, "vault tokens unchanged");

            // The ledger algebra, computed inline from the pre-state.
            let released = m_size - margin_required(size - amount);
            let reward = liquidation_penalty(released);
            let reserved_after = margin_required(size - amount) + margin_required(size);
            let loss = if pnl_sum < 0 {
                pnl_sum.unsigned_abs().min(u64::MAX as u128) as u64
            } else {
                0
            };
            let seam = uc_pre
                .deposited
                .checked_sub(reserved_after)
                .and_then(|v| v.checked_sub(reward))
                .expect("seam is representable in this scenario");
            let booked = loss.min(seam);
            let uc_post = user_collateral_state(&env, &s.user_collateral)
                .await
                .expect("victim ledger after");
            assert_eq!(uc_post.reserved, reserved_after, "reserved == Σ m(n_i', im)");
            assert_eq!(
                uc_post.deposited,
                uc_pre.deposited - booked - reward,
                "victim pays the booked loss and the reward"
            );
            assert!(uc_post.deposited >= uc_post.reserved, "free seam holds");
            let liq_post = user_collateral_state(&env, &l.user_collateral)
                .await
                .expect("liquidator ledger after")
                .deposited;
            assert_eq!(liq_post, liq_pre + reward, "liquidator credited the reward");
            let pool_post = market_state(&env).await.pnl_pool;
            assert_eq!(pool_post, pool_pre + booked, "loss collected into the pool");
            // Zero-sum across victim + liquidator + pool (u128: no overflow).
            assert_eq!(
                uc_post.deposited as u128 + liq_post as u128 + pool_post as u128,
                uc_pre.deposited as u128 + liq_pre as u128 + pool_pre as u128,
                "liquidation must not create value"
            );

            // ---- full liquidation of the targeted remainder (when any) -------
            let rest = size - amount;
            if rest > 0 {
                let uc_mid = user_collateral_state(&env, &s.user_collateral).await.unwrap();
                let (n_long, n_short) = if target_side == LONG {
                    (rest, size)
                } else {
                    (size, rest)
                };
                assert!(
                    account_is_liquidatable(uc_mid.deposited, pnl_sum, n_long, n_short),
                    "premise: the remainder is still under maintenance"
                );
                let other_bytes2 = account_data(&env, &s.position(1 - target_side)).await;
                liquidate(&mut env, &s, &l, target_side, rest)
                    .await
                    .expect("full liquidation of the remainder");
                let t_final = position_state(&env, &s.position(target_side))
                    .await
                    .expect("position account retained");
                assert_eq!(t_final.notional, 0, "full liquidation closes the side");
                assert_eq!(t_final.collateral, 0, "a closed side holds zero collateral");
                assert_eq!(
                    account_data(&env, &s.position(1 - target_side)).await,
                    other_bytes2,
                    "the untargeted side must remain byte-identical"
                );
                let uc_final = user_collateral_state(&env, &s.user_collateral).await.unwrap();
                assert_eq!(
                    uc_final.reserved,
                    margin_required(size),
                    "reserved == m(other side, im) after the target is closed"
                );
                assert!(
                    uc_final.deposited >= uc_final.reserved,
                    "free seam holds after the full leg"
                );
            } else {
                // frac == 4: the first liquidation was already full — the
                // targeted side is closed and must hold zero notional/collateral.
                let t_final = position_state(&env, &s.position(target_side))
                    .await
                    .expect("position account retained");
                assert_eq!(t_final.notional, 0, "the full leg closed the target");
                assert_eq!(t_final.collateral, 0);
            }

            // The whole battery, on the final state (external counterparties:
            // the maker's pending fills do not change its stored position).
            assert_safety_invariants(&env, &[&s, &l, &m], "T1 final").await;
        });
    }
}

// ---------------------------------------------------------------------------
// T2 — withdraw gate × PnL sign flips (live bank)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn withdraw_gate_pnl_sign_flips_bank() {
    let Some(mut env) = setup().await else {
        return;
    };
    let s = env.a.clone();
    let m = env.b.clone();

    let size = 3_000_000u64;
    let m_size = margin_required(size); // 300_000 at 10%
    deposit(&mut env, &s, 400_000).await.expect("deposit");

    // Long at rate 1.0 (base).
    place_limit_order(&mut env, &m, SHORT, 500_000, size)
        .await
        .expect("maker ask");
    open_position(&mut env, &s, LONG, size, 0)
        .await
        .expect("long fills");
    let uc = user_collateral_state(&env, &s.user_collateral)
        .await
        .unwrap();
    assert_eq!(uc.reserved, m_size);
    assert_eq!(uc.deposited - uc.reserved, 100_000, "free seam");

    // ---- positive PnL: +10% index => +300_000 upnl. The free seam binds. ----
    set_stake_pool_total_lamports(&mut env, 11_000_000_000_000).await;
    let rate = stake_pool_rate(&env).await;
    let long = position_state(&env, &s.long).await.unwrap();
    assert_eq!(pnl_of(&long, rate), 300_000, "positive PnL pin");
    let ata_pre = ata_balance(&env, &s.ata).await;
    let vault_pre = vault_balance(&env).await;

    withdraw_direct(&mut env, &s, 100_000)
        .await
        .expect("the free seam must be withdrawable under positive PnL");
    let uc = user_collateral_state(&env, &s.user_collateral)
        .await
        .unwrap();
    assert_eq!(uc.deposited, 300_000);
    assert_eq!(ata_balance(&env, &s.ata).await, ata_pre + 100_000);
    assert_eq!(vault_balance(&env).await, vault_pre - 100_000);

    // One past the free seam fails and moves nothing.
    let ata_pre = ata_balance(&env, &s.ata).await;
    let bytes_pre = touched_accounts(&env, &s).await;
    assert_anchor_error(
        withdraw_direct(&mut env, &s, 1).await,
        FructusError::InsufficientFreeCollateral,
    );
    assert_bytes_identical(
        &bytes_pre,
        &touched_accounts(&env, &s).await,
        "withdraw past the free seam",
    );
    assert_eq!(ata_balance(&env, &s.ata).await, ata_pre);

    // Re-fund to the original ledger.
    deposit(&mut env, &s, 100_000).await.expect("re-fund");

    // ---- negative PnL: -1% index => -30_000 upnl. The equity gate binds. ----
    set_stake_pool_total_lamports(&mut env, 9_900_000_000_000).await;
    let rate = stake_pool_rate(&env).await;
    let long = position_state(&env, &s.long).await.unwrap();
    assert_eq!(pnl_of(&long, rate), -30_000, "negative PnL pin");

    // gate limit = deposited + pnl - reserved = 400_000 - 30_000 - 300_000 = 70_000
    let gate_limit = {
        let uc = user_collateral_state(&env, &s.user_collateral)
            .await
            .unwrap();
        (uc.deposited as i128 + pnl_of(&long, rate) - uc.reserved as i128) as u64
    };
    assert_eq!(gate_limit, 70_000, "the gate limit under negative PnL");

    // One past the gate limit fails and moves nothing — even though it is
    // inside the ledger-only free seam (100_000), so the EQUITY gate is the
    // binding refusal here.
    let ata_pre = ata_balance(&env, &s.ata).await;
    let bytes_pre = touched_accounts(&env, &s).await;
    assert_anchor_error(
        withdraw_direct(&mut env, &s, gate_limit + 1).await,
        FructusError::InsufficientFreeCollateral,
    );
    assert_bytes_identical(
        &bytes_pre,
        &touched_accounts(&env, &s).await,
        "withdraw one past the equity gate",
    );
    assert_eq!(ata_balance(&env, &s.ata).await, ata_pre);

    // Exactly the gate limit passes.
    withdraw_direct(&mut env, &s, gate_limit)
        .await
        .expect("exactly the gate limit must pass");
    let uc = user_collateral_state(&env, &s.user_collateral)
        .await
        .unwrap();
    assert_eq!(uc.deposited, 330_000);
    assert_eq!(uc.reserved, m_size);
    assert_eq!(
        uc.deposited - uc.reserved,
        30_000,
        "the post-gate free seam"
    );

    // Re-fund, then flip the sign back to zero: the free seam (not the gate)
    // binds again — 100_000, the full pre-gate free collateral, moves.
    deposit(&mut env, &s, 70_000).await.expect("re-fund");
    set_stake_pool_total_lamports(&mut env, BASE_TOTAL_LAMPORTS).await;
    withdraw_direct(&mut env, &s, 100_000)
        .await
        .expect("at zero PnL the full free seam is withdrawable again");
    let uc = user_collateral_state(&env, &s.user_collateral)
        .await
        .unwrap();
    assert_eq!(
        uc.deposited, uc.reserved,
        "drained back to the reserved seam"
    );
    assert_anchor_error(
        withdraw_direct(&mut env, &s, 1).await,
        FructusError::InsufficientFreeCollateral,
    );

    assert_safety_invariants(&env, &[&s, &m], "T2 final").await;
}

// ---------------------------------------------------------------------------
// T3 — the {bind, rotate, revoke} × {7 money ops} ordered-pair matrix on a
// two-sided subject account.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecordOp {
    Bind,
    Rotate,
    Revoke,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MoneyOp {
    Deposit,
    Withdraw,
    Open,
    Close,
    Limit,
    Market,
    Cancel,
}

const RECORD_OPS: [RecordOp; 3] = [RecordOp::Bind, RecordOp::Rotate, RecordOp::Revoke];
const MONEY_OPS: [MoneyOp; 7] = [
    MoneyOp::Deposit,
    MoneyOp::Withdraw,
    MoneyOp::Open,
    MoneyOp::Close,
    MoneyOp::Limit,
    MoneyOp::Market,
    MoneyOp::Cancel,
];

async fn run_money_op(
    env: &mut Env,
    operator: &Keypair,
    subject: &User,
    op: MoneyOp,
    side: u8,
) -> Result<(), BanksClientError> {
    match op {
        MoneyOp::Deposit => op_deposit(env, operator, subject, 10_000).await,
        MoneyOp::Withdraw => op_withdraw(env, operator, subject, 1).await,
        MoneyOp::Open => op_open(env, operator, subject, side, 50_000, 0).await,
        MoneyOp::Close => op_close(env, operator, subject, side, 1).await,
        MoneyOp::Limit => {
            let price = if side == LONG { 300_000 } else { 700_000 };
            op_order(
                env,
                operator,
                subject,
                OpOrderArgs::Limit {
                    side,
                    price,
                    size: 10_000,
                },
            )
            .await
        }
        MoneyOp::Market => {
            op_order(
                env,
                operator,
                subject,
                OpOrderArgs::Market { side, size: 10_000 },
            )
            .await
        }
        MoneyOp::Cancel => {
            let book = book_view(env).await;
            let seq = first_resting_seq(&book, &subject.pubkey()).unwrap_or(1);
            op_cancel(env, operator, subject, seq).await
        }
    }
}

/// Restore the matrix's preconditions: record bound to K1, drained ring, only
/// maker liquidity on the book, both subject sides live, free headroom.
async fn cleanup_for_pair(env: &mut Env, s: &User, m: &User, l: &User, k1: &Keypair) {
    bind(env, s, k1.pubkey()).await.expect("cleanup bind");
    drain_ring(env, "cleanup").await;

    // Cancel the subject's resting orders (capacity + a clean book).
    let book = book_view(env).await;
    for o in book.resting_of(&s.pubkey()) {
        let seq = o.seq;
        op_cancel(env, k1, s, seq)
            .await
            .unwrap_or_else(|e| panic!("cleanup cancel seq {seq}: {e:?}"));
    }

    // Maker liquidity on both sides (safe: only maker orders remain).
    let book = book_view(env).await;
    if book
        .bids
        .iter()
        .all(|o| o.active == 0 || o.owner != m.pubkey())
    {
        place_limit_order(env, m, LONG, 400_000, 5_000_000)
            .await
            .expect("maker bid");
    }
    if book
        .asks
        .iter()
        .all(|o| o.active == 0 || o.owner != m.pubkey())
    {
        place_limit_order(env, m, SHORT, 500_000, 5_000_000)
            .await
            .expect("maker ask");
    }

    // Free-collateral headroom for the coming operations.
    let uc = user_collateral_state(env, &s.user_collateral)
        .await
        .expect("subject ledger");
    if uc.deposited.saturating_sub(uc.reserved) < 200_000 {
        deposit(env, s, 1_000_000).await.expect("top-up");
    }

    // Both sides live (notional > 0): the two-sided account precondition.
    for side in [LONG, SHORT] {
        let notional = position_state(env, &s.position(side))
            .await
            .map(|p| p.notional)
            .unwrap_or(0);
        if notional < 50_000 {
            op_open(env, k1, s, side, 50_000, 0)
                .await
                .unwrap_or_else(|e| panic!("re-seed side {side}: {e:?}"));
        }
    }
    assert_safety_invariants(env, &[s, m, l], "cleanup").await;
}

/// The ordered-pair matrix: for each record state (bind / rotate / revoke) and
/// each money op, the op is attempted by the ACTIVE key (the record's operator
/// after the record op) and by an INACTIVE key. Revoked/inactive attempts must
/// fail `OperatorUnauthorized` with byte-identical state; authorized attempts
/// must not be rejected by the auth gate. The safety invariants hold after
/// every instruction.
#[tokio::test]
async fn operator_record_x_money_pairwise_matrix_two_sided() {
    let Some(mut env) = setup().await else {
        return;
    };
    let s = env.a.clone();
    let m = env.b.clone();
    let l = env.c.clone();
    let k1 = funded_keypair(&mut env).await;
    let k2 = funded_keypair(&mut env).await;

    deposit(&mut env, &s, 5_000_000)
        .await
        .expect("subject ledger");
    deposit(&mut env, &m, 5_000_000)
        .await
        .expect("maker ledger");
    deposit(&mut env, &l, 1_000)
        .await
        .expect("liquidator ledger");
    bind(&mut env, &s, k1.pubkey()).await.expect("initial bind");

    let mut side_flips = 0usize;
    for rec in RECORD_OPS {
        for op in MONEY_OPS {
            let side = if side_flips.is_multiple_of(2) {
                LONG
            } else {
                SHORT
            };
            side_flips += 1;
            let step = format!("pair({rec:?},{op:?})");

            cleanup_for_pair(&mut env, &s, &m, &l, &k1).await;

            // ---- the record op ------------------------------------------------
            match rec {
                RecordOp::Bind => {
                    bind(&mut env, &s, k1.pubkey())
                        .await
                        .unwrap_or_else(|e| panic!("{step}: bind failed: {e:?}"));
                    assert_eq!(
                        record_state(&env, &s).await.map(|r| r.operator),
                        Some(k1.pubkey())
                    );
                }
                RecordOp::Rotate => {
                    set_operator(&mut env, &s, k2.pubkey())
                        .await
                        .unwrap_or_else(|e| panic!("{step}: rotate failed: {e:?}"));
                    assert_eq!(
                        record_state(&env, &s).await.map(|r| r.operator),
                        Some(k2.pubkey()),
                        "{step}: rotate must overwrite operator"
                    );
                }
                RecordOp::Revoke => {
                    set_operator(&mut env, &s, Pubkey::default())
                        .await
                        .unwrap_or_else(|e| panic!("{step}: revoke failed: {e:?}"));
                    assert_eq!(
                        record_state(&env, &s).await.map(|r| r.operator),
                        Some(Pubkey::default()),
                        "{step}: revoke state must be the default key"
                    );
                }
            }
            assert_safety_invariants(&env, &[&s, &m, &l], &format!("{step} after record op")).await;

            // ---- the money op, by the active key ------------------------------
            let (active, inactive) = match rec {
                RecordOp::Rotate => (&k2, &k1),
                _ => (&k1, &k2),
            };
            if rec == RecordOp::Revoke {
                // Revoked: BOTH operator keys must be rejected, state untouched.
                for (key, who) in [(&k1, "k1"), (&k2, "k2")] {
                    let bytes_pre = touched_accounts(&env, &s).await;
                    let res = run_money_op(&mut env, key, &s, op, side).await;
                    assert_operator_unauthorized(res, &format!("{step} after revoke by {who}"));
                    assert_bytes_identical(
                        &bytes_pre,
                        &touched_accounts(&env, &s).await,
                        &format!("{step} after revoke by {who}"),
                    );
                    assert_safety_invariants(&env, &[&s, &m, &l], &format!("{step} revoke {who}"))
                        .await;
                }
            } else {
                let res = run_money_op(&mut env, active, &s, op, side).await;
                assert_ne!(
                    error_code(&res),
                    Some(u32::from(FructusError::OperatorUnauthorized)),
                    "{step}: an AUTHORIZED operator op must not be rejected by the auth gate \
                     (got {:?})",
                    res
                );
                assert_safety_invariants(&env, &[&s, &m, &l], &format!("{step} active")).await;

                // The other key must be rejected with byte-identical state.
                let bytes_pre = touched_accounts(&env, &s).await;
                let res = run_money_op(&mut env, inactive, &s, op, side).await;
                assert_operator_unauthorized(res, &format!("{step} inactive key"));
                assert_bytes_identical(
                    &bytes_pre,
                    &touched_accounts(&env, &s).await,
                    &format!("{step} inactive key"),
                );
                assert_safety_invariants(&env, &[&s, &m, &l], &format!("{step} inactive")).await;
            }
        }
    }

    // Non-vacuity: the matrix produced real book activity, both subject sides
    // are live, and the account is not stuck (a fresh authorized deposit works).
    let book = book_view(&env).await;
    assert!(
        book.write_cursor > 0,
        "non-vacuity: the matrix must have produced fill/cancel events"
    );
    let long = position_state(&env, &s.long)
        .await
        .map(|p| p.notional)
        .unwrap_or(0);
    let short = position_state(&env, &s.short)
        .await
        .map(|p| p.notional)
        .unwrap_or(0);
    assert!(
        long > 0 && short > 0,
        "non-vacuity: the subject kept both sides live"
    );
    bind(&mut env, &s, k1.pubkey()).await.expect("re-bind");
    op_deposit(&mut env, &k1, &s, 1_000)
        .await
        .expect("no stuck state: a re-bound operator deposit succeeds");
    assert_safety_invariants(&env, &[&s, &m, &l], "T3 final").await;
}

// ---------------------------------------------------------------------------
// T4 — random op sequences over a live bank: invariants after EVERY step,
// revoke-then-op rejection mid-sequence, no under-margin liquidation miss.
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(proptest::test_runner::Config::with_cases(16))]

    /// The integration property: any sequence of operator ops (bind/rotate/
    /// revoke + the 7 money ops) interspersed with index pokes keeps every
    /// account-level safety invariant true after EVERY step; a revoked record
    /// rejects the very next operator op with zero state mutation; and the
    /// program's liquidation gate mirrors the account-level predicate at the
    /// end state once the TWAP window is satisfied (no under-margin miss).
    #[test]
    fn operator_sequence_invariants_and_no_under_margin_miss(
        bytes in prop::collection::vec(any::<u8>(), 8..=18),
    ) {
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(async {
            let Some(mut env) = setup().await else { return; };
            let s = env.a.clone();
            let m = env.b.clone();
            let l = env.c.clone();
            let k1 = funded_keypair(&mut env).await;
            let k2 = funded_keypair(&mut env).await;

            deposit(&mut env, &s, 2_000_000).await.expect("subject ledger");
            deposit(&mut env, &m, 100_000).await.expect("maker ledger");
            deposit(&mut env, &l, 1_000).await.expect("liquidator ledger");
            // Maker liquidity so fills are reachable.
            place_limit_order(&mut env, &m, LONG, 400_000, 50_000_000)
                .await
                .expect("maker bid");
            place_limit_order(&mut env, &m, SHORT, 500_000, 50_000_000)
                .await
                .expect("maker ask");

            for (i, &b) in bytes.iter().enumerate() {
                let step = format!("step {i} (byte {b})");
                let record = record_state(&env, &s).await;
                let record_operator = record.as_ref().map(|r| r.operator).unwrap_or_default();
                let signer = if record_operator == k2.pubkey() { &k2 } else { &k1 };
                let expected_authorized =
                    record_operator == signer.pubkey() && record_operator != Pubkey::default();

                let side = if b & 1 == 0 { LONG } else { SHORT };
                let x = 1 + (b as u64) % 8;
                let kind = b % 11;

                // Pre-state for the byte-identity check on rejected steps.
                let bytes_pre = touched_accounts(&env, &s).await;

                let outcome = match kind {
                    0 => bind(&mut env, &s, k1.pubkey()).await,
                    1 => set_operator(&mut env, &s, k2.pubkey()).await,
                    2 => set_operator(&mut env, &s, Pubkey::default()).await,
                    3 => op_deposit(&mut env, signer, &s, 10_000 * x).await,
                    4 => op_withdraw(&mut env, signer, &s, 1 + (b as u64) % 10_000).await,
                    5 => op_open(&mut env, signer, &s, side, 10_000 * x, 0).await,
                    6 => op_close(&mut env, signer, &s, side, 1).await,
                    7 => op_order(
                        &mut env,
                        signer,
                        &s,
                        OpOrderArgs::Limit {
                            side,
                            price: 100_000 + 100_000 * x,
                            size: 10_000,
                        },
                    )
                    .await,
                    8 => op_order(&mut env, signer, &s, OpOrderArgs::Market { side, size: 10_000 })
                        .await,
                    9 => {
                        let book = book_view(&env).await;
                        let seq = first_resting_seq(&book, &s.pubkey()).unwrap_or(b as u64);
                        op_cancel(&mut env, signer, &s, seq).await
                    }
                    _ => {
                        // Index poke: no instruction, just the index source
                        // moving — the PnL sign flips under the stored entries.
                        let total = 9_000_000_000_000 + 1_000_000_000_000 * (b as u64 % 3);
                        set_stake_pool_total_lamports(&mut env, total).await;
                        Ok(())
                    }
                };

                if kind == 10 {
                    // Poke: no auth semantics, only the invariants below.
                } else if kind <= 2 {
                    // Record ops are user-signed by the subject: always allowed.
                    assert!(
                        outcome.is_ok(),
                        "{step}: a user-signed record op must succeed ({outcome:?})"
                    );
                } else if expected_authorized {
                    // The pure predicate said authorized => the real handler
                    // must not answer OperatorUnauthorized (the check must
                    // never reject a valid delegation).
                    assert_ne!(
                        error_code(&outcome),
                        Some(u32::from(FructusError::OperatorUnauthorized)),
                        "{step}: predicate authorized but the handler rejected"
                    );
                } else {
                    // Not authorized (pristine/revoked/foreign) => the handler
                    // MUST reject with OperatorUnauthorized and change nothing.
                    assert_operator_unauthorized(outcome, &step);
                    assert_bytes_identical(&bytes_pre, &touched_accounts(&env, &s).await, &step);
                }

                // Ring maintenance: drain before it can fill (fills would then
                // fail BookFull — allowed, but it would mask fill coverage).
                let book = book_view(&env).await;
                if book.write_cursor.saturating_sub(book.read_cursor) >= 24 {
                    crank(&mut env).await.expect("mid-sequence crank");
                }

                // Revoke-then-operator-op rejection, forced mid-sequence: right
                // after a revoke, an operator op is attempted immediately.
                if kind == 2 {
                    let bytes_pre = touched_accounts(&env, &s).await;
                    let probe = op_deposit(&mut env, &k1, &s, 1).await;
                    assert_operator_unauthorized(probe, &format!("{step}: post-revoke probe"));
                    assert_bytes_identical(
                        &bytes_pre,
                        &touched_accounts(&env, &s).await,
                        &format!("{step}: post-revoke probe"),
                    );
                }

                assert_safety_invariants(&env, &[&s, &m, &l], step.as_str()).await;
            }

            // ---- end-state liquidation probe (no under-margin miss) ----------
            // The TWAP guard is evaluated over the account's 16 observation
            // slots, INCLUDING never-written (slot 0) entries, and the bank's
            // slot only moves on `warp_to_slot` — so every pre-warp mutation
            // lands in the SAME slot. If the observation ring were fully
            // written with all entries at one slot, the trailing reference
            // pair degenerates and the guard has no lower anchor. Make the
            // guard reference deterministic: warp past all history, then
            // record ONE more observation AFTER the warp, so the newest
            // observation sits at the warped slot with an earlier distinct
            // slot (or an unwritten slot-0 entry) behind it.
            let last_obs = book_view(&env)
                .await
                .observations
                .iter()
                .filter(|o| o.slot != 0)
                .map(|o| o.slot)
                .max()
                .unwrap_or(1);
            let warp_target = last_obs.wrapping_add(1_001);
            env.ctx
                .warp_to_slot(warp_target)
                .expect("warp past the TWAP window");
            // Post-warp anchor: a resting order records an observation. Try a
            // bottom-of-book bid first; fall back to a top-of-book ask.
            let anchor_ok = if place_limit_order(&mut env, &m, LONG, 1_000, 1_000)
                .await
                .is_ok()
            {
                true
            } else {
                place_limit_order(&mut env, &m, SHORT, 999_999_999, 1_000)
                    .await
                    .is_ok()
            };
            assert!(
                anchor_ok,
                "harness: could not record a post-warp TWAP observation"
            );
            let book = book_view(&env).await;
            assert_eq!(
                book.observations
                    .iter()
                    .map(|o| o.slot)
                    .max()
                    .unwrap_or(0),
                warp_target,
                "harness: the post-warp observation must sit at the warp slot"
            );

            let rate = stake_pool_rate(&env).await;
            let long = position_state(&env, &s.long).await;
            let short = position_state(&env, &s.short).await;
            let uc = user_collateral_state(&env, &s.user_collateral)
                .await
                .expect("subject ledger");
            let pnl_sum = long.as_ref().map(|p| pnl_of(p, rate)).unwrap_or(0)
                + short.as_ref().map(|p| pnl_of(p, rate)).unwrap_or(0);
            let n_long = long.as_ref().map(|p| p.notional).unwrap_or(0);
            let n_short = short.as_ref().map(|p| p.notional).unwrap_or(0);
            let liquidatable =
                account_is_liquidatable(uc.deposited, pnl_sum, n_long, n_short);

            if liquidatable {
                // A genuinely under-margin account must liquidate on a
                // satisfied TWAP window — a miss would be the finding.
                let side = if n_long > 0 { LONG } else { SHORT };
                let amount = if n_long > 0 { n_long } else { n_short };
                let pool_pre = market_state(&env).await.pnl_pool;
                let liq_pre = user_collateral_state(&env, &l.user_collateral)
                    .await
                    .expect("liquidator ledger")
                    .deposited;
                let vault_pre = vault_balance(&env).await;
                liquidate(&mut env, &s, &l, side, amount)
                    .await
                    .expect("under-margin account must liquidate (no miss)");
                let pool_post = market_state(&env).await.pnl_pool;
                let liq_post = user_collateral_state(&env, &l.user_collateral)
                    .await
                    .expect("liquidator ledger")
                    .deposited;
                let uc_post = user_collateral_state(&env, &s.user_collateral)
                    .await
                    .expect("subject ledger");
                assert_eq!(vault_balance(&env).await, vault_pre, "vault unchanged");
                assert_eq!(
                    uc_post.deposited as u128 + liq_post as u128 + pool_post as u128,
                    uc.deposited as u128 + liq_pre as u128 + pool_pre as u128,
                    "liquidation must not create value"
                );
                assert_safety_invariants(&env, &[&s, &m, &l], "T4 post-liquidation").await;
            } else {
                // Healthy (or zero exposure): the gate must refuse, with the
                // state untouched.
                let side = if n_long > 0 { LONG } else if n_short > 0 { SHORT } else { LONG };
                let amount = if n_long > 0 { n_long } else if n_short > 0 { n_short } else { 1 };
                let bytes_pre = touched_accounts(&env, &s).await;
                let res = liquidate(&mut env, &s, &l, side, amount).await;
                let code = error_code(&res);
                // A healthy account is refused by the trigger (NotLiquidatable),
                // a program-owned zero-notional side by PositionNotFound, and a
                // pristine (never-created) side by Anchor's `Account<Position>`
                // constraint (ACCOUNT_NOT_INITIALIZED = 3012) before the
                // handler -- all three are refusals.
                assert!(
                    code == Some(u32::from(FructusError::NotLiquidatable))
                        || code == Some(u32::from(FructusError::PositionNotFound))
                        || code == Some(3012),
                    "a healthy account must refuse liquidation (got {res:?})"
                );
                assert_bytes_identical(
                    &bytes_pre,
                    &touched_accounts(&env, &s).await,
                    "refused liquidation",
                );
                assert_safety_invariants(&env, &[&s, &m, &l], "T4 post-refusal").await;
            }
        });
    }
}

// ---------------------------------------------------------------------------
// T5 — orderbook::cancel / event-ring interactions through the operator path
// ---------------------------------------------------------------------------

#[tokio::test]
async fn operator_cancel_event_ring_backpressure() {
    let Some(mut env) = setup().await else {
        return;
    };
    let s = env.a.clone();
    let m = env.b.clone();
    let k1 = funded_keypair(&mut env).await;
    deposit(&mut env, &s, 1_000_000)
        .await
        .expect("subject ledger");
    bind(&mut env, &s, k1.pubkey()).await.expect("bind");

    // --- Phase A: fill both sides of the book (16 each, no events on rest). --
    for i in 0..16u64 {
        op_order(
            &mut env,
            &k1,
            &s,
            OpOrderArgs::Limit {
                side: LONG,
                price: 100_000 + i * 1_000,
                size: 10_000,
            },
        )
        .await
        .expect("subject bid rests");
    }
    for i in 0..16u64 {
        place_limit_order(&mut env, &m, SHORT, 900_000 + i * 1_000, 10_000)
            .await
            .expect("maker ask rests");
    }
    let book = book_view(&env).await;
    assert_eq!(book.active_bids(), 16);
    assert_eq!(book.active_asks(), 16);
    assert_eq!(book.write_cursor, 0, "resting orders emit no events");
    assert_eq!(book.read_cursor, 0);

    // --- Phase B: the subject cancels its 16 bids via the operator path. -----
    for i in 0..16u64 {
        op_cancel(&mut env, &k1, &s, i)
            .await
            .expect("subject cancel");
    }
    let book = book_view(&env).await;
    assert_eq!(book.active_bids(), 0);
    assert_eq!(
        book.write_cursor, 16,
        "each cancel appends exactly one event"
    );
    for slot in 0..16usize {
        let ev = book.event(slot);
        assert_eq!(ev.seq, slot as u64, "cancel event seq = write-cursor order");
        assert_eq!(ev.kind, 1, "kind 1 = Cancel");
        assert_eq!(
            ev.owner,
            s.pubkey(),
            "the cancel is attributed to the SUBJECT"
        );
        assert_eq!(ev.counterparty, Pubkey::default());
        assert_eq!(ev.side, LONG);
        assert_eq!(ev.price, 100_000 + slot as u64 * 1_000);
        assert_eq!(ev.size, 10_000);
        assert_eq!(ev.settled, 0);
        assert_eq!(
            ev.entry_total_lamports, 0,
            "non-fill events carry no index snapshot"
        );
        assert_eq!(ev.entry_pool_token_supply, 0);
    }

    // --- Phase C: the maker cancels its 16 asks directly -> ring exactly full.
    for i in 16..32u64 {
        cancel_direct(&mut env, &m, i).await.expect("maker cancel");
    }
    let book = book_view(&env).await;
    assert_eq!(book.active_asks(), 0);
    assert_eq!(book.write_cursor, 32, "the ring is now full");
    let ev16 = book.event(16);
    assert_eq!(ev16.kind, 1);
    assert_eq!(ev16.owner, m.pubkey());
    assert_eq!(ev16.side, SHORT);

    // --- Phase D: a cancel on the FULL ring succeeds and drops its event -----
    op_order(
        &mut env,
        &k1,
        &s,
        OpOrderArgs::Limit {
            side: LONG,
            price: 200_000,
            size: 10_000,
        },
    )
    .await
    .expect("subject bid rests (no event)");
    let book = book_view(&env).await;
    let seq = book
        .resting_of(&s.pubkey())
        .first()
        .expect("subject has a resting bid")
        .seq;
    op_cancel(&mut env, &k1, &s, seq)
        .await
        .expect("cancel must not fail on a full ring (documented backpressure)");
    let book = book_view(&env).await;
    assert_eq!(
        book.resting_of(&s.pubkey()).len(),
        0,
        "the order is removed"
    );
    assert_eq!(
        book.write_cursor, 32,
        "the dropped Cancel event must not advance the cursor"
    );

    // --- Phase E: a FILL on the full ring fails loudly (fills are never
    // silently dropped), and the transaction reverts atomically. --------------
    place_limit_order(&mut env, &m, SHORT, 950_000, 10_000)
        .await
        .expect("maker ask rests");
    let book_bytes = account_data(&env, &env.order_book).await;
    let uc_pre = user_collateral_state(&env, &s.user_collateral)
        .await
        .unwrap();
    assert_anchor_error(
        op_open(&mut env, &k1, &s, LONG, 10_000, 0).await,
        FructusError::BookFull,
    );
    assert_eq!(
        account_data(&env, &env.order_book).await,
        book_bytes,
        "the BookFull abort must leave the book byte-identical"
    );
    assert!(
        position_state(&env, &s.long).await.is_none(),
        "the aborted open must not create a position"
    );
    let uc_after = user_collateral_state(&env, &s.user_collateral)
        .await
        .unwrap();
    assert_eq!(
        (uc_after.deposited, uc_after.reserved, uc_after.claimable),
        (uc_pre.deposited, uc_pre.reserved, uc_pre.claimable),
        "the aborted open must not touch the ledger"
    );

    // --- Phase F: a crank drain re-opens the ring; the fill then persists,
    // and the taker's position is settled inline (the client-visible effect). --
    crank(&mut env).await.expect("crank drains 8");
    let book = book_view(&env).await;
    assert_eq!(book.read_cursor, 8, "crank drains its bounded batch");
    assert_eq!(book.write_cursor, 32);

    op_open(&mut env, &k1, &s, LONG, 10_000, 0)
        .await
        .expect("the fill appends once the ring has room");
    let book = book_view(&env).await;
    assert_eq!(book.write_cursor, 33, "the fill persisted a new event");
    assert_eq!(book.read_cursor, 8);
    let ev0 = book.event(0);
    assert_eq!(ev0.seq, 32, "the fill wraps into the freed slot 0");
    assert_eq!(ev0.kind, 0, "kind 0 = Fill");
    assert_eq!(ev0.owner, m.pubkey(), "maker-attributed");
    assert_eq!(ev0.counterparty, s.pubkey());
    assert_eq!(ev0.side, SHORT, "maker rested on the ask side");
    assert_eq!(ev0.price, 950_000);
    assert_eq!(ev0.size, 10_000);
    assert_eq!(ev0.settled, 0, "fresh fill awaits maker settlement");
    assert_eq!(
        ev0.entry_total_lamports, BASE_TOTAL_LAMPORTS,
        "the fill stamps the live index snapshot"
    );
    assert_eq!(ev0.entry_pool_token_supply, BASE_POOL_TOKEN_SUPPLY);

    let long = position_state(&env, &s.long)
        .await
        .expect("subject long created");
    assert_eq!(long.notional, 10_000);
    assert_eq!(long.collateral, margin_required(10_000));
    let uc = user_collateral_state(&env, &s.user_collateral)
        .await
        .unwrap();
    assert_eq!(uc.reserved, margin_required(10_000));

    assert_safety_invariants(&env, &[&s, &m], "T5 final").await;
}
