"use strict";
// The AEGIS rule set — docs/POLICY.md §3-§5 implemented as pure
// evaluators over an evidence object assembled by screen.js.
// Every evaluator returns { status, reason } with status one of
// TRIGGERED / CLEAR / NOT_IMPLEMENTED. A rule that cannot be checked
// with the data sources available to v1 says NOT_IMPLEMENTED and why —
// it is never silently treated as passed.

const ZERO = "0x0000000000000000000000000000000000000000";
const UNLIMITED_APPROVAL = 1n << 255n; // POLICY §2
const FEE_WARN_BPS = 1000; // 10%
const FEE_BLOCK_BPS = 5000; // 50%
const FRESH_AGE_S = 3600; // 1h

const T = (reason) => ({ status: "TRIGGERED", reason });
const C = (reason) => ({ status: "CLEAR", reason });
const NI = (reason) => ({ status: "NOT_IMPLEMENTED", reason });

const MKT_NI =
  "requires holder/LP market-structure data (MKT) from an explorer/indexer; v1 has no such source configured (BscScan API requires a key) — rule not evaluated";

function approvalAmount(ev) {
  // Returns the granted amount as BigInt for approve-family calls,
  // or null when the call grants no approval.
  const d = ev.decoded;
  if (d.kind === "approve") return BigInt(d.args.amount);
  if (d.kind === "increaseAllowance") return BigInt(d.args.addedValue);
  if (d.kind === "setApprovalForAll") return d.args.approved ? (1n << 256n) - 1n : 0n;
  return null;
}

function ownerRetained(owner) {
  return !!owner && owner !== ZERO && owner !== "none";
}

function sellProbeApplicable(ev) {
  return ev.contexts.buy || (ev.token && ev.token.walletBalance > 0n);
}

