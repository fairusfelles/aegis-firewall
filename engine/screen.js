"use strict";
// AEGIS screening engine v1 — CLI and pipeline orchestrator.
//
//   node engine/screen.js <preview.json> [--out <report.json>]
//
// Preview: { chainId, from, to, value (wei, decimal string), data (hex),
//            claim? { nativeOut, tokensOut: [{token, amount}],
//                     intendedSpend?, permit?: {spender, value},
//                     purpose? } }
//
// Pipeline (docs/POLICY.md §6): DECODE -> CENSUS -> SIMULATE -> MARKET
// (not implemented in v1 — the MKT rules report NOT_IMPLEMENTED) ->
// EVALUATE -> REPORT + SEAL (canonical fields + Poseidon commitment).
//
// Read-only by construction: the engine holds no keys, signs nothing,
// and only ever reads chain state or simulates calls.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const rpc = require("./lib/rpc");
const sourcify = require("./lib/sourcify");
const { census, unavailableCensus } = require("./lib/census");
const { decodeCall } = require("./lib/decode");
const { simulatePending, extractEffects, probeSellTransfer } = require("./lib/simulate");
const { RULES } = require("./lib/rules");
const fields = require("./lib/fields");

const ZERO = "0x0000000000000000000000000000000000000000";
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const PANCAKE_V2_FACTORY = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const lc = (a) => (a || "").toLowerCase();
const sel = (sig) => ethers.utils.id(sig).slice(0, 10);
const padAddr = (a) => lc(a).slice(2).padStart(64, "0");

async function probeOwner(address) {
  try {
    const r = await rpc.call({ to: address, data: sel("owner()") });
    return "0x" + r.slice(-40).toLowerCase();
  } catch (e) {
    if (e.rpcCode === 3 || e.rpcCode === -32000 || /revert/i.test(e.message)) return "none";
    return null;
  }
}

async function probeAddressGetter(address, signature) {
  const r = await rpc.tryCall({ to: address, data: sel(signature) });
  if (!r || r === "0x") return null;
  const a = "0x" + r.slice(-40).toLowerCase();
  return a === ZERO ? null : a;
}

async function probeUint(address, signature, argsHex = "") {
  const r = await rpc.tryCall({ to: address, data: sel(signature) + argsHex });
  if (!r || r === "0x") return null;
  return BigInt(r);
}

async function resolvePair(tokenAddress, tokenAbi) {
  const abiNames = (tokenAbi || []).filter((x) => x.type === "function").map((x) => x.name);
  if (abiNames.includes("pair")) {
    const p = await probeAddressGetter(tokenAddress, "pair()");
    if (p) return p;
  }
  const data = sel("getPair(address,address)") + padAddr(tokenAddress) + padAddr(WBNB);
  const r = await rpc.tryCall({ to: PANCAKE_V2_FACTORY, data });
  if (!r || r === "0x") return null;
  const p = "0x" + r.slice(-40).toLowerCase();
  return p === ZERO ? null : p;
}

async function contractEvidence(chainId, address, { full }) {
  const ev = { address, verification: "unknown", name: null, abi: [], census: unavailableCensus() };
  if (!full) {
    ev.verification = await sourcify.verificationStatus(chainId, address);
    return ev;
  }
  const c = await sourcify.fetchContract(chainId, address);
  ev.verification = c.status;
  if (c.status === "verified") {
    ev.name = c.name;
    ev.abi = c.abi;
    ev.census = census(c.abi, c.sources);
  }
  return ev;
}

