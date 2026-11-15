"use strict";
// Field-case replay runner: screens every *.preview.json in
// engine/replays/ (real historical sarah.ai contract calls, replayed
// read-only against current chain state) and writes the full report
// next to it as *.report.json.
//
//   node engine/run_replays.js
//
// The verdicts describe the call as it screens TODAY, anchored to the
// current block — not the day it originally executed (POLICY §8:
// verdicts expire with the block they are anchored to).

const fs = require("fs");
const path = require("path");
const { screenPreview } = require("./screen");

const DIR = path.join(__dirname, "replays");

async function main() {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".preview.json")).sort();
  for (const file of files) {
    const preview = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8"));
    const report = await screenPreview(preview);
    const outName = file.replace(".preview.json", ".report.json");
    fs.writeFileSync(path.join(DIR, outName), JSON.stringify(report, null, 2) + "\n");
    const triggered = report.rules.filter((r) => r.status === "TRIGGERED").map((r) => r.id);
    console.log(
      `${file} -> ${outName}\n  verdict=${report.verdict} (${report.verdictLabel}) block=${report.blockNumber}` +
        `\n  triggered: ${triggered.join(", ") || "none"}` +
        `\n  counts: ${JSON.stringify(report.ruleCounts)}`
    );
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("replay run failed:", e);
    process.exit(2);
  });
}
