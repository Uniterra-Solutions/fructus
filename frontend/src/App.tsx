//! App wiring: providers + terminal store + wallet auth (in-page demo wallet or
//! a Wallet-Standard extension) + REST/WS data flows. The Shell stays pure.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import nacl from "tweetnacl";
import type { ActionResponse, PlaceOrderActionRequest } from "fructus-sdk/src/api.js";
import { ApiError, createApiClient } from "./api/client.js";
import { createWsClient } from "./api/ws.js";
import { LocaleProvider } from "./i18n/index.js";
import { Shell } from "./components/Shell.js";
import { authReducer } from "./state/auth.js";
import { createTerminalStore, reduceWsMessage, type TerminalStore } from "./state/store.js";
import { loadOrCreateDemoKeypair } from "./wallet/demoWallet.js";
import type { CandleInterval } from "./lib/candles.js";

const SESSION_STORAGE = "fructus.session";

interface StoredSession {
  token: string;
  wallet: string;
}

function loadStoredSession(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    return parsed.token && parsed.wallet ? { token: parsed.token, wallet: parsed.wallet } : null;
  } catch {
    return null;
  }
}

function saveStoredSession(session: StoredSession): void {
  try {
    window.localStorage.setItem(SESSION_STORAGE, JSON.stringify(session));
  } catch {
    /* storage unavailable — the session simply does not persist */
  }
}

function clearStoredSession(): void {
  try {
    window.localStorage.removeItem(SESSION_STORAGE);
  } catch {
    /* ignore */
  }
}

/** Same-origin paths — dev: Vite proxy; prod: reverse proxy (see frontend/README.md). */
function rpcUrl(): string {
  return new URL("/rpc", window.location.origin).toString();
}

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = window.atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] as number);
  return window.btoa(binary);
}

