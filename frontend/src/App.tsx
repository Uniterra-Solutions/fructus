//! App wiring: providers + terminal store + wallet auth (in-page demo wallet or
//! a Wallet-Standard extension) + REST/WS data flows. The Shell stays pure.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import nacl from "tweetnacl";
import type { ActionResponse, PlaceOrderActionRequest } from "fructus-sdk/src/api.js";
import { ApiError, createApiClient } from "./api/client.js";
import { createWsClient, type WsStatus } from "./api/ws.js";
import { LocaleProvider } from "./i18n/index.js";
import { Shell } from "./components/Shell.js";
import { authReducer } from "./state/auth.js";
import { createTerminalStore, reduceWsMessage, type TerminalStore } from "./state/store.js";
import { loadExistingDemoKeypair, loadOrCreateDemoKeypair } from "./wallet/demoWallet.js";
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

/**
 * Proxy-safe confirmation: poll `getSignatureStatuses` over HTTP. The legacy
 * `connection.confirmTransaction(sig, commitment)` opens a WebSocket
 * subscription (`ws://<same-origin>/rpc`), which the dev reverse proxy does not
 * upgrade — the promise then hangs forever (measured: tx landed, client stuck).
 * Transient status-RPC errors are retried until the deadline.
 */
async function confirmSignature(connection: Connection, signature: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let status: { err: unknown; confirmationStatus?: string } | null | undefined;
    try {
      const result = await connection.getSignatureStatuses([signature]);
      status = result.value[0] as typeof status;
    } catch {
      /* transient RPC error — retry until the deadline */
    }
    if (status !== null && status !== undefined) {
      if (status.err) throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") return;
    }
    if (Date.now() >= deadline) throw new Error(`timed out confirming ${signature.slice(0, 16)}…`);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
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
  const busyRef = useRef(false);
  const intervalSeqRef = useRef(0);
  const tokenRef = useRef<string | null>(null);
  const intervalRef = useRef<CandleInterval>("1m");
  tokenRef.current = state.auth.token;
  intervalRef.current = state.interval;

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

  /** One action at a time: a second click while a flow is in flight is ignored. */
  const runBusy = useCallback(async (fn: () => Promise<void>): Promise<void> => {
    if (busyRef.current) {
      setStatus("Another action is in flight — one moment");
      return;
    }
    busyRef.current = true;
    try {
      await fn();
    } finally {
      busyRef.current = false;
    }
  }, []);

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

  /** Refetch every snapshot the delta feeds baseline on (REQ-F-3). */
  const refreshSnapshots = useCallback(async () => {
    try {
      const [market, book, candles, trades] = await Promise.all([
        api.market(),
        api.book(),
        api.candles(intervalRef.current),
        api.trades(),
      ]);
      store.dispatch((s) => ({ ...s, market, book, candles: candles.candles, trades: trades.trades }));
      if (tokenRef.current !== null) void refreshPortfolio(tokenRef.current);
    } catch (e) {
      setStatus(describe(e));
    }
  }, [api, store, refreshPortfolio]);

  // ---- bootstrap: public reads on mount ------------------------------------
  useEffect(() => {
    void refreshSnapshots();
  }, [refreshSnapshots]);

  // ---- session restore ------------------------------------------------------
  useEffect(() => {
    const saved = loadStoredSession();
    if (!saved) return;
    // A demo session can sign again after a reload: re-seat the burner keypair
    // (peek only — a missing key means the identity is gone, so do not mint one).
    const existing = loadExistingDemoKeypair(window.localStorage);
    if (existing !== null && existing.publicKey.toBase58() === saved.wallet && demoRef.current === null) {
      demoRef.current = existing;
    }
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

  // ---- extension wallets: a finished connect lands the auth state -----------
  useEffect(() => {
    const { connected, publicKey } = wallet;
    if (connected && publicKey && state.auth.phase === "disconnected") {
      const address = publicKey.toBase58();
      store.dispatch((s) => ({ ...s, auth: authReducer(s.auth, { type: "connect", wallet: address }) }));
    }
  }, [wallet.connected, wallet.publicKey, state.auth.phase, store]);

  // ---- WS lifecycle: (re)connect whenever a session token lands -------------
  const token = state.auth.token;
  const handleWsUnauthorized = useCallback(() => {
    clearStoredSession();
    store.dispatch((s) => ({ ...s, auth: authReducer(s.auth, { type: "unauthorized" }) }));
    setStatus("Session expired — sign in again");
  }, [store]);

  useEffect(() => {
    if (!token) return;
    const client = createWsClient({
      url: wsUrl(),
      token,
      onMessage: (message) => store.dispatch((s) => reduceWsMessage(s, message)),
      onStatus: (wsStatus) => store.dispatch((s) => ({ ...s, wsStatus })),
      onUnauthorized: handleWsUnauthorized,
    });
    return () => client.close();
  }, [token, store, handleWsUnauthorized]);

  // ---- (re)connect ⇒ refetch: the server re-seeds its delta baselines at
  // connect, so a change missed while the socket was down can never arrive as
  // a delta — refetch the snapshots on every transition into `open` (REQ-F-3).
  const wsStatus = state.wsStatus;
  const prevWsStatusRef = useRef<WsStatus>("closed");
  useEffect(() => {
    const previous = prevWsStatusRef.current;
    prevWsStatusRef.current = wsStatus;
    if (wsStatus === "open" && previous !== "open") void refreshSnapshots();
  }, [wsStatus, refreshSnapshots]);

  // ---- actions --------------------------------------------------------------
  const connect = useCallback(() => {
    const { connected, publicKey, wallets, select } = wallet;
    if (connected && publicKey) {
      store.dispatch((s) => ({ ...s, auth: authReducer(s.auth, { type: "connect", wallet: publicKey.toBase58() }) }));
      setStatus("Wallet connected");
      return;
    }
    // Wallet-Standard extensions (Phantom et al.) are auto-wrapped by
    // WalletProvider; selecting an installed one connects it (autoConnect).
    const installed = wallets.find((candidate) => candidate.readyState === "Installed");
    if (installed) {
      setStatus("Connecting the wallet extension…");
      select(installed.adapter.name);
      return;
    }
    // No extension present: the in-page demo burner is the signer.
    const kp = loadOrCreateDemoKeypair(window.localStorage);
    demoRef.current = kp;
    store.dispatch((s) => ({ ...s, auth: authReducer(s.auth, { type: "connect", wallet: kp.publicKey.toBase58() }) }));
    setStatus("Demo wallet connected");
  }, [wallet, store]);

  const disconnect = useCallback(() => {
    if (wallet.connected) void wallet.disconnect().catch(() => undefined);
    clearStoredSession();
    store.dispatch((s) => ({
      ...s,
      auth: authReducer(s.auth, { type: "disconnect" }),
      portfolio: null,
      lastAction: null,
    }));
    setStatus("Disconnected");
  }, [wallet, store]);

  const login = useCallback(() => {
    void runBusy(async () => {
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
    });
  }, [runBusy, activeSigner, api, refreshPortfolio, store]);

  const bind = useCallback(() => {
    void runBusy(async () => {
      const signer = activeSigner();
      const sessionToken = tokenRef.current;
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
        await confirmSignature(connection, signature);
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
    });
  }, [runBusy, activeSigner, api, connection, store]);

  const faucet = useCallback(() => {
    void runBusy(async () => {
      const signer = activeSigner();
      if (!signer) {
        setStatus("Connect a wallet first");
        return;
      }
      try {
        if (demoRef.current && signer.publicKey.equals(demoRef.current.publicKey)) {
          try {
            const airdrop = await connection.requestAirdrop(signer.publicKey, LAMPORTS_PER_SOL);
            await confirmSignature(connection, airdrop, 30_000);
          } catch {
            /* devnet: no free airdrop — the account needs SOL from elsewhere */
          }
        }
        const minted = await api.faucet(signer.publicKey.toBase58());
        setStatus(`Faucet minted ${minted.amount} → ${minted.ata}`);
      } catch (e) {
        setStatus(describe(e));
      }
    });
  }, [runBusy, activeSigner, api, connection]);

  const runAction = useCallback(
    async (fn: () => Promise<ActionResponse>) => {
      await runBusy(async () => {
        try {
          const result = await fn();
          setStatus(`${result.actionId}: ${result.status}`);
          if (tokenRef.current !== null) void refreshPortfolio(tokenRef.current);
        } catch (e) {
          if (!handleUnauthorized(e)) setStatus(describe(e));
        }
      });
    },
    [runBusy, refreshPortfolio, handleUnauthorized],
  );

  const deposit = useCallback(
    (amount: string) => {
      const sessionToken = tokenRef.current;
      if (!sessionToken) {
        setStatus("Sign in first");
        return;
      }
      void runAction(() => api.deposit(sessionToken, amount));
    },
    [api, runAction],
  );

  const withdraw = useCallback(
    (amount: string) => {
      const sessionToken = tokenRef.current;
      if (!sessionToken) {
        setStatus("Sign in first");
        return;
      }
      void runAction(() => api.withdraw(sessionToken, amount));
    },
    [api, runAction],
  );

  const submitOrder = useCallback(
    (request: PlaceOrderActionRequest) => {
      const sessionToken = tokenRef.current;
      if (!sessionToken) {
        setStatus("Sign in first");
        return;
      }
      void runAction(() => api.placeOrder(sessionToken, request));
    },
    [api, runAction],
  );

  const closePosition = useCallback(
    (side: 0 | 1, size: string) => {
      const sessionToken = tokenRef.current;
      if (!sessionToken) {
        setStatus("Sign in first");
        return;
      }
      void runAction(() => api.closePosition(sessionToken, { side, size }));
    },
    [api, runAction],
  );

  const changeInterval = useCallback(
    (interval: CandleInterval) => {
      store.dispatch((s) => ({ ...s, interval }));
      const seq = ++intervalSeqRef.current;
      void (async () => {
        try {
          const response = await api.candles(interval);
          if (seq !== intervalSeqRef.current) return; // a newer switch superseded this fetch
          store.dispatch((s) => ({ ...s, candles: response.candles }));
        } catch {
          /* keep the live fold */
        }
      })();
    },
    [api, store],
  );

  const fetchChartCandles = useCallback(
    (interval: CandleInterval) => api.candles(interval).then((response) => response.candles),
    [api],
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
      status={status ?? (state.lastAction !== null ? `${state.lastAction.actionId}: ${state.lastAction.status}` : null)}
      chartFetchCandles={fetchChartCandles}
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
