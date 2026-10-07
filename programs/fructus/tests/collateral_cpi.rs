//! Bank-style CPI integration tests for the collateral vault.
//!
//! These tests run the real instruction handlers (`initialize_collateral_vault`,
//! `deposit_collateral`, `withdraw_collateral`) against a local bank built with
//! `solana-program-test`, a real SPL Token mint + associated token account, and
//! the SPL Token program loaded in-process. They assert actual token-account
//! balance movement and ledger updates, not just the pure accounting logic
//! (which `src/tests.rs` already locks with proptest).
//!
//! The Fructus program itself is loaded as a compiled SBF binary (built with
//! `cargo build-sbf` / `anchor build`): Anchor 1.x routes CPI through
//! `solana-invoke`, which is SBF-only and cannot run under solana-program-test's
//! in-process `processor!` shim.

use std::path::{Path, PathBuf};

use anchor_lang::{AccountDeserialize, InstructionData};
use fructus::constants::{PERP_MARKET_SEED, POSITION_SEED, USER_COLLATERAL_SEED, VAULT_SEED};
use fructus::error::FructusError;
use fructus::exchange::STAKE_POOL_PROGRAM_ID;
use fructus::state::UserCollateral;
use solana_account::Account;
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
use spl_token::state::Account as TokenAccount;
use spl_token::state::AccountState;
use spl_token::state::Mint;

/// USDC collateral mint decimals, matching `constants::USDC_DECIMALS`.
const DECIMALS: u8 = 6;
/// Initial minted amount: 1,000,000 USDC (6 decimals).
const MINT_AMOUNT: u64 = 1_000_000_000_000;
/// Lamports used to fund the pre-created accounts (mint, user).
const FUNDING_LAMPORTS: u64 = 10_000_000_000;

