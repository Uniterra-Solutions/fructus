# fructus-frontend (product-v3 trading terminal)

The dark tech terminal over the fructus server surface — order book, open/close,
K-line (`lightweight-charts` v5), trades tape, wallet connect + SIWS sign-in +
operator binding, deposit/withdraw/faucet, bilingual UI (en / zh-Hant).

## Stack

Vite + React 19 + TypeScript; Tailwind v4 (dark tokens in `src/theme.css` —
Monaspace-like mono for numbers); TradingView **Lightweight Charts** v5
(Apache-2.0); `@solana/wallet-adapter-react` (extension wallets via Wallet
Standard) plus an in-page **demo wallet**; vitest + @testing-library/react (jsdom).

## Same-origin paths (dev proxy / prod reverse proxy)

| Path | Upstream | Purpose |
| --- | --- | --- |
| `/api/*` | fructus server | REST (prefix stripped by the proxy) |
| `/ws` | fructus server | push socket (`book`/`mark`/`user`/`tx`/`trade`) |
| `/rpc` | Solana RPC (`solana-test-validator` in the demo) | bind tx submit + airdrops |

`vite.config.ts` proxies all three in dev (server on `127.0.0.1:8787`, RPC on
`127.0.0.1:8899`). For a deployment, point a reverse proxy at the built
`dist/` and mirror these paths — the app never hardcodes absolute upstreams.

## Run the full local demo

```sh
# 1) chain + market + tokens (+ operator/MM keys). Long-running; prints env blocks.
cd scripts && npm install && npm run devstack

# 2) backend — paste the printed server env block
cd server && npm install && npm run dev

# 3) market maker — paste the printed bot env block
cd scripts && npm run mm

# 4) terminal
cd frontend && npm install && npm run dev   # → http://127.0.0.1:5173
```

Then, in the browser: **Demo wallet** (generated in-page) → *Connect* → *Sign in*
→ *Bind* (one wallet transaction delegates the operator) → *Faucet* → *Deposit*
→ trade. The gate (REQ-F-2): every trading control stays disabled until the
wallet is signed in **and** the operator is bound.

## Checks

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest run (jsdom; the acceptance suite lives in test/)
npm run build       # vite build → dist/
```

## Demo wallet notes

- The in-page burner keypair lives in `localStorage.fructus.demoKey`
  (dev-only; cleared by removing the key). Session JWT: `localStorage.fructus.session`.
- Message signing uses detached ed25519 (tweetnacl) — `@solana/web3.js` ≥ 1.98
  no longer exposes `Keypair.sign`.
- Binding sends one wallet transaction: `[spl approve(Operator PDA, MAX), set_operator]`
  against the program; the server never holds wallet keys.
- On the local validator the fountain also airdrops SOL to the demo wallet; on
  devnet, fund the burner address manually for the bind transaction's rent.
