//! Acceptance tests for the one-shot requote batch (MM-REQUOTE-ONE-SHOT):
//! an mm-bot cycle must assemble its whole cancel+place diff into ONE
//! transaction — every cancel (plan order) first, then every place (plan
//! order) — and the worst-case 8-level ladder (16 + 16 = 32 instructions)
//! must serialize inside the 1232-byte legacy packet limit with a single
//! signature. An empty plan submits nothing (never an empty transaction).
//!
//! Measured worst case on this tree: 1126 bytes / 32 instructions / 1 sig.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { buildCancelOrder, buildPlaceLimitOrder } from "fructus-sdk/src/index.js";
import { buildRequoteTransaction } from "../mm-bot.mjs";
import type { OwnOrder, Quote, RequotePlan } from "../mm-lib.mjs";

const MAX_PACKET_SIZE = 1232; // legacy tx limit (1280 MTU − 40 IPv6 − 8 UDP)
const DUMMY_BLOCKHASH = "11111111111111111111111111111111";

interface Keys {
  market: PublicKey;
  orderBook: PublicKey;
  indexSource: PublicKey;
  owner: PublicKey;
}

function makeKeys(): Keys {
  return {
    market: Keypair.generate().publicKey,
    orderBook: Keypair.generate().publicKey,
    indexSource: Keypair.generate().publicKey,
    owner: Keypair.generate().publicKey,
  };
}

/** 8 levels/side resting, every price about to move — the full-switch worst case. */
function worstCasePlan(): RequotePlan {
  const cancels: OwnOrder[] = [];
  const places: Quote[] = [];
  for (let k = 0; k < 8; k++) {
    cancels.push({ side: 0, seq: `${2 * k + 1}`, price: `${1_000_000n - BigInt(k) * 10_000n}`, size: "5000000" });
    cancels.push({ side: 1, seq: `${2 * k + 2}`, price: `${1_200_000n + BigInt(k) * 10_000n}`, size: "5000000" });
    places.push({ side: 0, price: `${1_500_000n - BigInt(k + 1) * 10_000n}`, size: "5000000" });
    places.push({ side: 1, price: `${1_500_000n + BigInt(k + 1) * 10_000n}`, size: "5000000" });
  }
  return { cancels, places };
}

/** Serialize `tx` as a signed wire transaction. */
function wire(tx: Transaction, signer: Keypair): Buffer {
  tx.recentBlockhash = DUMMY_BLOCKHASH;
  tx.sign(signer);
  return tx.serialize();
}

// ---------------------------------------------------------------------------
// MM-REQUOTE-ONE-SHOT
// ---------------------------------------------------------------------------