async function screenPreview(preview) {
  if (!preview || typeof preview !== "object") throw new Error("preview must be a JSON object");
  const chainId = Number(preview.chainId || 56);
  if (chainId !== 56)
    throw new Error(`engine v1 supports chainId 56 (BSC) only; preview has chainId ${preview.chainId}`);
  if (!ethers.utils.isAddress(preview.from || "")) throw new Error("preview.from is not an address");
  if (!ethers.utils.isAddress(preview.to || "")) throw new Error("preview.to is not an address");
  const from = lc(preview.from);
  const to = lc(preview.to);
  const value = BigInt(preview.value || "0");
  const data = preview.data || "0x";
  const claim = preview.claim || null;
  const warnings = [];

  // --- chain state anchor -------------------------------------------------
  const blockNumber = await rpc.getBlockNumber();
  const block = await rpc.getBlock(blockNumber);
  const blockTimestamp = block ? block.timestamp : Math.floor(Date.now() / 1000);
  const walletNativeBalance = await rpc.getBalance(from).catch(() => null);
  const highValueWei =
    walletNativeBalance === null
      ? 100000000000000000n
      : (() => {
          const quarter = walletNativeBalance / 4n;
          return quarter < 100000000000000000n ? quarter : 100000000000000000n;
        })();

  // --- target evidence ----------------------------------------------------
  const targetCode = await rpc.getCode(to).catch(() => "0x");
  const isContract = !!(targetCode && targetCode !== "0x");
  const targetSrc = isContract
    ? await contractEvidence(chainId, to, { full: true })
    : { verification: "unverified", abi: [], census: unavailableCensus(), name: null };
  if (isContract && targetSrc.verification === "unknown")
    warnings.push("Sourcify unreachable for the target — verification treated as unverified (fail-closed)");

  const decoded = decodeCall(data, value, targetSrc.abi);

  const target = {
    address: to,
    isContract,
    verification: isContract ? targetSrc.verification : "unverified",
    name: targetSrc.name,
    census: targetSrc.census,
    owner: null,
    proxy: { isProxy: false, implementation: null, admin: null },
    implInitializeProbe: null,
    ageSeconds: null,
    ageLowerBoundSeconds: null,
    isERC4626: false,
    vaultEmpty: null,
  };
  if (isContract) {
    target.owner = await probeOwner(to);
    // EIP-1967 proxy slots
    try {
      const implRaw = await rpc.getStorageAt(to, IMPL_SLOT);
      const impl = "0x" + implRaw.slice(-40).toLowerCase();
      if (impl !== ZERO) {
        target.proxy.isProxy = true;
        target.proxy.implementation = impl;
        const adminRaw = await rpc.getStorageAt(to, ADMIN_SLOT);
        target.proxy.admin = "0x" + adminRaw.slice(-40).toLowerCase();
        // B14 probe: no-arg initialize() on the implementation.
        const implSrc = await contractEvidence(chainId, impl, { full: true });
        const initFns = (implSrc.abi || []).filter((x) => x.type === "function" && x.name === "initialize");
        if (initFns.length && initFns.every((f) => (f.inputs || []).length > 0)) {
          target.implInitializeProbe = null; // args-only -> NOT_IMPLEMENTED
        } else {
          const r = await rpc.tryCall({ from, to: impl, data: sel("initialize()") });
          target.implInitializeProbe = r !== null ? "success" : "revert";
        }
      }
    } catch {
      warnings.push("proxy slot reads failed");
    }
    // ERC4626 surface probes (W13)
    const totalAssets = await probeUint(to, "totalAssets()");
    const asset = await probeAddressGetter(to, "asset()");
    if (totalAssets !== null && asset !== null) {
      target.isERC4626 = true;
      const totalSupply = await probeUint(to, "totalSupply()");
      target.vaultEmpty = (totalSupply === 0n) || totalAssets === 0n;
    }
    // Age via creation-block search (B10). Public endpoints prune
    // state, so for older contracts only a lower bound on age is
    // provable — which is all the freshness rule needs.
    try {
      const found = await rpc.findCreationBlock(to, blockNumber);
      if (found.creationBlock !== null) {
        const cb = await rpc.getBlock(found.creationBlock);
        if (cb) target.ageSeconds = Math.max(0, blockTimestamp - cb.timestamp);
      } else if (found.existedByBlock !== null) {
        const eb = await rpc.getBlock(found.existedByBlock);
        if (eb) target.ageLowerBoundSeconds = Math.max(0, blockTimestamp - eb.timestamp);
      }
    } catch {
      warnings.push("creation-block lookup failed — contract age unknown");
    }
  }

  // --- contexts -------------------------------------------------------------
  const approvalContext = ["approve", "increaseAllowance", "permit", "setApprovalForAll"].includes(decoded.kind);
  let buyContext = false;
  if (decoded.kind === "swap" && decoded.swap && decoded.swap.recipient && lc(decoded.swap.recipient) === from)
    buyContext = true;
  const claimLike = decoded.kind === "generic" && !!decoded.name && /claim|mint|buy|purchase|collect/i.test(decoded.name);
  if (claimLike) buyContext = true;

  // --- spender evidence (approval context) --------------------------------
  let spender = null;
  if (approvalContext) {
    const spenderAddr =
      decoded.kind === "setApprovalForAll" ? decoded.args.operator : decoded.args.spender;
    if (spenderAddr && ethers.utils.isAddress(spenderAddr)) {
      const sp = await contractEvidence(chainId, lc(spenderAddr), { full: true });
      spender = { address: lc(spenderAddr), verification: sp.verification, census: sp.census };
    }
  }

  // --- subject token --------------------------------------------------------
  let token = null;
  const buildToken = async (address) => {
    const src = await contractEvidence(chainId, address, { full: true });
    const t = {
      address,
      verification: src.verification,
      name: src.name,
      abi: src.abi,
      census: src.census,
      owner: await probeOwner(address),
      capGetter: { present: false, name: null, value: null },
      pair: null,
      walletBalance: 0n,
      decimals: null,
    };
    for (const getter of ["cap()", "MAX_SUPPLY()", "maxSupply()"]) {
      const v = await probeUint(address, getter);
      if (v !== null && v > 0n) {
        t.capGetter = { present: true, name: getter.slice(0, -2), value: v.toString() };
        break;
      }
    }
    t.walletBalance = (await probeUint(address, "balanceOf(address)", padAddr(from))) || 0n;
    const dec = await probeUint(address, "decimals()");
    t.decimals = dec !== null ? Number(dec) : null;
    t.pair = await resolvePair(address, src.abi);
    // Mint-liveness probe (B06): if the census found a mint path, try
    // calling it from the agent wallet with benign arguments. Success
    // proves the path is live and ungated; a revert proves it is gated
    // in effect (authority / phase / payment), which the rule reports
    // precisely instead of guessing from source patterns alone.
    t.mintProbe = null;
    if (src.census && src.census.available && src.census.mint) {
      const entry = (src.abi || []).find((x) => x.type === "function" && src.census.mintNames.includes(x.name));
      if (entry) {
        try {
          const frag = `function ${entry.name}(${(entry.inputs || []).map((i) => i.type).join(",")})`;
          const iface = new ethers.utils.Interface([frag]);
          const args = (entry.inputs || []).map((i) => {
            if (/^u?int/.test(i.type)) return "1";
            if (i.type === "address") return from;
            if (i.type === "bool") return false;
            if (i.type === "bytes32") return ethers.constants.HashZero;
            if (i.type === "bytes") return "0x";
            if (i.type === "string") return "";
            if (i.type.endsWith("[]")) return [];
            throw new Error("unsupported arg type " + i.type);
          });
          const r = await rpc.tryCall({ from, to: address, data: iface.encodeFunctionData(entry.name, args) });
          t.mintProbe = r !== null ? "callable" : "reverts";
        } catch {
          t.mintProbe = null;
        }
      }
    }
    return t;
  };
  if (decoded.kind === "swap" && decoded.swap) {
    token = await buildToken(lc(decoded.swap.tokenOut));
  } else if (["approve", "increaseAllowance", "transfer", "transferFrom", "setApprovalForAll"].includes(decoded.kind)) {
    token = await buildToken(to);
  } else if (claimLike) {
    let tokenAddr = null;
    for (const getter of ["token()", "feg()", "getToken()", "tokenAddress()", "asset()"]) {
      tokenAddr = await probeAddressGetter(to, getter);
      if (tokenAddr) break;
    }
    if (!tokenAddr) {
      // The target may itself be the token (e.g. a launch contract that is
      // its own ERC20). Probe the ERC20 surface.
      const ts = await probeUint(to, "totalSupply()");
      const bal = await probeUint(to, "balanceOf(address)", padAddr(from));
      if (ts !== null && bal !== null) tokenAddr = to;
    }
    if (tokenAddr) token = await buildToken(lc(tokenAddr));
  }

  // --- permit evidence ------------------------------------------------------
  let permit = null;
  let permitNested = false;
  if (decoded.kind === "permit") {
    const a = decoded.args;
    permit = {
      owner: lc(a.owner || a.holder || from),
      spender: lc(a.spender || ZERO),
      value: BigInt(a.value || "0"),
      deadline: a.deadline !== undefined ? BigInt(a.deadline) : a.expiry !== undefined ? BigInt(a.expiry) : null,
      explicitNonce: a.nonce !== undefined ? BigInt(a.nonce) : null,
      nonceOnChain: null,
    };
    const n = await probeUint(to, "nonces(address)", padAddr(permit.owner));
    permit.nonceOnChain = n;
  } else if (data && data.length > 10) {
    const body = data.slice(10).toLowerCase();
    const erc2612 = sel("permit(address,address,uint256,uint256,uint8,bytes32,bytes32)").slice(2);
    const dai = sel("permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)").slice(2);
    permitNested = body.includes(erc2612) || body.includes(dai);
  }

  // --- simulation + effects -------------------------------------------------
  const sim = await simulatePending({ from, to, value: value.toString(), data }, walletNativeBalance);
  let effects;
  if (sim.method === "eth_simulateV1" && sim.status === "success") {
    effects = extractEffects(sim.logs, from);
    if (!effects.sawSynthetic && value > 0n) effects.nativeDelta = -value; // plain value leg not traced
  } else if (sim.status === "success") {
    // eth_call fallback: decode-based partial effects.
    effects = { nativeDelta: -value, tokenDeltas: new Map(), allowanceDeltas: [], sawSynthetic: false };
    if (decoded.kind === "transfer") effects.tokenDeltas.set(to, -BigInt(decoded.args.amount));
    if (decoded.kind === "transferFrom" && lc(decoded.args.from) === from)
      effects.tokenDeltas.set(to, -BigInt(decoded.args.amount));
    if (decoded.kind === "approve")
      effects.allowanceDeltas.push({ token: to, spender: lc(decoded.args.spender), amount: String(decoded.args.amount) });
  } else {
    effects = { nativeDelta: 0n, tokenDeltas: new Map(), allowanceDeltas: [], sawSynthetic: false };
  }
  const simulation = { method: sim.method, status: sim.status, error: sim.error, effectsPartial: sim.effectsPartial };

  // --- sell / fee probe -------------------------------------------------------
  let sellProbe = null;
  if (token && token.pair && token.walletBalance > 0n) {
    const unit = 10n ** BigInt(token.decimals === null ? 18 : token.decimals);
    let amount = unit * 10n;
    if (amount > token.walletBalance) amount = token.walletBalance;
    const res = await probeSellTransfer({ from, token: token.address, pair: token.pair, amount });
    sellProbe = { ...res, amount: amount.toString() };
  }
  const probesSummary = {
    sellPath: !sellProbe || !sellProbe.ran ? "not-run" : !sellProbe.transferOk || BigInt(sellProbe.received || "0") <= 0n ? "blocked" : "ok",
    sellFeeBps: sellProbe && sellProbe.ran ? sellProbe.feeBps : null,
  };

  // --- evaluate ---------------------------------------------------------------
  const ev = {
    preview: { ...preview, from, to, value: value.toString(), data },
    claim,
    decoded,
    contexts: { approval: approvalContext, buy: buyContext },
    blockNumber,
    blockTimestamp,
    wallet: { nativeBalance: walletNativeBalance },
    target,
    spender,
    token,
    simulation,
    effects,
    probes: { sell: sellProbe },
    permit,
    permitNested,
    highValueWei,
  };
  const ruleResults = RULES.map((r) => {
    let out;
    try {
      out = r.evaluate(ev);
    } catch (e) {
      out = { status: "NOT_IMPLEMENTED", reason: `evaluator error: ${e.message}` };
    }
    return { id: r.id, name: r.name, status: out.status, reason: out.reason };
  });

  // --- canonical fields + seal -------------------------------------------------
  const bitmap = fields.computeBitmap(ruleResults);
  const verdict = fields.verdictFromBitmap(bitmap);
  const encoding = fields.canonicalEffectsEncoding(
    { nativeDelta: effects.nativeDelta, tokenDeltas: effects.tokenDeltas, allowanceDeltas: effects.allowanceDeltas },
    probesSummary,
    sim.status
  );
  const digest = fields.effectsDigest(encoding);
  const { fields: canonicalFields } = await fields.computeFields({
    chainId,
    from,
    to,
    selector: decoded.selector,
    digest,
    bitmap,
    blockNumber,
  });
  const commitment = await fields.computeCommitment(canonicalFields, verdict);

  const counts = { TRIGGERED: 0, CLEAR: 0, NOT_IMPLEMENTED: 0 };
  for (const r of ruleResults) counts[r.status]++;

  return {
    engine: "aegis-screen",
    engineVersion: "1.0.0",
    ruleSetVersion: fields.REPORT_VERSION,
    screenedAt: new Date().toISOString(),
    blockNumber,
    blockTimestamp,
    preview: { chainId, from, to, value: value.toString(), data, claim },
    decoded: {
      kind: decoded.kind,
      name: decoded.name,
      signature: decoded.signature,
      selectorHex: decoded.selectorHex,
      args: decoded.args,
      swap: decoded.swap || null,
    },
    contexts: { approval: approvalContext, buy: buyContext },
    verdict,
    verdictLabel: ["ALLOW", "WARN", "BLOCK"][verdict],
    rulesBitmap: bitmap.toString(),
    fields: canonicalFields,
    commitment,
    rules: ruleResults,
    ruleCounts: counts,
    effects: {
      nativeDelta: effects.nativeDelta.toString(),
      tokenDeltas: [...effects.tokenDeltas.entries()].map(([t, d]) => ({ token: t, delta: d.toString() })),
      allowanceDeltas: effects.allowanceDeltas,
    },
    probes: { sell: sellProbe },
    target: {
      address: to,
      isContract,
      verification: target.verification,
      name: target.name,
      owner: target.owner,
      proxy: target.proxy,
      ageSeconds: target.ageSeconds,
      ageLowerBoundSeconds: target.ageLowerBoundSeconds,
      isERC4626: target.isERC4626,
    },
    token: token
      ? {
          address: token.address,
          verification: token.verification,
          name: token.name,
          owner: token.owner,
          capGetter: token.capGetter,
          pair: token.pair,
          walletBalance: token.walletBalance.toString(),
          decimals: token.decimals,
          mintProbe: token.mintProbe,
        }
      : null,
    dataSources: {
      rpc: "ok",
      sourcify: target.verification === "unknown" ? "unreachable-or-error" : "ok",
      simulation: sim.method,
      market: "not-implemented-v1",
    },
    warnings,
  };
}

async function main(argv) {
  const args = argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  if (!file) {
    console.error("usage: node engine/screen.js <preview.json> [--out <report.json>]");
    process.exit(2);
  }
  const preview = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  const report = await screenPreview(preview);
  const json = JSON.stringify(report, null, 2);
  if (outPath) fs.writeFileSync(path.resolve(outPath), json + "\n");
  console.log(json);
}

if (require.main === module) {
  main(process.argv).catch((e) => {
    console.error("screening failed:", e.message);
    process.exit(2);
  });
}

module.exports = { screenPreview };