/// The system program id is the all-zero pubkey (`11111111111111111111111111111111`).
fn system_program_id() -> Pubkey {
    Pubkey::default()
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

/// Bytes for a fake SPL Stake Pool account, enough for `initialize_market`'s
/// `read_stake_pool` validation to succeed: the `StakePool` account-type
/// discriminator (byte 0) plus non-zero `total_lamports` / `pool_token_supply`
/// at the canonical offsets.
fn fake_stake_pool_data() -> Vec<u8> {
    let mut data = vec![0u8; 274];
    data[0] = 1; // AccountType::StakePool
    data[258..266].copy_from_slice(&10_000_000_000_000u64.to_le_bytes()); // total_lamports
    data[266..274].copy_from_slice(&10_000_000_000_000u64.to_le_bytes()); // pool_token_supply
    data
}

/// Serialized, initialized SPL Token `Account` state for a pre-funded account.
///
/// Used to seed the user's associated token account directly in the bank (the
/// modern Associated Token Account program unconditionally initializes the
/// Token-2022 `ImmutableOwner` extension, which plain Tokenkeg rejects, and an
/// ATA is an off-curve PDA that only a program can create via `invoke_signed`).
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

/// A fully-wired test environment: program + SPL programs loaded, collateral
/// mint created (with `decimals`), a funded `user`, the user's ATA, and the
/// `PerpMarket` initialized. The vault is left *uninitialized* so tests can
/// exercise `initialize_collateral_vault` themselves.
struct Env {
    ctx: ProgramTestContext,
    market: Pubkey,
    vault: Pubkey,
    mint: Pubkey,
    /// The market-bound index source (fake jitoSOL stake pool) recorded by
    /// `initialize_market`; `withdraw_collateral` re-checks the address.
    index_source: Pubkey,
    user: Keypair,
    user_ata: Pubkey,
    user_collateral: Pubkey,
}

async fn setup(decimals: u8) -> Option<Env> {
    let program_id = fructus::ID;

    // Run the Fructus program from its SBF binary (Anchor 1.x CPI is SBF-only),
    // loaded as an executable account owned by the SBF loader.
    let so = match find_fructus_so() {
        Some(so) => so,
        None => {
            eprintln!(
                "skipping collateral CPI test: fructus.so not found; \
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
    // The SPL Token program runs in-process; it performs no CPI of its own for
    // the `initialize_mint` / `mint_to` / `transfer` / `initialize_account3`
    // instructions exercised here.
    pt.add_program(
        "spl_token",
        spl_token::id(),
        processor!(spl_token::processor::Processor::process),
    );

    // Fake index-source (jitoSOL stake pool) account, owned by the stake-pool
    // program, so `initialize_market` accepts it. Kept on `Env` because
    // `withdraw_collateral` takes it again (address-checked against
    // `market.index_source`) for the equity gate.
    let index_source = Pubkey::new_from_array([9u8; 32]);
    pt.add_account(
        index_source,
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

    // Funded user account (pays for the lazily-created UserCollateral PDA).
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

    // User's associated token account, seeded directly in the bank with an
    // empty (amount == 0) initialized state; `mint_to` funds it below.
    let user_ata = get_associated_token_address(&user.pubkey(), &mint.pubkey());
    pt.add_account(
        user_ata,
        Account {
            lamports: FUNDING_LAMPORTS,
            data: token_account_data(&mint.pubkey(), &user.pubkey(), 0),
            owner: spl_token::id(),
            executable: false,
            rent_epoch: 0,
        },
    );

    let mut ctx = pt.start_with_context().await;

    // 1. Initialize the mint.
    let ix = spl_token::instruction::initialize_mint(
        &spl_token::id(),
        &mint.pubkey(),
        &ctx.payer.pubkey(),
        None,
        decimals,
    )
    .expect("initialize_mint builds");
    submit(&mut ctx, vec![ix], &[])
        .await
        .expect("initialize_mint");

    // 2. Mint collateral to the user's ATA (mint authority = payer).
    let ix = spl_token::instruction::mint_to(
        &spl_token::id(),
        &mint.pubkey(),
        &user_ata,
        &ctx.payer.pubkey(),
        &[],
        MINT_AMOUNT,
    )
    .expect("mint_to builds");
    submit(&mut ctx, vec![ix], &[]).await.expect("mint_to");

    // 4. Initialize the perpetual market (binds the vault PDA + collateral mint).
    let market = Pubkey::find_program_address(&[PERP_MARKET_SEED], &program_id).0;
    let vault = Pubkey::find_program_address(&[VAULT_SEED], &program_id).0;
    let data = fructus::instruction::InitializeMarket {
        collateral_mint: mint.pubkey(),
        funding_k: 100_000,
        max_funding: 10_000,
        funding_epoch_slots: 1_000,
        initial_margin_bps: 1_000,
        maintenance_margin_bps: 500,
    }
    .data();
    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(market, false),                     // market (init)
            AccountMeta::new_readonly(index_source, false),      // index_source
            AccountMeta::new_readonly(ctx.payer.pubkey(), true), // authority (signer)
            AccountMeta::new(ctx.payer.pubkey(), true),          // payer (signer, mut)
            AccountMeta::new_readonly(system_program_id(), false), // system_program
        ],
        data,
    };
    submit(&mut ctx, vec![ix], &[])
        .await
        .expect("initialize_market");

    let user_collateral = Pubkey::find_program_address(
        &[
            USER_COLLATERAL_SEED,
            market.as_ref(),
            user.pubkey().as_ref(),
        ],
        &program_id,
    )
    .0;

    Some(Env {
        ctx,
        market,
        vault,
        mint: mint.pubkey(),
        index_source,
        user,
        user_ata,
        user_collateral,
    })
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

async fn initialize_vault(env: &mut Env) -> Result<(), BanksClientError> {
    let data = fructus::instruction::InitializeCollateralVault.data();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            AccountMeta::new_readonly(env.market, false), // market
            AccountMeta::new_readonly(env.ctx.payer.pubkey(), true), // authority (signer)
            AccountMeta::new(env.ctx.payer.pubkey(), true), // payer (signer, mut)
            AccountMeta::new(env.vault, false),           // vault (mut)
            AccountMeta::new_readonly(env.mint, false),   // collateral_mint
            AccountMeta::new_readonly(system_program_id(), false), // system_program
            AccountMeta::new_readonly(spl_token::id(), false), // token_program
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[]).await
}

async fn deposit(env: &mut Env, amount: u64) -> Result<(), BanksClientError> {
    let data = fructus::instruction::DepositCollateral { amount }.data();
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            AccountMeta::new(env.user.pubkey(), true), // user (signer, mut)
            AccountMeta::new(env.market, false),       // market (mut)
            AccountMeta::new(env.user_collateral, false), // user_collateral (mut)
            AccountMeta::new(env.vault, false),        // vault (mut)
            AccountMeta::new(env.user_ata, false),     // user_ata (mut)
            AccountMeta::new_readonly(env.mint, false), // collateral_mint
            AccountMeta::new_readonly(system_program_id(), false), // system_program
            AccountMeta::new_readonly(spl_token::id(), false), // token_program
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[&env.user]).await
}

async fn withdraw(env: &mut Env, amount: u64) -> Result<(), BanksClientError> {
    let data = fructus::instruction::WithdrawCollateral { amount }.data();
    // The per-`(market, user, side)` position PDAs the account-level equity
    // gate reads (`Σ upnl` per side), derived from the PRD Appendix slot
    // layout. These tests never open a position, so both sides are pristine
    // (not created yet) — passed read-only and worth zero unrealized PnL to
    // the handler.
    let position_long = Pubkey::find_program_address(
        &[
            POSITION_SEED,
            env.market.as_ref(),
            env.user.pubkey().as_ref(),
            &[0], // Side::Long
        ],
        &fructus::ID,
    )
    .0;
    let position_short = Pubkey::find_program_address(
        &[
            POSITION_SEED,
            env.market.as_ref(),
            env.user.pubkey().as_ref(),
            &[1], // Side::Short
        ],
        &fructus::ID,
    )
    .0;
    let ix = Instruction {
        program_id: fructus::ID,
        accounts: vec![
            AccountMeta::new_readonly(env.user.pubkey(), true), // user (signer)
            AccountMeta::new(env.market, false),                // market (mut)
            AccountMeta::new(env.user_collateral, false),       // user_collateral (mut)
            AccountMeta::new(env.vault, false),                 // vault (mut)
            AccountMeta::new(env.user_ata, false),              // user_ata (mut)
            AccountMeta::new_readonly(env.mint, false),         // collateral_mint
            AccountMeta::new_readonly(env.index_source, false), // index_source
            AccountMeta::new_readonly(position_long, false),    // position_long
            AccountMeta::new_readonly(position_short, false),   // position_short
            AccountMeta::new_readonly(spl_token::id(), false),  // token_program
        ],
        data,
    };
    submit(&mut env.ctx, vec![ix], &[&env.user]).await
}

async fn vault_balance(env: &Env) -> u64 {
    let account = env
        .ctx
        .banks_client
        .get_account(env.vault)
        .await
        .unwrap()
        .expect("vault account exists");
    TokenAccount::unpack(&account.data).unwrap().amount
}

async fn user_ata_balance(env: &Env) -> u64 {
    let account = env
        .ctx
        .banks_client
        .get_account(env.user_ata)
        .await
        .unwrap()
        .expect("user ATA exists");
    TokenAccount::unpack(&account.data).unwrap().amount
}

async fn deposited(env: &Env) -> u64 {
    let account = env
        .ctx
        .banks_client
        .get_account(env.user_collateral)
        .await
        .unwrap()
        .expect("user_collateral account exists");
    let mut data: &[u8] = &account.data;
    UserCollateral::try_deserialize(&mut data)
        .unwrap()
        .deposited
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

#[tokio::test]
async fn initialize_deposit_withdraw_move_token_balances() {
    let Some(mut env) = setup(DECIMALS).await else {
        return;
    };

    // initialize_collateral_vault creates a vault token account whose mint is
    // the collateral mint and whose authority is the vault PDA itself.
    initialize_vault(&mut env).await.expect("initialize vault");
    let vault_account = env
        .ctx
        .banks_client
        .get_account(env.vault)
        .await
        .unwrap()
        .expect("vault exists");
    let vault_state = TokenAccount::unpack(&vault_account.data).unwrap();
    assert_eq!(vault_state.mint, env.mint, "vault mint == collateral mint");
    assert_eq!(vault_state.owner, env.vault, "vault authority == vault PDA");

    // deposit_collateral moves `amount` from the user ATA to the vault and
    // credits `UserCollateral.deposited`.
    let amount = 5_000_000u64;
    let before_ata = user_ata_balance(&env).await;
    deposit(&mut env, amount).await.expect("deposit");
    assert_eq!(user_ata_balance(&env).await, before_ata - amount);
    assert_eq!(vault_balance(&env).await, amount);
    assert_eq!(deposited(&env).await, amount);

    // withdraw_collateral moves it back and debits the ledger.
    let before_vault = vault_balance(&env).await;
    withdraw(&mut env, amount).await.expect("withdraw");
    assert_eq!(user_ata_balance(&env).await, before_ata);
    assert_eq!(vault_balance(&env).await, before_vault - amount);
    assert_eq!(deposited(&env).await, 0);
}

#[tokio::test]
async fn withdraw_exceeding_free_collateral_fails() {
    let Some(mut env) = setup(DECIMALS).await else {
        return;
    };
    initialize_vault(&mut env).await.expect("initialize vault");
    deposit(&mut env, 1_000_000).await.expect("deposit");

    let before_ata = user_ata_balance(&env).await;
    let before_vault = vault_balance(&env).await;
    let before_deposited = deposited(&env).await;

    // Withdrawing more than free collateral (deposited - reserved) must fail
    // with InsufficientFreeCollateral and move no tokens.
    let result = withdraw(&mut env, 1_000_001).await;
    assert_anchor_error(result, FructusError::InsufficientFreeCollateral);
    assert_eq!(user_ata_balance(&env).await, before_ata, "no ATA change");
    assert_eq!(vault_balance(&env).await, before_vault, "no vault change");
    assert_eq!(deposited(&env).await, before_deposited, "no ledger change");
}

#[tokio::test]
async fn second_initialize_vault_fails() {
    let Some(mut env) = setup(DECIMALS).await else {
        return;
    };
    initialize_vault(&mut env).await.expect("initialize vault");
    let result = initialize_vault(&mut env).await;
    assert_anchor_error(result, FructusError::VaultAlreadyInitialized);
}

#[tokio::test]
async fn zero_amount_deposit_withdraw_fails_invalid_size() {
    let Some(mut env) = setup(DECIMALS).await else {
        return;
    };
    initialize_vault(&mut env).await.expect("initialize vault");

    // deposit(0) is rejected before any ledger exists.
    assert_anchor_error(deposit(&mut env, 0).await, FructusError::InvalidSize);

    // Initialize the ledger, then withdraw(0) is rejected by the handler's
    // zero-amount check (the `UserCollateral` account must exist first, since
    // `withdraw_collateral` deserializes it).
    deposit(&mut env, 1_000_000).await.expect("deposit");
    assert_anchor_error(withdraw(&mut env, 0).await, FructusError::InvalidSize);
}

#[tokio::test]
async fn wrong_decimals_mint_fails_invalid_mint() {
    // A 9-decimal mint is rejected at vault initialization.
    let Some(mut env) = setup(9).await else {
        return;
    };
    let result = initialize_vault(&mut env).await;
    assert_anchor_error(result, FructusError::InvalidMint);
}

/// T4: every vault CPI test body is `let Some(mut env) = setup(..) else { return; }`,
/// so `cargo test --workspace` reports green while silently skipping all vault
/// assertions whenever the SBF binary is missing (or runs a stale binary).
/// This guard converts that silent skip/staleness into a hard failure.
#[test]
fn cpi_binary_is_present_and_fresh() {
    let so = find_fructus_so().expect(
        "fructus.so not built; every vault CPI test below silently skips under \
         `cargo test --workspace` (FR-19 / REQ-4 require them to actually run)",
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
