"use strict";
// Browser entry for the AEGIS demo bundle.
//
// This re-exports the *unmodified* Node engine (engine/screen.js and
// engine/lib/fields.js) so the exact same code that produced the
// committed replay reports also runs in the judge's browser. The only
// adaptations live in the bundler (demo/build.mjs): `process.env` is
// defined as {} (so the engine uses its default public BSC RPC
// endpoints and the default Sourcify base URL), and the CLI-only
// `fs`/`path` imports of engine/screen.js are stubbed — its main()
// never runs here (guarded by require.main === module in Node, and
// simply never invoked from this entry).
//
// The three replay cases embed the committed preview fixtures and the
// recorded reports from engine/replays/, so the page can show the
// screening recorded at build time next to a fresh live re-screen.

const { screenPreview } = require("../../engine/screen.js");
const fields = require("../../engine/lib/fields.js");

function slimRecorded(report) {
  return {
    verdict: report.verdict,
    verdictLabel: report.verdictLabel,
    blockNumber: report.blockNumber,
    screenedAt: report.screenedAt,
    fields: report.fields,
    rulesBitmap: report.rulesBitmap,
    commitment: report.commitment,
    triggered: report.rules.filter((r) => r.status === "TRIGGERED").map((r) => r.id),
  };
}

const cases = {
  feg: {
    id: "feg",
    title: "FEG — claimFreeShare()",
    blurb:
      "Free-share claim on the CanopySale contract during the 2026-11-10 launch race. The tranche sold out in seconds; sarah.ai never claimed.",
    preview: require("../../engine/replays/feg-claimfree-share.preview.json"),
    recorded: slimRecorded(require("../../engine/replays/feg-claimfree-share.report.json")),
  },
  runinai: {
    id: "runinai",
    title: "RuninAI — claimFree()",
    blurb:
      "Free-share claim on FairAgentLaunchV3, executed successfully by sarah.ai on 2026-11-02 (receipt-verified on the day).",
    preview: require("../../engine/replays/runinai-claimfree.preview.json"),
    recorded: slimRecorded(require("../../engine/replays/runinai-claimfree.report.json")),
  },
  bnbbaby: {
    id: "bnbbaby",
    title: "BNBbbaby — mint(0)",
    blurb:
      "Free mint on BabyMint, executed successfully by sarah.ai on 2026-11-02 (receipt-verified on the day).",
    preview: require("../../engine/replays/bnbbaby-mint0.preview.json"),
    recorded: slimRecorded(require("../../engine/replays/bnbbaby-mint0.report.json")),
  },
};

// The 7 rules that always report NOT_IMPLEMENTED in engine v1: they
// need a keyed explorer/indexer source (holder distribution, LP
// holders/locks, USD pool liquidity, deployer labels). See
// engine/README.md "Rule coverage".
const NOT_IMPLEMENTED_V1 = [
  "AEGIS-B08",
  "AEGIS-B11",
  "AEGIS-B12",
  "AEGIS-W06",
  "AEGIS-W07",
  "AEGIS-W08",
  "AEGIS-A03",
];

const api = { screenPreview, fields, cases, NOT_IMPLEMENTED_V1 };

if (typeof window !== "undefined") window.AEGIS = api;
module.exports = api;
