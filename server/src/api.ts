//! REST surface (REQ-B-7, D14): `node:http` only, no framework. Every response
//! is the unified JSON envelope from `sdk/src/api.ts` (REQ-C-3). `GET /healthz`
//! is live; every other route answers `501 not_implemented` until its wave
//! lands. `ROUTES` is the exported contract and mirrors `docs/api/openapi.json`
//! (REQ-C-1).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { PublicKey } from "@solana/web3.js";
import type { ApiResponse, BookView, HealthzResponse, MarketView, UserPortfolio } from "fructus-sdk/src/api.js";
import type { AuthService } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Faucet } from "./faucet.js";
import type { Keeper } from "./keeper.js";
import type { OperatorService } from "./operator.js";

export interface Route {
  method: "GET" | "POST";
  path: string;
  /** JWT-gated (REQ-B-4: everything under /me and /actions). */
  private: boolean;
}

/** The contract: exactly the routes of PRD REQ-B-7. */
export const ROUTES: readonly Route[] = [
  { method: "POST", path: "/auth/challenge", private: false },
  { method: "POST", path: "/auth/verify", private: false },
  { method: "POST", path: "/bind/prepare", private: false },
  { method: "POST", path: "/bind/confirm", private: false },
  { method: "GET", path: "/me", private: true },
  { method: "GET", path: "/me/positions", private: true },
  { method: "GET", path: "/me/history", private: true },
  { method: "GET", path: "/market", private: false },
  { method: "GET", path: "/market/book", private: false },
  { method: "POST", path: "/actions/deposit", private: true },
  { method: "POST", path: "/actions/withdraw", private: true },
  { method: "POST", path: "/actions/orders", private: true },
  { method: "POST", path: "/actions/orders/cancel", private: true },
  { method: "POST", path: "/actions/positions/close", private: true },
  { method: "POST", path: "/faucet", private: false },
  { method: "GET", path: "/healthz", private: false },
];

export interface ApiServerDeps {
  config: Config;
  db: Db;
  auth: AuthService;
  operator: OperatorService;
  keeper: Keeper;
  /** `null` when the faucet is not configured (D15 → 404). */
  faucet: Faucet | null;
  /** Read models (state.ts), injected so tests can seed them. */
  getPortfolio: (wallet: PublicKey) => UserPortfolio | Promise<UserPortfolio>;
  getMarket: () => MarketView | Promise<MarketView>;
  getBook: () => BookView | Promise<BookView>;
}

export interface ApiServer {
  /** The raw `node:http` server (the WS layer attaches to it). */
  readonly server: Server;
  /** The registered route table (the machine-checkable contract). */
  readonly routes: readonly Route[];
  /** Listen; defaults to `config.port`. Resolves with the bound port. */
  start(port?: number): Promise<number>;
  /** Close the listener (idempotent). */
  close(): Promise<void>;
}

export function createApiServer(deps: ApiServerDeps): ApiServer {
  const server = createServer((req, res) => {
    handle(deps, req, res);
  });

  return {
    server,
    routes: ROUTES,

    start(port = deps.config.port): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once("error", onError);
        server.listen(port, () => {
          server.removeListener("error", onError);
          const address = server.address();
          resolve(address !== null && typeof address === "object" ? address.port : port);
        });
      });
    },

    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function handle(deps: ApiServerDeps, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const route = ROUTES.find((r) => r.method === req.method && r.path === url.pathname);

  if (route === undefined) {
    sendJson(res, 404, {
      ok: false,
      error: { code: "not_found", message: `no route: ${req.method} ${url.pathname}` },
    } satisfies ApiResponse<never>);
    return;
  }

  if (route.path === "/healthz") {
    // Live (REQ-B-10 smoke surface); `slot` fills in once the indexer runs.
    const data: HealthzResponse = { status: "ok", slot: null };
    sendJson(res, 200, { ok: true, data } satisfies ApiResponse<HealthzResponse>);
    return;
  }

  // STUB: every other route 501s until its wave lands. Later dispatch here:
  // drain + parse the JSON body (bounded); for `route.private` verify
  // `Authorization: Bearer` via `deps.auth.verifyToken` → 401
  // `{code:"unauthorized"}` when null; route to the auth / bind / state /
  // operator / faucet / keeper handlers and map FructusError names plus
  // transport errors onto `{code, message}` (http status per error class).
  req.resume(); // drain any body so the connection can be reused
  sendJson(res, 501, {
    ok: false,
    error: { code: "not_implemented", message: `${route.method} ${route.path} is not implemented yet` },
  } satisfies ApiResponse<never>);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