const RULES = [
  {
    id: "AEGIS-B01",
    name: "Unlimited approval to untrusted spender",
    evaluate(ev) {
      const amount = approvalAmount(ev);
      if (amount === null) return C("not an approval-granting call");
      if (amount < UNLIMITED_APPROVAL) return C("approval is below the unlimited threshold (limited case is W01)");
      const sp = ev.spender;
      if (!sp) return NI("spender evidence unavailable");
      if (sp.verification !== "verified") {
        return T(
          `unlimited approval (>= 2^255) to spender ${sp.address} whose source is ` +
            (sp.verification === "unknown"
              ? "unverifiable — Sourcify unreachable, treated as unverified (fail-closed)"
              : "not verified on Sourcify")
        );
      }
      if (!sp.census || !sp.census.available)
        return NI("spender is verified but its source census is unavailable, so retained privileged functions cannot be excluded");
      if (sp.census.privileged.length)
        return T(`unlimited approval to verified spender ${sp.address} that retains privileged functions: ${sp.census.privileged.join(", ")}`);
      return C("spender is source-verified and its census shows no retained privileged functions");
    },
  },
  {
    id: "AEGIS-B02",
    name: "Unverified target with native value",
    evaluate(ev) {
      if (!ev.target.isContract) return C("target is not a contract");
      if (BigInt(ev.preview.value || "0") === 0n) return C("call carries no native value");
      if (ev.target.verification === "verified") return C("target source is verified");
      return T(
        `target contract ${ev.target.address} is ` +
          (ev.target.verification === "unknown"
            ? "unverifiable — Sourcify unreachable, treated as unverified (fail-closed)"
            : "not source-verified") +
          ` and the call carries ${ev.preview.value} wei`
      );
    },
  },
  {
    id: "AEGIS-B03",
    name: "Value-out mismatch (claims vs effects)",
    evaluate(ev) {
      if (!ev.claim) return NI("no preview claim supplied — there is nothing to compare the simulated effects against");
      if (ev.simulation.status !== "success")
        return NI("simulation did not succeed, so effects are unavailable (the failure itself is B04)");
      const claimedNative = ev.claim.nativeOut !== undefined ? BigInt(ev.claim.nativeOut) : 0n;
      const claimedTokens = new Map();
      for (const t of ev.claim.tokensOut || []) claimedTokens.set(t.token.toLowerCase(), BigInt(t.amount));
      const simNativeOut = ev.effects.nativeDelta < 0n ? -ev.effects.nativeDelta : 0n;
      const mismatches = [];
      if (simNativeOut !== claimedNative)
        mismatches.push(`native outflow: claimed ${claimedNative} wei, simulated ${simNativeOut} wei`);
      const tokens = new Set([...claimedTokens.keys(), ...ev.effects.tokenDeltas.keys()]);
      for (const token of tokens) {
        const delta = ev.effects.tokenDeltas.get(token) || 0n;
        const simOut = delta < 0n ? -delta : 0n;
        const claimed = claimedTokens.get(token) || 0n;
        if (simOut !== claimed) mismatches.push(`token ${token} outflow: claimed ${claimed}, simulated ${simOut}`);
      }
      const partial = ev.simulation.effectsPartial ? " (partial effects: eth_call fallback, decode-based)" : "";
      if (mismatches.length) return T("value-out mismatch — " + mismatches.join("; ") + partial);
      return C("simulated outflows match the preview claim exactly" + partial);
    },
  },
  {
    id: "AEGIS-B04",
    name: "Simulation revert (fail closed)",
    evaluate(ev) {
      if (ev.simulation.status === "success") return C("the pending call succeeds under simulation from the agent wallet");
      if (ev.simulation.status === "revert")
        return T(
          `the pending call reverts under simulation from the agent wallet (${String(ev.simulation.error || "execution reverted").slice(0, 220)})`
        );
      return T(`simulation could not be completed (${ev.simulation.error || "unknown error"}) — fail closed`);
    },
  },
  {
    id: "AEGIS-B05",
    name: "Honeypot — sell path blocked",
    evaluate(ev) {
      if (!ev.token) {
        return ev.contexts.buy
          ? NI("subject token could not be identified from the call, so the sell path cannot be probed")
          : C("no subject token (not a buy context)");
      }
      if (!sellProbeApplicable(ev)) return C("not a buy context and the wallet holds none of the subject token");
      if (!ev.token.pair) return NI("no PancakeSwap V2 pair resolvable for the token — the sell path cannot be probed in v1");
      if (ev.token.walletBalance <= 0n)
        return NI("wallet holds no balance of the token yet (pre-acquisition), so a sell cannot be probed in v1");
      const probe = ev.probes.sell;
      if (!probe || !probe.ran) return NI(`sell-path probe did not run (${(probe && probe.reason) || "no reason recorded"})`);
      if (!probe.transferOk)
        return T(`sell-path probe failed: simulated transfer of the token to its pair reverted (${probe.error || "revert"}) — the sell path is blocked`);
      if (BigInt(probe.received) <= 0n)
        return T("sell-path probe: the pair received 0 tokens from a successful transfer — the sell path is effectively blocked (100% transfer tax)");
      return C(`sell-path probe passed: pair received ${probe.received} of ${probe.amount} probed tokens`);
    },
  },
  {
    id: "AEGIS-B06",
    name: "Hidden mint is live",
    evaluate(ev) {
      if (!ev.contexts.buy) return C("not a buy context");
      if (!ev.token) return NI("subject token could not be identified");
      const c = ev.token.census;
      if (!c || !c.available) return NI("token source census unavailable (unverified or source fetch failed)");
      if (!c.mint) return C("no externally callable mint / supply-increasing path in the token census");
      const capGetter = ev.token.capGetter;
      if (capGetter && capGetter.present)
        return C(`a supply-cap getter exists on-chain (${capGetter.name} = ${capGetter.value}) — the no-cap condition of this rule is not met`);
      if (c.sourceCapMention)
        return C("token source references a supply cap (MAX_SUPPLY/maxSupply-style) — the no-cap condition is not met");
      const gate =
        ev.token.owner && ev.token.owner !== ZERO && ev.token.owner !== "none"
          ? `mint authority retained (owner ${ev.token.owner})`
          : ev.token.mintProbe === "callable"
            ? "mint path proven callable by an arbitrary wallet (a probe mint succeeded in simulation)"
            : ev.token.mintProbe === "reverts"
              ? "mint path is gated in effect (a probe mint from an arbitrary wallet reverts) — a retained authority/phase controls it, and no cap bounds it"
              : c.mintGated === false
                ? "mint path appears ungated in source"
                : c.mintGated === true
                  ? "mint path is gated to a retained authority (modifier/sender check in source)"
                  : null;
      if (!gate) return NI("a mint path exists with no cap found, but the mint authority could not be determined");
      return T(
        `token has a live mint path (${c.mintNames.join(", ")}) with no enforced supply cap found, and ${gate}. ` +
          "Capability finding (POLICY §8): the census cannot prove the path is phase-disabled at this block."
      );
    },
  },
  {
    id: "AEGIS-B07",
    name: "Sell fee is confiscatory",
    evaluate(ev) {
      if (!ev.token || !sellProbeApplicable(ev)) return C("not applicable (no subject token / probe context)");
      const probe = ev.probes.sell;
      if (!probe || !probe.ran) return NI(`fee probe did not run (${(probe && probe.reason) || "no pair / no balance / simulate unavailable"})`);
      if (!probe.transferOk) return NI("sell path is blocked, so the fee cannot be measured (see B05)");
      if (probe.feeBps === null) return NI("fee could not be measured from the probe result");
      if (probe.feeBps > FEE_BLOCK_BPS)
        return T(`effective sell fee ${(probe.feeBps / 100).toFixed(2)}% > 50% (FEE_BLOCK), measured by the transfer-to-pair probe`);
      return C(`measured sell-leg fee ${(probe.feeBps / 100).toFixed(2)}% <= 50% (FEE_BLOCK)`);
    },
  },
  {
    id: "AEGIS-B08",
    name: "Deployer has rug history",
    evaluate() {
      return NI(
        "deployer rug-history requires explorer labels or an operator denylist (META); no label source is configured in v1 (explorer APIs require a key) — rule not evaluated"
      );
    },
  },
  {
    id: "AEGIS-B09",
    name: "Fake renounce / hidden ownership",
    evaluate(ev) {
      if (!ev.token && !ev.target.isContract) return C("target is not a contract — no ownership surface to fake a renounce against");
      const subj = ev.token
        ? { label: "token", census: ev.token.census, owner: ev.token.owner }
        : { label: "target", census: ev.target.census, owner: ev.target.owner };
      if (subj.owner === null || subj.owner === undefined)
        return NI(`${subj.label} owner() probe failed — renounce state cannot be determined`);
      if (subj.owner === "none") return C(`${subj.label} exposes no owner() — fake-renounce pattern not applicable`);
      if (subj.owner !== ZERO)
        return C(`${subj.label} ownership is openly retained (owner ${subj.owner}) — not a fake renounce; retained authority is covered by the capability rules`);
      if (!subj.census || !subj.census.available)
        return NI("owner() reads zero but the source census is unavailable — hidden admin paths cannot be excluded");
      const hidden = [];
      if (subj.census.renounceOverride) hidden.push("renounceOwnership is overridden in project source");
      if (subj.census.secondAdmin) hidden.push("a second/shadow admin path exists in source");
      if (subj.census.defaultAdminRole) hidden.push("DEFAULT_ADMIN_ROLE present in source");
      if (hidden.length) return T(`owner() reads zero (appears renounced) but the census finds hidden authority: ${hidden.join("; ")}`);
      return C("owner is renounced and the census finds no override, second admin, or admin role");
    },
  },
  {
    id: "AEGIS-B10",
    name: "Fresh contract, high value",
    evaluate(ev) {
      if (!ev.target.isContract) return C("target is not a contract");
      if (ev.target.ageSeconds === null || ev.target.ageSeconds === undefined) {
        // Only a lower bound on age is provable when the creation block
        // predates the RPC endpoints' state-retention window.
        if (
          ev.target.ageLowerBoundSeconds !== null &&
          ev.target.ageLowerBoundSeconds !== undefined &&
          ev.target.ageLowerBoundSeconds >= FRESH_AGE_S
        ) {
          const boundMin = Math.round(ev.target.ageLowerBoundSeconds / 60);
          const boundHuman = boundMin >= 120 ? `${(boundMin / 60).toFixed(1)} h` : `${boundMin} min`;
          return C(
            `contract already existed at the oldest readable chain state ${boundHuman} ago (public RPCs prune older state) — provably not fresh`
          );
        }
        return NI("contract creation block could not be determined within the RPC state-retention window, so its age is unknown");
      }
      if (ev.target.ageSeconds >= FRESH_AGE_S)
        return C(`contract age ${Math.round(ev.target.ageSeconds / 60)} min >= FRESH_AGE (1 h)`);
      const value = BigInt(ev.preview.value || "0");
      if (value < ev.highValueWei)
        return C(`contract is fresh (< 1 h) but value ${value} wei is below HIGH_VALUE (${ev.highValueWei} wei)`);
      return T(
        `contract deployed ${ev.target.ageSeconds}s ago (< FRESH_AGE 1 h) and the call carries ${value} wei >= HIGH_VALUE (${ev.highValueWei} wei = min(0.1 BNB, 25% of wallet balance))`
      );
    },
  },
  {
    id: "AEGIS-B11",
    name: "LP held by deployer",
    evaluate() {
      return NI(MKT_NI);
    },
  },
  {
    id: "AEGIS-B12",
    name: "Holder concentration, extreme",
    evaluate() {
      return NI(MKT_NI);
    },
  },
  {
    id: "AEGIS-B13",
    name: "Permit replay / permit mismatch",
    evaluate(ev) {
      if (ev.decoded.kind !== "permit") {
        if (ev.permitNested)
          return NI("a permit selector appears nested inside this call's arguments (e.g. multicall); v1 evaluates only top-level permit calls");
        return C("call is not a permit");
      }
      const p = ev.permit;
      if (!p) return NI("permit arguments could not be assembled for evaluation");
      const issues = [];
      if (p.deadline !== null && p.deadline < BigInt(ev.blockTimestamp))
        issues.push(`deadline ${p.deadline} is in the past (block timestamp ${ev.blockTimestamp})`);
      if (p.explicitNonce !== null && p.nonceOnChain !== null && p.explicitNonce !== p.nonceOnChain)
        issues.push(`permit nonce ${p.explicitNonce} != on-chain nonces(owner) ${p.nonceOnChain}`);
      if (ev.claim && ev.claim.permit) {
        if (ev.claim.permit.spender && ev.claim.permit.spender.toLowerCase() !== p.spender.toLowerCase())
          issues.push(`permit spender ${p.spender} differs from the preview claim (${ev.claim.permit.spender})`);
        if (ev.claim.permit.value !== undefined && BigInt(ev.claim.permit.value) !== p.value)
          issues.push(`permit value ${p.value} differs from the preview claim (${ev.claim.permit.value})`);
      }
      if (issues.length) return T("permit mismatch — " + issues.join("; "));
      if (p.explicitNonce === null)
        return C(
          "deadline and claim checks pass. Disclosure: an ERC-2612 permit's nonce is implicit in its signature, so replay of a still-unused permit cannot be excluded off-chain in v1; once consumed, a replay reverts and is caught by B04"
        );
      return C("permit nonce matches on-chain nonces(owner), deadline is valid, and no claim mismatch");
    },
  },
  {
    id: "AEGIS-B14",
    name: "Proxy with uninitialized implementation",
    evaluate(ev) {
      if (!ev.target.proxy || !ev.target.proxy.isProxy) return C("target is not an EIP-1967 proxy");
      const probe = ev.target.implInitializeProbe;
      if (probe === "success")
        return T(
          `proxy implementation ${ev.target.proxy.implementation} is uninitialized: an initialize() probe from an arbitrary wallet succeeded in simulation — anyone can initialize it`
        );
      if (probe === "revert") return C("initialize() probe on the implementation reverted (already initialized, guarded, or no no-arg initialize)");
      return NI("implementation exposes initialize only with arguments (or the probe was unavailable); v1 probes only the no-arg initialize()");
    },
  },
  {
    id: "AEGIS-W01",
    name: "Limited approval to authority-retained spender",
    evaluate(ev) {
      const amount = approvalAmount(ev);
      if (amount === null) return C("not an approval-granting call");
      if (amount >= UNLIMITED_APPROVAL) return C("unlimited approval — covered by B01");
      if (amount === 0n) return C("approval grants nothing (zero amount or revocation)");
      const sp = ev.spender;
      if (!sp) return NI("spender evidence unavailable");
      if (!sp.census || !sp.census.available)
        return NI("spender source census unavailable, so retained privileged functions cannot be excluded");
      if (sp.census.privileged.length)
        return T(`limited approval to spender ${sp.address} that retains privileged functions: ${sp.census.privileged.join(", ")} — the retained authority IS the rug vector`);
      return C("spender census shows no retained privileged functions");
    },
  },
  {
    id: "AEGIS-W02",
    name: "Unbounded fee setter",
    evaluate(ev) {
      if (!ev.contexts.buy) return C("not a buy context");
      if (!ev.token) return NI("subject token could not be identified");
      const c = ev.token.census;
      if (!c || !c.available) return NI("token source census unavailable");
      if (!c.feeSetters.length) return C("no fee/tax setter in the token census");
      if (c.feeCapEvidence)
        return C(`fee setter(s) present (${c.feeSetters.join(", ")}) but an on-chain cap at <= 10% was found in source`);
      if (!ownerRetained(ev.token.owner))
        return C(`fee setter(s) present (${c.feeSetters.join(", ")}) but ownership is not retained (owner: ${ev.token.owner})`);
      return T(`unbounded fee setter(s) ${c.feeSetters.join(", ")} callable by retained owner ${ev.token.owner} with no on-chain cap <= 10% found in source`);
    },
  },
  {
    id: "AEGIS-W03",
    name: "Elevated transfer fee",
    evaluate(ev) {
      if (!ev.token || !sellProbeApplicable(ev)) return C("not applicable (no subject token / probe context)");
      const probe = ev.probes.sell;
      if (!probe || !probe.ran) return NI(`fee probe did not run (${(probe && probe.reason) || "no pair / no balance / simulate unavailable"})`);
      if (!probe.transferOk) return NI("sell path is blocked, so the fee cannot be measured (see B05)");
      if (probe.feeBps === null) return NI("fee could not be measured from the probe result");
      if (probe.feeBps > FEE_WARN_BPS)
        return T(`effective sell fee ${(probe.feeBps / 100).toFixed(2)}% > 10% (FEE_WARN), measured by the transfer-to-pair probe (sell leg)`);
      return C(`measured sell-leg fee ${(probe.feeBps / 100).toFixed(2)}% <= 10% (FEE_WARN)`);
    },
  },
  {
    id: "AEGIS-W04",
    name: "Transfer-restriction capability",
    evaluate(ev) {
      if (!ev.contexts.buy) return C("not a buy context");
      if (!ev.token) return NI("subject token could not be identified");
      const c = ev.token.census;
      if (!c || !c.available) return NI("token source census unavailable");
      if (!c.transferRestrictions.length) return C("no blacklist / max-tx / max-wallet / trading-gate controls in the token census");
      if (!ownerRetained(ev.token.owner))
        return C(`transfer-restriction controls exist (${c.transferRestrictions.join(", ")}) but ownership is not retained (owner: ${ev.token.owner})`);
      return T(
        `token carries transfer-restriction controls (${c.transferRestrictions.join(", ")}) with retained owner ${ev.token.owner} — capability present even if not currently exercised`
      );
    },
  },
  {
    id: "AEGIS-W05",
    name: "Upgradeable proxy, retained admin",
    evaluate(ev) {
      if (!ev.target.proxy || !ev.target.proxy.isProxy) return C("target is not behind an EIP-1967 proxy");
      const admin = ev.target.proxy.admin;
      if (admin === null || admin === undefined) return NI("proxy admin slot read failed");
      if (admin === ZERO) return C("proxy admin slot is zero — no retained upgrade admin");
      return T(
        `target is an upgradeable proxy (implementation ${ev.target.proxy.implementation}) with retained admin ${admin}, which is not on the operator's known-good timelock/multisig list (empty in v1) — the logic can be replaced after this check`
      );
    },
  },
  {
    id: "AEGIS-W06",
    name: "LP not locked or burned",
    evaluate() {
      return NI(MKT_NI);
    },
  },
  {
    id: "AEGIS-W07",
    name: "Holder concentration",
    evaluate() {
      return NI(MKT_NI);
    },
  },
  {
    id: "AEGIS-W08",
    name: "Thin liquidity",
    evaluate() {
      return NI(MKT_NI);
    },
  },
  {
    id: "AEGIS-W09",
    name: "LP-drain functions present",
    evaluate(ev) {
      const subjects = [{ label: "target", census: ev.target.census, owner: ev.target.owner }];
      if (ev.token && ev.token.address.toLowerCase() !== ev.target.address.toLowerCase())
        subjects.push({ label: "token", census: ev.token.census, owner: ev.token.owner });
      let anyAvailable = false;
      for (const s of subjects) {
        if (!s.census || !s.census.available) continue;
        anyAvailable = true;
        if (s.census.lpFunctions.length && ownerRetained(s.owner))
          return T(`LP-drain functions on the ${s.label} (${s.census.lpFunctions.join(", ")}) callable by retained owner ${s.owner}`);
      }
      if (!anyAvailable) {
        if (!ev.target.isContract && !ev.token) return C("target is not a contract — no LP-drain function surface");
        return NI("no source census available for target/token — LP-drain functions cannot be excluded");
      }
      return C("no LP-drain functions (migrateLP / emergencyWithdraw / setPair / setRouter) with a retained owner in the census");
    },
  },
  {
    id: "AEGIS-W10",
    name: "Oracle read without staleness/confidence check",
    evaluate(ev) {
      if (!ev.target.isContract) return C("target is not a contract — no oracle-read surface");
      const c = ev.target.census;
      if (!c || !c.available) return NI("target source census unavailable");
      const o = c.oracle;
      if (o.latestRoundDataNoStaleness || o.pythUnsafe)
        return T(
          `unchecked oracle read in target source: ${o.evidence.join("; ")}. Value-flow dependence is inferred from the target consuming oracle prices in its own logic`
        );
      return C("no unchecked oracle-read pattern (latestRoundData without updatedAt, Pyth getPriceUnsafe) in target source");
    },
  },
  {
    id: "AEGIS-W11",
    name: "Sandwich amplification by design",
    evaluate(ev) {
      const subj = ev.token || ev.target;
      if (!ev.token && !ev.target.isContract) return C("target is not a contract — no swapback surface");
      const c = subj.census;
      if (!c || !c.available) return NI("source census unavailable for the token/target");
      if (c.zeroSlippageSwapback)
        return T(`the token's own swapback path calls a swap with amountOutMin = 0 (zero slippage): ${c.swapbackEvidence}`);
      return C("no zero-slippage swapback pattern in source");
    },
  },
  {
    id: "AEGIS-W12",
    name: "Bonding-curve admin controls",
    evaluate(ev) {
      if (!ev.contexts.buy) return C("not a buy context");
      const c = ev.target.census;
      if (!c || !c.available) return NI("target source census unavailable");
      if (c.bondingCurveAdmin.length && ownerRetained(ev.target.owner))
        return T(`bonding-curve admin controls (${c.bondingCurveAdmin.join(", ")}) with retained admin/owner ${ev.target.owner}`);
      return C("no bonding-curve admin setters with a retained admin in the target census");
    },
  },
  {
    id: "AEGIS-W13",
    name: "ERC4626 first-depositor window",
    evaluate(ev) {
      if (ev.target.isERC4626 === null || ev.target.isERC4626 === undefined)
        return NI("ERC4626 surface probes (totalAssets/asset) could not be completed");
      if (!ev.target.isERC4626) return C("target does not expose the ERC4626 totalAssets()/asset() surface");
      if (ev.target.vaultEmpty)
        return T("ERC4626 vault with totalSupply ~= 0 or totalAssets ~= 0 while deposits are open — first-depositor / share-inflation window");
      return C(
        "ERC4626 vault with non-trivial supply and assets. Disclosure: the share-transfer stake-record clause of this rule is not evaluated in v1"
      );
    },
  },
  {
    id: "AEGIS-A01",
    name: "Right-sized approval to clean spender",
    evaluate(ev) {
      const amount = approvalAmount(ev);
      if (amount === null) return C("not an approval-granting call");
      const sp = ev.spender;
      if (!sp) return NI("spender evidence unavailable");
      if (!sp.census || !sp.census.available) return NI("spender source census unavailable");
      const intended = ev.claim && ev.claim.intendedSpend !== undefined ? BigInt(ev.claim.intendedSpend) : null;
      if (
        intended !== null &&
        sp.verification === "verified" &&
        !sp.census.privileged.length &&
        amount <= (intended * 11n) / 10n
      )
        return T(
          `positive evidence: approval ${amount} <= 1.1x the intended spend ${intended}, to source-verified spender ${sp.address} with a clean census`
        );
      return C("right-sized-approval conditions not established (needs an intended-spend claim, a verified spender, and a clean census)");
    },
  },
  {
    id: "AEGIS-A02",
    name: "Authorities verifiably gone",
    evaluate(ev) {
      if (!ev.contexts.buy) return C("not a buy context");
      if (!ev.token) return NI("subject token could not be identified");
      const c = ev.token.census;
      if (!c || !c.available) return NI("token source census unavailable");
      if (ev.token.owner === null || ev.token.owner === undefined)
        return NI("token owner() probe failed — authority clearance cannot be established");
      const mintCleared = !c.mint || (ev.token.capGetter && ev.token.capGetter.present) || c.sourceCapMention;
      const ownerCleared =
        ev.token.owner === ZERO && !c.renounceOverride && !c.secondAdmin && !c.defaultAdminRole;
      const noBlacklist = !c.blacklist;
      const noFeeSetters = !c.feeSetters.length;
      if (mintCleared && ownerCleared && noBlacklist && noFeeSetters)
        return T(
          "positive evidence: mint path capped or absent, ownership renounced with no override/second admin/role, and no blacklist or fee setters in the census"
        );
      return C(
        `authority clearance incomplete (mint cleared: ${mintCleared}, owner renounced & clean: ${ownerCleared}, no blacklist: ${noBlacklist}, no fee setters: ${noFeeSetters})`
      );
    },
  },
  {
    id: "AEGIS-A03",
    name: "LP burned or long-locked",
    evaluate() {
      return NI(MKT_NI);
    },
  },
];

module.exports = { RULES, UNLIMITED_APPROVAL, ZERO };
