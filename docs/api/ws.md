# WebSocket push (`/ws`)

**Purpose:** the server→client push channel (product-v2, REQ-B-7): a client
connects to `/ws?token=<session JWT>` and receives state-change messages as
JSON objects discriminated by their `type` field.

## Connection

- **Endpoint**: `GET /ws?token=<session JWT>` — an HTTP upgrade on the same
  server as the [REST surface](../api.md).
- **Auth**: the token is the 24 h session JWT from `POST /auth/verify`, checked
  against the auth service on upgrade. A missing, unknown, invalid or expired
  token closes the socket immediately with WebSocket close code **4401**
  (`WS_UNAUTHORIZED`); no push traffic is sent before authentication.
- **Payloads**: one JSON object per message. The `type` discriminator takes
  exactly five values — `'book'`, `'mark'`, `'user'`, `'tx'`, `'trade'`:

| Type | Payload | When |
| --- | --- | --- |
| `'book'` | `{ type: 'book', market: string, book: BookView }` | The order book changed — L2 levels (`bids`/`asks` as `[price, size]` pairs, best first) |
| `'mark'` | `{ type: 'mark', market: string, mark: MarketView }` | The mark/index snapshot moved (`mark`, `index`, `fundingAccumulator`, `bestBid`, `bestAsk`) |
| `'user'` | `{ type: 'user', portfolio: UserPortfolio }` | The wallet's portfolio **changed** — a signed delta vs. the state at connect / its last push (positions only for the sides that moved; `health`/`operator` current-state) — see [Portfolio deltas](#portfolio-deltas-user) |
| `'tx'` | `{ type: 'tx', action: ActionResponse }` | An `/actions/*` action **confirmed** on chain (`{actionId, signature, status: 'confirmed'}`) |
| `'trade'` | `{ type: 'trade', market: string, trade: TradeView }` | A **newly indexed fill** — one message per fill, ascending seq (product-v3) |

The DTO types are the shared types from `sdk/src/api.ts` (`BookView`,
`MarketView`, `UserPortfolio`, `ActionResponse`), pushed without an envelope —
`book`/`mark`/`tx` carry the same shapes the REST routes serve; the `user`
message reuses `UserPortfolio` to carry a **change**, not a snapshot (see
below).

```json
{ "type": "book", "market": "<market pubkey>", "book": { "bids": [["...", "..."]], "asks": [] } }
{ "type": "mark", "market": "<market pubkey>", "mark": { "mark": null, "index": "...", "fundingAccumulator": "...", "bestBid": null, "bestAsk": null } }
{ "type": "user", "portfolio": { "wallet": "...", "deposited": "...", "reserved": "...", "claimable": "...", "free": "...", "equity": "...", "requirementInitial": "...", "requirementMaint": "...", "health": "healthy", "operator": null, "positions": [] } }
{ "type": "tx", "action": { "actionId": "...", "status": "confirmed" } }
{ "type": "trade", "market": "<market pubkey>", "trade": { "seq": "12", "slot": "4300", "timeMs": "1700000000123", "owner": "<maker pubkey>", "side": 0, "price": "100001", "size": "2000000" } }
```

## Portfolio deltas (`user`)

The `user` message is the wallet's portfolio **change**, not an absolute
snapshot: every numeric field — `deposited`, `reserved`, `claimable`, `free`,
`equity`, `requirementInitial`, `requirementMaint` — is a **signed decimal
delta** against the baseline: the state the wallet started from at connect
(the same state its `GET /me` snapshot carries) and each state pushed after
that. Apply each `user` message to the state you last held; the REST reads
(`GET /me`) stay absolute.

- The change convention is pinned by a test: after a 25 tUSDC deposit onto a
  wallet whose ledger held 1 tUSDC at connect, the pushed `deposited` is
  `"25000000"` — the change — never the `"26000000"` ledger total.
- `positions` carries only the sides whose contribution actually moved, each
  with signed per-field deltas (`notional`, `upnl`, `reqInitial`, `reqMaint`);
  a side that did not move is omitted.
- `health` and `operator` carry the current state (an enum and a delegate
  record have no delta dimension).
- No message is pushed when nothing the payload carries moved.
- If the server could not seed the connect baseline, the first push falls back
  to the absolute snapshot; later pushes are deltas against it.

## Notes

- Numeric fields are **decimal strings** of raw base units, exactly as in the
  REST payloads (`sdk/src/api.ts` is the single source of truth); in the
  `user` deltas they are signed where a field can decrease (`"-25000000"`).
- `trade` messages are one per newly indexed fill (ascending seq); a resync
  re-delivery of an already-persisted fill is never re-pushed.
- `null` means "not available yet" (no two-sided book, no operator record).
- The channel is push-only: the client does not send application messages.
