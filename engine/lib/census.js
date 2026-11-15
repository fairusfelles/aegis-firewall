"use strict";
// Privileged-function census (POLICY §0 habit 1: "all authorities, all
// sibling functions"). Built from the contract's verified ABI (its true
// externally-callable surface) plus pattern scans over the *project*
// sources (library/interface files are excluded — inherited library
// internals are not the target's own retained powers).
//
// The census is deliberately pattern-based and reports exactly what it
// matched; POLICY §8 documents the limits of pattern matching.

// Files that are not the project's own logic.
function isProjectSource(path) {
  const p = path.toLowerCase();
  if (p.includes("openzeppelin")) return false;
  if (p.includes("chainlink")) return false;
  if (p.includes("/lib/") || p.startsWith("lib/")) return false;
  if (p.includes("node_modules")) return false;
  if (p.includes("/interfaces/") || p.includes("interface/")) return false;
  return true;
}

function projectSourceText(sources) {
  return Object.entries(sources || {})
    .filter(([path]) => isProjectSource(path))
    .map(([, content]) => content)
    .join("\n");
}

const NAME_PATTERNS = {
  mint: /^mint/i,
  blacklist: /blacklist|blocklist/i,
  pause: /^pause$|^unpause$/i,
  feeSetter: /^set\w*(fee|tax)/i,
  lpFunction: /migrateLP|migrateLiquidity|emergencyWithdraw|^setPair|^setRouter|withdrawLP/i,
  transferRestriction:
    /blacklist|blocklist|maxTx|maxWallet|tradingEnabled|tradingOpen|limitsInEffect|setMaxTx|setMaxWallet/i,
  bondingCurveAdmin: /^setCurve|^setVirtual|virtualReserve/i,
  capGetter: /^(cap|MAX_SUPPLY|maxSupply|MAX_TOKENS|TOTAL_MAX)$/i,
};

function census(abi, sources) {
  const fnNames = (abi || [])
    .filter((x) => x.type === "function")
    .map((x) => x.name)
    .filter(Boolean);
  const src = projectSourceText(sources);
  const hasSrc = src.length > 0;

  const matchNames = (re) => fnNames.filter((n) => re.test(n));

  const mintNames = matchNames(NAME_PATTERNS.mint);
  const feeSetters = matchNames(NAME_PATTERNS.feeSetter);
  const lpFunctions = matchNames(NAME_PATTERNS.lpFunction);
  const transferRestrictions = matchNames(NAME_PATTERNS.transferRestriction);
  const bondingCurveAdmin = matchNames(NAME_PATTERNS.bondingCurveAdmin);
  const capGetters = matchNames(NAME_PATTERNS.capGetter);

  // Fee-cap evidence in project source: a MAX_FEE-style constant or a
  // require() bounding a fee/tax value at <= 10 (percent) or <= 1000 (bps).
  let feeCapEvidence = false;
  if (hasSrc) {
    const constRe = /(MAX_FEE|MAX_TAX|FEE_CAP|MAX_SELL_FEE|MAX_BUY_FEE)\s*=\s*(\d+)/g;
    const reqRe = /require\s*\([^;)]*(fee|tax)[^;)]*<=\s*(\d+)/gi;
    for (const re of [constRe, reqRe]) {
      let m;
      while ((m = re.exec(src)) !== null) {
        const v = Number(m[2]);
        if (v <= 10 || (v >= 100 && v <= 1000)) feeCapEvidence = true;
      }
    }
  }

  // Is the mint path gated in source? (modifier or sender check on the
  // mint function definition). Gating does not remove the capability —
  // the gatekeeper is the retained authority — but it is reported.
  let mintGated = null;
  if (hasSrc && mintNames.length) {
    const defRe = new RegExp(`function\\s+${mintNames[0]}\\b[^{]*\\{`, "s");
    const def = src.match(defRe);
    if (def) mintGated = /only\w+|require\s*\(\s*msg\.sender/.test(def[0]);
  }

  // Supply-cap check inside mint paths (source-level): a MAX_SUPPLY /
  // maxSupply / cap reference anywhere in project source.
  const sourceCapMention = hasSrc && /(MAX_SUPPLY|maxSupply|_cap\b|supplyCap)/.test(src);

  // Renounce override / hidden second admin (project source only — the
  // stock OpenZeppelin renounceOwnership lives in excluded library code).
  const renounceOverride = hasSrc && /function\s+renounceOwnership/.test(src);
  const secondAdmin =
    (hasSrc && /(backupOwner|shadowOwner|secondOwner|_altOwner)/i.test(src)) ||
    (hasSrc && /selfdestruct\s*\(/.test(src)) ||
    fnNames.some((n) => /(backupOwner|shadowOwner|secondOwner)/i.test(n));
  const defaultAdminRole = hasSrc && /DEFAULT_ADMIN_ROLE/.test(src);

  // Oracle reads: call sites of latestRoundData() without an updatedAt
  // staleness reference in the same corpus; Pyth getPriceUnsafe without
  // a checked getPrice call.
  const oracle = { latestRoundDataNoStaleness: false, pythUnsafe: false, evidence: [] };
  if (hasSrc) {
    if (/\.latestRoundData\s*\(/.test(src) && !/updatedAt/.test(src)) {
      oracle.latestRoundDataNoStaleness = true;
      oracle.evidence.push("latestRoundData() call site with no updatedAt staleness check in project sources");
    }
    if (/getPriceUnsafe\s*\(/.test(src) && !/getPrice\s*\(/.test(src)) {
      oracle.pythUnsafe = true;
      oracle.evidence.push("Pyth getPriceUnsafe() used with no checked getPrice() in project sources");
    }
  }

  // Zero-slippage swapback: the token's own auto-swap calling a
  // swapExact* with a literal 0 amountOutMin argument.
  let zeroSlippageSwapback = false;
  let swapbackEvidence = null;
  if (hasSrc) {
    const m = src.match(/swapExact\w*\s*\([^;]*?,\s*0\s*,/s);
    if (m) {
      zeroSlippageSwapback = true;
      swapbackEvidence = m[0].replace(/\s+/g, " ").slice(0, 140);
    }
  }

  // Privileged capability labels (used by B01/W01/W02/W04/W09).
  const privileged = [];
  if (mintNames.length) privileged.push("mint");
  if (matchNames(NAME_PATTERNS.blacklist).length) privileged.push("blacklist");
  if (matchNames(NAME_PATTERNS.pause).length) privileged.push("pause");
  if (feeSetters.length) privileged.push("fee-setter");
  if (lpFunctions.length) privileged.push("lp-function");

  return {
    available: true,
    functionNames: fnNames,
    mint: mintNames.length > 0,
    mintNames,
    mintGated,
    sourceCapMention,
    capGetters,
    blacklist: matchNames(NAME_PATTERNS.blacklist).length > 0,
    pause: matchNames(NAME_PATTERNS.pause).length > 0,
    feeSetters,
    feeCapEvidence,
    lpFunctions,
    transferRestrictions,
    bondingCurveAdmin,
    renounceOverride,
    secondAdmin,
    defaultAdminRole,
    oracle,
    zeroSlippageSwapback,
    swapbackEvidence,
    privileged,
  };
}

function unavailableCensus() {
  return { available: false };
}

module.exports = { census, unavailableCensus, isProjectSource };
