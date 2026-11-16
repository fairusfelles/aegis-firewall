"use strict";
// Headless verification of the browser bundle (/tmp/aegis-test-bundle.cjs,
// built by `node build.mjs --test-bundle`).
//
// Test 1 — Poseidon exactness (the decisive bundle test): for each
// committed replay report, recompute commitment =
// Poseidon(fields[0..5], verdict) with the BUNDLED circomlibjs and
// require an exact match with the stored commitment. This proves the
// in-browser Poseidon (circomlibjs via ffjavascript) is bit-identical
// to the one that sealed the reports in Node.
//
// Test 2 — live pipeline: run the BUNDLED screenPreview on the FEG
// replay preview against live BSC state. The recorded block
// (133802201) is pruned by now (public endpoints retain ~1–2 h), so
// fields[5] and the commitment necessarily differ; what must hold is
// verdict = 2 (BLOCK) and the same triggered rules as recorded
// (AEGIS-B04 sale-over revert, AEGIS-W11 zero-slippage swapback —
// both are stable properties of the current chain state / verified
// source). fields[0..3] (version, chainId, walletHash, contractHash)
// are state-independent and must match exactly.

const assert = require("node:assert");

// The bundle is built for browsers, where `Worker` is a global
// constructor that ffjavascript's browser build references at import
// time (its ThreadManager support). Node has no such global, so
// provide an inert stand-in to let the import succeed. It is never
// constructed on the Poseidon/screening path — both are synchronous,
// single-threaded math — and if it ever were, this stub throws loudly
// instead of failing silently. In a real browser the genuine Worker
// global satisfies the reference.
global.Worker = class {
  constructor() {
    throw new Error("Worker is not available in the headless bundle test");
  }
};

require("/tmp/aegis-test-bundle.cjs");
const api = globalThis.AEGIS;
if (!api) throw new Error("bundle did not publish globalThis.AEGIS");

const reports = {
  feg: require("../engine/replays/feg-claimfree-share.report.json"),
  runinai: require("../engine/replays/runinai-claimfree.report.json"),
  bnbbaby: require("../engine/replays/bnbbaby-mint0.report.json"),
};

(async () => {
  console.log("== Test 1: bundled Poseidon vs stored commitments ==");
  for (const [name, report] of Object.entries(reports)) {
    const recomputed = await api.fields.computeCommitment(report.fields, report.verdict);
    assert.strictEqual(
      recomputed,
      report.commitment,
      `${name}: commitment mismatch\n  stored:     ${report.commitment}\n  recomputed: ${recomputed}`
    );
    console.log(`  PASS ${name}: commitment matches exactly (${report.commitment.slice(0, 24)}…)`);
  }

  console.log("== Test 2: bundled pipeline, live re-screen of the FEG replay ==");
  const stored = reports.feg;
  const live = await api.screenPreview(api.cases.feg.preview);
  console.log(`  live verdict: ${live.verdict} (${live.verdictLabel}) at block ${live.blockNumber}`);
  console.log(`  stored verdict: ${stored.verdict} (${stored.verdictLabel}) at block ${stored.blockNumber}`);
  assert.strictEqual(live.verdict, 2, "live FEG re-screen must BLOCK (the sale is over; the call reverts)");
  const liveTriggered = live.rules.filter((r) => r.status === "TRIGGERED").map((r) => r.id).sort();
  const storedTriggered = stored.rules.filter((r) => r.status === "TRIGGERED").map((r) => r.id).sort();
  console.log(`  live triggered:   ${liveTriggered.join(", ")}`);
  console.log(`  stored triggered: ${storedTriggered.join(", ")}`);
  assert.deepStrictEqual(liveTriggered, storedTriggered, "triggered rule sets differ");
  for (let i = 0; i <= 3; i++) {
    assert.strictEqual(live.fields[i], stored.fields[i], `fields[${i}] must be state-independent and match`);
  }
  console.log(`  fields[0..3] match the recorded report exactly`);
  console.log(`  fields[4] (simulationHash): live ${live.fields[4].slice(0, 20)}… vs stored ${stored.fields[4].slice(0, 20)}… (equality not required across blocks)`);
  console.log(`  fields[5] (blockNumber): live ${live.fields[5]} vs stored ${stored.fields[5]} (recorded block is pruned; a fresh anchor is expected)`);
  console.log(`  live commitment: ${live.commitment.slice(0, 24)}…`);
  console.log("ALL BUNDLE TESTS PASSED");
})().catch((e) => {
  console.error("BUNDLE TEST FAILED:", e.message);
  process.exit(1);
});
