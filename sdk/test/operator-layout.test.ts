import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { DISCRIMINATOR, OPERATOR_LEN, OperatorLayout } from "../src/account/layout.js";
import { decodeOperator } from "../src/account/decode.js";
import { anchorAccountDiscriminator } from "../src/encoding.js";

// SDK-OPERATOR-DECODER-ROUNDTRIPS (REQ-A1-7 / REQ-A1-1): `Operator` is the
// per-(market, user) delegation record — borsh `{market, user, operator, bump}`
// with a 97-byte payload. Following the `decode.ts` convention, decoders read
// the FULL account buffer (8-byte anchor discriminator + payload) and read
// fields at `DISCRIMINATOR + <payload offset>`; a truncated buffer yields null.

function fill(byte: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(byte));
}

const MARKET = fill(0xa1);
const USER = fill(0xb2);
const OPERATOR = fill(0xc3);
/** `Pubkey::default()` — the revoke state stored in the `operator` field (D3). */
const DEFAULT_KEY = new PublicKey(new Uint8Array(32));

/** Assemble a real account buffer: the `Operator` discriminator + the 97-byte payload. */
function operatorAccount(market: PublicKey, user: PublicKey, operator: PublicKey, bump: number): Buffer {
  const buf = Buffer.alloc(DISCRIMINATOR + OPERATOR_LEN);
  anchorAccountDiscriminator("Operator").copy(buf, 0);
  market.toBuffer().copy(buf, DISCRIMINATOR + OperatorLayout.market);
  user.toBuffer().copy(buf, DISCRIMINATOR + OperatorLayout.user);
  operator.toBuffer().copy(buf, DISCRIMINATOR + OperatorLayout.operator);
  buf[DISCRIMINATOR + OperatorLayout.bump] = bump;
  return buf;
}

test("SDK-OPERATOR-DECODER-ROUNDTRIPS: decodeOperator round-trips the 97-byte layout byte-exactly (incl. truncation hostiles). The Operator payload is exactly 97 bytes with market@0, user@32, operator@64, bump@96.", () => {
  assert.equal(OPERATOR_LEN, 97, "Operator payload LEN");
  let cursor = 0;
  for (const [offset, size] of [
    [OperatorLayout.market, 32],
    [OperatorLayout.user, 32],
    [OperatorLayout.operator, 32],
    [OperatorLayout.bump, 1],
  ]) {
    assert.equal(offset, cursor, `Operator field at ${offset} != running offset ${cursor}`);
    cursor += size;
  }
  assert.equal(cursor, OPERATOR_LEN, "the four fields sum to LEN");
});

test("SDK-OPERATOR-DECODER-ROUNDTRIPS: decodeOperator round-trips the 97-byte layout byte-exactly (incl. truncation hostiles).", () => {
  const decoded = decodeOperator(operatorAccount(MARKET, USER, OPERATOR, 254));
  assert.notEqual(decoded, null, "a complete discriminator+payload buffer must decode");
  assert.equal(decoded!.market.toBase58(), MARKET.toBase58(), "market");
  assert.equal(decoded!.user.toBase58(), USER.toBase58(), "user");
  assert.equal(decoded!.operator.toBase58(), OPERATOR.toBase58(), "operator");
  assert.equal(decoded!.bump, 254, "bump");
});

test("SDK-OPERATOR-DECODER-ROUNDTRIPS: decodeOperator round-trips the 97-byte layout byte-exactly (incl. truncation hostiles). Extreme field bytes and the revoked (default-key) state decode exactly.", () => {
  const extremes = decodeOperator(operatorAccount(fill(0x00), fill(0xff), fill(0xff), 255));
  assert.notEqual(extremes, null, "all-0x00 / all-0xff field vectors must decode");
  assert.equal(extremes!.market.toBase58(), fill(0x00).toBase58(), "market");
  assert.equal(extremes!.user.toBase58(), fill(0xff).toBase58(), "user");
  assert.equal(extremes!.operator.toBase58(), fill(0xff).toBase58(), "operator");
  assert.equal(extremes!.bump, 255, "bump");

  // The revoke state (D3): `operator` holds `Pubkey::default()`, record kept.
  const revoked = decodeOperator(operatorAccount(MARKET, USER, DEFAULT_KEY, 250));
  assert.notEqual(revoked, null, "the revoke state still decodes (no account close)");
  assert.equal(revoked!.operator.equals(DEFAULT_KEY), true, "operator field is Pubkey::default()");
  assert.equal(revoked!.operator.toBase58(), "11111111111111111111111111111111");
  assert.equal(revoked!.market.toBase58(), MARKET.toBase58(), "market survives revoke");
});

test("SDK-OPERATOR-DECODER-ROUNDTRIPS: decodeOperator round-trips the 97-byte layout byte-exactly (incl. truncation hostiles). Short buffers yield null; trailing padding is ignored.", () => {
  const full = operatorAccount(MARKET, USER, OPERATOR, 7);
  assert.equal(decodeOperator(null), null, "null input");
  assert.equal(decodeOperator(Buffer.alloc(0)), null, "empty buffer");
  assert.equal(
    decodeOperator(full.subarray(0, DISCRIMINATOR + OPERATOR_LEN - 1)),
    null,
    "one byte short of discriminator+payload",
  );
  assert.equal(
    decodeOperator(Buffer.alloc(OPERATOR_LEN)),
    null,
    "the 97-byte payload without the 8-byte discriminator prefix",
  );
  assert.equal(decodeOperator(full.subarray(0, OPERATOR_LEN)), null, "cut inside the buffer");

  // Oversized buffers are accepted; the trailing bytes are padding (`need()`'s >= convention).
  const oversized = Buffer.concat([full, Buffer.alloc(24, 0xaa)]);
  const decoded = decodeOperator(oversized);
  assert.notEqual(decoded, null, "trailing padding is ignored");
  assert.equal(decoded!.market.toBase58(), MARKET.toBase58(), "market");
  assert.equal(decoded!.user.toBase58(), USER.toBase58(), "user");
  assert.equal(decoded!.operator.toBase58(), OPERATOR.toBase58(), "operator");
  assert.equal(decoded!.bump, 7, "bump");
});
