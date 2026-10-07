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
  exactly four values — `'book'`, `'mark'`, `'user'`, `'tx'`:

| Type | Payload | When |
| --- | --- | --- |
| `'book'` | `{ type: 'book', market: string, book: BookView }` | The order book changed — L2 levels (`bids`/`asks` as `[price, size]` pairs, best first) |
| `'mark'` | `{ type: 'mark', market: string, mark: MarketView }` | The mark/index snapshot moved (`mark`, `index`, `fundingAccumulator`, `bestBid`, `bestAsk`) |
| `'user'` | `{ type: 'user', portfolio: UserPortfolio }` | The wallet's portfolio changed (deposited / reserved / claimable / equity / positions / health) |
| `'tx'` | `{ type: 'tx', action: ActionResponse }` | An `/actions/*` attempt progressed (`actionId`, `signature?`, `status`, `error?`) |

The DTO shapes are the shared types from `sdk/src/api.ts` (`BookView`,
`MarketView`, `UserPortfolio`, `ActionResponse`) — the same objects the REST
routes return, pushed without an envelope.

```json
{ "type": "book", "market": "<market pubkey>", "book": { "bids": [["...", "..."]], "asks": [] } }
{ "type": "mark", "market": "<market pubkey>", "mark": { "mark": null, "index": "...", "fundingAccumulator": "...", "bestBid": null, "bestAsk": null } }
{ "type": "user", "portfolio": { "wallet": "...", "deposited": "...", "reserved": "...", "claimable": "...", "free": "...", "equity": "...", "requirementInitial": "...", "requirementMaint": "...", "health": "healthy", "operator": null, "positions": [] } }
{ "type": "tx", "action": { "actionId": "...", "status": "confirmed" } }
```

## Notes

- Numeric fields are **decimal strings** of raw base units, exactly as in the
  REST payloads (`sdk/src/api.ts` is the single source of truth).
- `null` means "not available yet" (no two-sided book, no operator record).
- The channel is push-only: the client does not send application messages.
