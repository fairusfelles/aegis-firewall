"use strict";
// Unit-fixture runner: screens every fixture in engine/fixtures/
// against expectations.json, prints a per-fixture verdict, and records
// the full results in fixtures/results.json.
//
//   node engine/run_fixtures.js
//
// Exits non-zero if any expectation fails. Fixtures run against live
// BSC state (the engine is a chain-state screener), so results are
// recorded with the block each run anchored to.

const fs = require("fs");
const path = require("path");
const { screenPreview } = require("./screen");

const FIXTURE_DIR = path.join(__dirname, "fixtures");

async function main() {
  const expectations = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "expectations.json"), "utf8"));
  const results = [];
  let failures = 0;
  for (const [file, exp] of Object.entries(expectations)) {
    const preview = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), "utf8"));
    const report = await screenPreview(preview);
    const triggered = report.rules.filter((r) => r.status === "TRIGGERED").map((r) => r.id);
    const checks = [];
    const check = (ok, label) => {
      checks.push({ ok, label });
      if (!ok) failures++;
    };
    check(
      report.verdict === exp.expectVerdict,
      `verdict == ${exp.expectVerdict} (got ${report.verdict} ${report.verdictLabel})`
    );
    for (const id of exp.mustTrigger || [])
      check(triggered.includes(id), `${id} TRIGGERED (got: ${triggered.join(", ") || "none"})`);
    for (const id of exp.mustNotTrigger || [])
      check(!triggered.includes(id), `${id} not TRIGGERED`);
    const pass = checks.every((c) => c.ok);
    console.log(`${pass ? "PASS" : "FAIL"}  ${file}  verdict=${report.verdict} (${report.verdictLabel})  block=${report.blockNumber}`);
    for (const c of checks) console.log(`      ${c.ok ? "ok" : "XX"}  ${c.label}`);
    results.push({
      fixture: file,
      pass,
      checks,
      verdict: report.verdict,
      verdictLabel: report.verdictLabel,
      blockNumber: report.blockNumber,
      triggered,
      rulesBitmap: report.rulesBitmap,
      commitment: report.commitment,
      note: exp.note,
    });
  }
  const out = {
    ranAt: new Date().toISOString(),
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    results,
  };
  fs.writeFileSync(path.join(FIXTURE_DIR, "results.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`\n${out.passed}/${out.total} fixtures passed — results recorded in engine/fixtures/results.json`);
  if (failures) process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("fixture run failed:", e);
    process.exit(2);
  });
}
