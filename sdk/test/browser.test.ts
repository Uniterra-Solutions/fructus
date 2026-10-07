import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ACCOUNT_DISCRIMINATORS, IX_DISCRIMINATORS } from "../src/encoding.js";

// SDK-NO-NODE-BUILTINS + SDK-DISCRIMINATOR-TABLES-MATCH-SHA256 (REQ-C-2/D13):
// the SDK's browser entry (`src/index.ts`) must bundle without Node builtins —
// every anchor discriminator comes from the precomputed constant tables, whose
// entries the tests cross-check against `node:crypto` sha256 and whose sizes
// are pinned to the program's surface.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../src");
const SDK_ROOT = path.resolve(SRC, "..");
const ENTRY = path.join(SRC, "index.ts");

// --- module-graph walk (relative `./` / `../` imports, transitively) --------

/** The `import`/`export ... from` specifiers of one module source. */
function specifiersOf(source: string): string[] {
  const out: string[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    const isImportHead = /^(import|export)\b/.test(trimmed);
    const isFromTail = /^\}?\s*from\s+["']/.test(trimmed); // multi-line import continuation
    if (!isImportHead && !isFromTail) continue;
    const from = trimmed.match(/from\s+["']([^"']+)["']/);
    if (from) {
      out.push(from[1]);
      continue;
    }
    const sideEffect = trimmed.match(/^import\s+["']([^"']+)["']/);
    if (sideEffect) out.push(sideEffect[1]);
  }
  return out;
}

/** Resolve a relative import specifier to the `.ts` source it names (NodeNext `.js` style). */
function resolveRelative(fromFile: string, specifier: string): string {
  const base = path.resolve(path.dirname(fromFile), specifier);
  return base.endsWith(".js") ? `${base.slice(0, -3)}.ts` : `${base}.ts`;
}

/** Walk the module graph from `entry`; collect every file and every `node:` import found. */
function walkModuleGraph(entry: string): { files: string[]; offenders: string[] } {
  const seen = new Set<string>();
  const queue = [entry];
  const offenders: string[] = [];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
      if (spec.startsWith("node:")) {
        offenders.push(`${path.relative(SDK_ROOT, file)} imports ${spec}`);
      }
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const resolved = resolveRelative(file, spec);
        if (!seen.has(resolved)) queue.push(resolved);
      }
    }
  }
  return { files: [...seen].sort(), offenders: offenders.sort() };
}

test("SDK-NO-NODE-BUILTINS: no module reachable from sdk/src/index.ts imports a node: builtin (positive control: the module graph is non-empty).", () => {
  const { files, offenders } = walkModuleGraph(ENTRY);

  // Positive control (non-vacuity): the walk really traversed the graph — a
  // non-empty closure that includes the known transitive modules.
  assert.ok(
    files.length >= 10,
    `positive control: expected >= 10 modules reachable from index.ts, scanned ${files.length}`,
  );
  for (const known of ["encoding.ts", "instructions.ts", "account/decode.ts", "pda.ts", "api.ts"]) {
    assert.ok(
      files.some((f) => path.relative(SRC, f) === known),
      `positive control: ${known} must be reachable from index.ts`,
    );
  }

  assert.deepEqual(
    offenders,
    [],
    `node: builtins reachable from the browser entry: ${offenders.join(", ")}`,
  );
});

// --- discriminator tables vs sha256 (the GREEN pin) --------------------------

test("SDK-DISCRIMINATOR-TABLES-MATCH-SHA256: every IX_DISCRIMINATORS entry equals sha256('global:' + name)[0..8].", () => {
  const names = Object.keys(IX_DISCRIMINATORS);
  assert.equal(names.length, 29, "the table pins 21 direct + 8 operator instructions");

  for (const name of names) {
    const entry = Buffer.from(IX_DISCRIMINATORS[name]);
    assert.equal(entry.length, 8, `${name}: discriminator size`);
    const expected = createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
    assert.deepEqual(entry, expected, `${name}: sha256("global:${name}")[0..8]`);
  }

  // The operator layer (D2) is part of the pinned surface.
  for (const name of [
    "set_operator",
    "operator_deposit_collateral",
    "operator_withdraw_collateral",
    "operator_open_position",
    "operator_close_position",
    "operator_place_limit_order",
    "operator_place_market_order",
    "operator_cancel_order",
  ]) {
    assert.ok(name in IX_DISCRIMINATORS, `operator table entry missing: ${name}`);
  }
});

test("SDK-DISCRIMINATOR-TABLES-MATCH-SHA256: every ACCOUNT_DISCRIMINATORS entry equals sha256('account:' + name)[0..8].", () => {
  const names = Object.keys(ACCOUNT_DISCRIMINATORS);
  assert.equal(names.length, 6, "the table pins the program's 6 account types");
  assert.deepEqual(
    [...names].sort(),
    ["Operator", "OrderBook", "PerpMarket", "Position", "UserCollateral", "YieldOracle"],
    "account-type coverage (incl. Operator)",
  );

  for (const name of names) {
    const entry = Buffer.from(ACCOUNT_DISCRIMINATORS[name]);
    assert.equal(entry.length, 8, `${name}: discriminator size`);
    const expected = createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
    assert.deepEqual(entry, expected, `${name}: sha256("account:${name}")[0..8]`);
  }
});