function describe(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

interface ActiveSigner {
  publicKey: PublicKey;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  signTransaction(transaction: Transaction): Promise<Transaction>;
}

function Terminal() {
  const wallet = useWallet();
  const storeRef = useRef<TerminalStore | null>(null);
  if (storeRef.current === null) storeRef.current = createTerminalStore();
  const store = storeRef.current;
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const api = useMemo(() => createApiClient("/api"), []);
  const connection = useMemo(() => new Connection(rpcUrl(), "confirmed"), []);
  const [status, setStatus] = useState<string | null>(null);
  const demoRef = useRef<Keypair | null>(null);

  const activeSigner = useCallback((): ActiveSigner | null => {
    const { connected, publicKey, signMessage, signTransaction } = wallet;
    if (connected && publicKey && signMessage && signTransaction) {
      const owner = publicKey;
      return {
        publicKey: owner,
        signMessage: (message) => signMessage(message),
        signTransaction: async (transaction) => {
          const signed = await signTransaction(transaction);
          if (signed === null) throw new Error("Wallet declined the transaction");
          return signed as Transaction;
        },
      };
    }
    const kp = demoRef.current;
    if (!kp) return null;
    return {
      publicKey: kp.publicKey,
      // web3.js >= 1.98 dropped `Keypair.sign`; detached-ed25519 via tweetnacl.
      signMessage: async (message) => nacl.sign.detached(message, kp.secretKey),
      signTransaction: async (transaction) => {
        transaction.sign(kp);
        return transaction;
      },
    };
  }, [wallet]);

  const handleUnauthorized = useCallback(
    (e: unknown): boolean => {
      if (e instanceof ApiError && e.status === 401) {
        clearStoredSession();
        store.dispatch((s) => ({ ...s, auth: authReducer(s.auth, { type: "unauthorized" }) }));
        setStatus("Session expired — sign in again");
        return true;
      }
      return false;
    },
    [store],
  );

  const refreshPortfolio = useCallback(
    async (token: string) => {
      try {
        const portfolio = await api.me(token);
        store.dispatch((s) => ({ ...s, portfolio }));
        return portfolio;
      } catch (e) {
        if (!handleUnauthorized(e)) setStatus(describe(e));
        return null;
      }
    },
    [api, store, handleUnauthorized],
  );

  // ---- bootstrap: public reads on mount ------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [market, book, candles, trades] = await Promise.all([
          api.market(),
          api.book(),
          api.candles("1m"),
          api.trades(),
        ]);
        if (cancelled) return;
        store.dispatch((s) => ({ ...s, market, book, candles: candles.candles, trades: trades.trades }));
      } catch (e) {
        if (!cancelled) setStatus(describe(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, store]);

  // ---- session restore ------------------------------------------------------
  useEffect(() => {
    const saved = loadStoredSession();
    if (!saved) return;
    void (async () => {
      try {
        const portfolio = await api.me(saved.token);
        store.dispatch((s) => ({
          ...s,
          portfolio,
          auth: authReducer(s.auth, { type: "login", wallet: saved.wallet, token: saved.token }),
        }));
        const operator = portfolio.operator?.address ?? null;
        if (operator) {
          store.dispatch((s) => ({ ...s, auth: authReducer(s.auth, { type: "bind", operator }) }));
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) clearStoredSession();
      }
    })();
  }, [api, store]);

  // ---- WS lifecycle: (re)connect whenever a session token lands -------------
  const token = state.auth.token;
  useEffect(() => {
    if (!token) return;
    const client = createWsClient({
      url: wsUrl(),
      token,
      onMessage: (message) => store.dispatch((s) => reduceWsMessage(s, message)),
      onStatus: (wsStatus) => store.dispatch((s) => ({ ...s, wsStatus })),
    });
    return () => client.close();
  }, [token, store]);

  // ---- actions --------------------------------------------------------------
  const connect = useCallback(() => {
    const { connected, publicKey } = wallet;
    if (connected && publicKey) {
      store.dispatch((s) => ({ ...s, auth: authReducer(s.auth, { type: "connect", wallet: publicKey.toBase58() }) }));
      setStatus("Wallet connected");
      return;
    }
    const kp = loadOrCreateDemoKeypair(window.localStorage);
    demoRef.current = kp;
    store.dispatch((s) => ({ ...s, auth: authReducer(s.auth, { type: "connect", wallet: kp.publicKey.toBase58() }) }));
    setStatus("Demo wallet connected");
  }, [wallet, store]);

  const disconnect = useCallback(() => {
    clearStoredSession();
    store.dispatch((s) => ({
      ...s,
      auth: authReducer(s.auth, { type: "disconnect" }),
      portfolio: null,
      lastAction: null,
    }));
    setStatus("Disconnected");
  }, [store]);

  const login = useCallback(async () => {
    const signer = activeSigner();
    if (!signer) {
      setStatus("Connect a wallet first");
      return;
    }
    try {
      setStatus("Signing in…");
      const address = signer.publicKey.toBase58();
      const challenge = await api.challenge(address);
      const signature = bs58.encode(await signer.signMessage(new TextEncoder().encode(challenge.signInInput)));
      const session = await api.verify({ wallet: address, signature, signInInput: challenge.signInInput });
      saveStoredSession({ token: session.token, wallet: session.wallet });
      store.dispatch((s) => ({
        ...s,
        auth: authReducer(s.auth, { type: "login", wallet: session.wallet, token: session.token }),
      }));
      const portfolio = await refreshPortfolio(session.token);
      const operator = portfolio?.operator?.address ?? null;
      if (operator) {
        store.dispatch((s) => ({ ...s, auth: authReducer(s.auth, { type: "bind", operator }) }));
      }
      setStatus("Signed in");
    } catch (e) {
      setStatus(describe(e));
    }
  }, [activeSigner, api, refreshPortfolio, store]);

  const bind = useCallback(async () => {
    const signer = activeSigner();
    const sessionToken = state.auth.token;
    if (!signer || !sessionToken) {
      setStatus("Sign in first");
      return;
    }
    try {
      setStatus("Preparing the bind transaction…");
      const prepared = await api.bindPrepare(signer.publicKey.toBase58());
      const transaction = await signer.signTransaction(Transaction.from(b64ToBytes(prepared.transaction)));
      const raw = new Uint8Array(transaction.serialize());
      const signature = await connection.sendRawTransaction(raw, { skipPreflight: false });
      await connection.confirmTransaction(signature, "confirmed");
      const result = await api.bindConfirm(bytesToB64(raw), signature);
      if (result.status === "bound" && result.operator) {
        const operator = result.operator;
        store.dispatch((s) => ({ ...s, auth: authReducer(s.auth, { type: "bind", operator }) }));
        setStatus("Operator bound — trading enabled");
      } else {
        store.dispatch((s) => ({ ...s, auth: authReducer(s.auth, { type: "revoked" }) }));
        setStatus("Operator revoked");
      }
    } catch (e) {
      setStatus(describe(e));
    }
  }, [activeSigner, api, connection, state.auth.token, store]);

  const faucet = useCallback(async () => {
    const signer = activeSigner();
    if (!signer) {
      setStatus("Connect a wallet first");
      return;
    }
    try {
      if (demoRef.current && signer.publicKey.equals(demoRef.current.publicKey)) {
        try {
          const airdrop = await connection.requestAirdrop(signer.publicKey, LAMPORTS_PER_SOL);
          await connection.confirmTransaction(airdrop, "confirmed");
        } catch {
          /* devnet: no free airdrop — the account needs SOL from elsewhere */
        }
      }
      const minted = await api.faucet(signer.publicKey.toBase58());
      setStatus(`Faucet minted ${minted.amount} → ${minted.ata}`);
    } catch (e) {
      setStatus(describe(e));
    }
  }, [activeSigner, api, connection]);

  const runAction = useCallback(
    async (fn: () => Promise<ActionResponse>) => {
      try {
        const result = await fn();
        setStatus(`${result.actionId}: ${result.status}`);
        if (state.auth.token) void refreshPortfolio(state.auth.token);
      } catch (e) {
        if (!handleUnauthorized(e)) setStatus(describe(e));
      }
    },
    [state.auth.token, refreshPortfolio, handleUnauthorized],
  );

  const deposit = useCallback(
    (amount: string) => {
      const sessionToken = state.auth.token;
      if (!sessionToken) {
        setStatus("Sign in first");
        return;
      }
      void runAction(() => api.deposit(sessionToken, amount));
    },
    [api, runAction, state.auth.token],
  );

  const withdraw = useCallback(
    (amount: string) => {
      const sessionToken = state.auth.token;
      if (!sessionToken) {
        setStatus("Sign in first");
        return;
      }
      void runAction(() => api.withdraw(sessionToken, amount));
    },
    [api, runAction, state.auth.token],
  );

  const submitOrder = useCallback(
    (request: PlaceOrderActionRequest) => {
      const sessionToken = state.auth.token;
      if (!sessionToken) {
        setStatus("Sign in first");
        return;
      }
      void runAction(() => api.placeOrder(sessionToken, request));
    },
    [api, runAction, state.auth.token],
  );

  const closePosition = useCallback(
    (side: 0 | 1, size: string) => {
      const sessionToken = state.auth.token;
      if (!sessionToken) {
        setStatus("Sign in first");
        return;
      }
      void runAction(() => api.closePosition(sessionToken, { side, size }));
    },
    [api, runAction, state.auth.token],
  );

  const changeInterval = useCallback(
    (interval: CandleInterval) => {
      store.dispatch((s) => ({ ...s, interval }));
      void (async () => {
        try {
          const response = await api.candles(interval);
          store.dispatch((s) => ({ ...s, candles: response.candles }));
        } catch {
          /* keep the live fold */
        }
      })();
    },
    [api, store],
  );

  return (
    <Shell
      auth={state.auth}
      market={state.market}
      book={state.book}
      candles={state.candles}
      trades={state.trades}
      portfolio={state.portfolio}
      interval={state.interval}
      status={status}
      actions={{
        connect,
        disconnect,
        login,
        bind,
        faucet,
        deposit,
        withdraw,
        submitOrder,
        closePosition,
        setInterval: changeInterval,
      }}
    />
  );
}

export function App() {
  return (
    <LocaleProvider>
      <ConnectionProvider endpoint={rpcUrl()}>
        <WalletProvider wallets={[]} autoConnect>
          <Terminal />
        </WalletProvider>
      </ConnectionProvider>
    </LocaleProvider>
  );
}