test("MM-REQUOTE-ONE-SHOT: a full requote is ONE transaction — all cancels then all places — within one 1232-byte packet, single signature", () => {
  const keys = makeKeys();
  const plan = worstCasePlan();
  const owner = Keypair.generate();

  const tx = buildRequoteTransaction(plan, { ...keys, owner: owner.publicKey });
  assert.ok(tx !== null, "a non-empty plan must produce a transaction");
  assert.equal(tx.feePayer?.toBase58(), owner.publicKey.toBase58(), "fee payer = the bot");

  // one instruction per planned cancel/place — none dropped, none extra
  assert.equal(tx.instructions.length, plan.cancels.length + plan.places.length, "instruction count = cancels + places");
  assert.equal(tx.instructions.length, 32, "worst case is 32 instructions");

  // exact sequence: cancels (plan order) then places (plan order)
  const expected = [
    ...plan.cancels.map((o) => buildCancelOrder({ market: keys.market, orderBook: keys.orderBook, owner: owner.publicKey, seq: BigInt(o.seq) })),
    ...plan.places.map((q) =>
      buildPlaceLimitOrder({
        market: keys.market,
        orderBook: keys.orderBook,
        indexSource: keys.indexSource,
        owner: owner.publicKey,
        side: q.side,
        price: BigInt(q.price),
        size: BigInt(q.size),
      }),
    ),
  ];
  for (let i = 0; i < expected.length; i++) {
    const actual: TransactionInstruction = tx.instructions[i] as TransactionInstruction;
    const want: TransactionInstruction = expected[i] as TransactionInstruction;
    assert.deepEqual(actual.data, want.data, `instruction ${i} payload differs`);
    assert.deepEqual(
      actual.keys.map((k) => `${k.pubkey.toBase58()}/${k.isSigner}/${k.isWritable}`),
      want.keys.map((k) => `${k.pubkey.toBase58()}/${k.isSigner}/${k.isWritable}`),
      `instruction ${i} accounts differ`,
    );
  }
  // boundary markers: cancel payloads are 16 bytes, place payloads 25
  assert.ok(tx.instructions.slice(0, 16).every((ix) => ix.data.length === 16), "first 16 instructions are the cancels");
  assert.ok(tx.instructions.slice(16).every((ix) => ix.data.length === 25), "last 16 instructions are the places");

  // ONE signature, ONE packet
  const raw = wire(tx, owner);
  assert.equal(tx.signatures.length, 1, "single signer (the bot)");
  assert.ok(raw.length <= MAX_PACKET_SIZE, `worst-case batch must fit one packet: ${raw.length} > ${MAX_PACKET_SIZE}`);

  // sweep every ladder size 1..8: the bound holds, instruction count tracks the plan
  for (let k = 1; k <= 8; k++) {
    const ownK: OwnOrder[] = [];
    const desiredK: Quote[] = [];
    for (let j = 0; j < k; j++) {
      ownK.push({ side: 0, seq: `${2 * j}`, price: `${900_000n - BigInt(j) * 1_000n}`, size: "5000000" });
      ownK.push({ side: 1, seq: `${2 * j + 1}`, price: `${1_100_000n + BigInt(j) * 1_000n}`, size: "5000000" });
    }
    for (let j = 1; j <= k; j++) {
      desiredK.push({ side: 0, price: `${1_000_000n - BigInt(j) * 1_000n}`, size: "5000000" });
      desiredK.push({ side: 1, price: `${1_000_000n + BigInt(j) * 1_000n}`, size: "5000000" });
    }
    const txK = buildRequoteTransaction({ cancels: ownK, places: desiredK }, { ...keys, owner: owner.publicKey });
    assert.ok(txK !== null, `levels=${k}: non-empty plan must produce a transaction`);
    assert.equal(txK.instructions.length, 4 * k, `levels=${k}: instruction count`);
    const rawK = wire(txK, owner);
    assert.ok(rawK.length <= MAX_PACKET_SIZE, `levels=${k}: ${rawK.length} bytes > ${MAX_PACKET_SIZE}`);
  }
});

// ---------------------------------------------------------------------------
// MM-REQUOTE-ONE-SHOT-EMPTY
// ---------------------------------------------------------------------------

test("MM-REQUOTE-ONE-SHOT-EMPTY: an empty plan submits nothing; single-sided plans stay in cancels-then-places order", () => {
  const keys = makeKeys();
  const owner = Keypair.generate().publicKey;

  // unchanged prices → no cancels, no places → no transaction at all
  assert.equal(
    buildRequoteTransaction({ cancels: [], places: [] }, { ...keys, owner }),
    null,
    "a no-op cycle must not produce a transaction",
  );

  // cancels only (e.g. the desired grid shrank)
  const cancelsOnly = buildRequoteTransaction(
    { cancels: [{ side: 0, seq: "7", price: "995000", size: "1000000" }], places: [] },
    { ...keys, owner },
  );
  assert.equal(cancelsOnly?.instructions.length, 1, "one cancel → one instruction");
  assert.equal(cancelsOnly?.instructions[0]?.data.length, 16, "cancel payload is 16 bytes");

  // places only (fresh ladder)
  const placesOnly = buildRequoteTransaction(
    {
      cancels: [],
      places: [
        { side: 0, price: "995000", size: "1000000" },
        { side: 1, price: "1005000", size: "1000000" },
      ],
    },
    { ...keys, owner },
  );
  assert.equal(placesOnly?.instructions.length, 2, "two places → two instructions");
  assert.deepEqual(
    placesOnly?.instructions[0]?.data,
    buildPlaceLimitOrder({ market: keys.market, orderBook: keys.orderBook, indexSource: keys.indexSource, owner, side: 0, price: 995000n, size: 1000000n }).data,
    "first instruction = first desired quote",
  );
});
