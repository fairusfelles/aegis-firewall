# AEGIS Screening Engine v1

The screening engine specified by [`../docs/POLICY.md`](../docs/POLICY.md):
it takes one transaction preview — the same JSON a wallet's contract-call
preview produces — and returns a deterministic **ALLOW (0) / WARN (1) /
BLOCK (2)** verdict, the per-rule evidence behind it, and the six
canonical report fields of POLICY §7 sealed with a Poseidon commitment
(the exact inputs of `../circuits/verdict_commit.circom`).

The engine is **read-only by construction**: it holds no keys, signs
nothing, and never submits a transaction. It only reads chain state and
simulates calls.

## Run it

```bash
node engine/screen.js <preview.json> [--out <report.json>]
npm run screen -- <preview.json>          # same, via npm
node engine/run_fixtures.js               # unit fixtures (live BSC)
node engine/run_replays.js                # field-case replays
```

A screen takes ~10–60 s: it downloads verified sources from Sourcify
and probes chain state, including a creation-block search (see
"Contract age" below). RPC endpoints default to public BSC nodes and
can be overridden with `AEGIS_RPC_URLS` (comma-separated) or
`AEGIS_RPC_URL`; the Sourcify base URL with `AEGIS_SOURCIFY_URL`.
Chain scope is **BSC (chainId 56) only** in v1.

### Preview format

```json
{
  "chainId": 56,
  "from": "0x…",            // the agent wallet that would sign
  "to": "0x…",              // target contract / recipient
  "value": "0",             // wei, decimal string
  "data": "0x…",            // calldata
  "claim": {                // optional: what the human/UI said will happen
    "nativeOut": "0",
    "tokensOut": [{ "token": "0x…", "amount": "…" }],
    "intendedSpend": "…",   // optional, feeds A01
    "permit": { "spender": "0x…", "value": "…" },  // optional, feeds B13
    "purpose": "free text, recorded but never trusted"
  }
}
```

The claim is data, never truth (POLICY §6.1): B03 compares it against
simulated effects. When a claim object is present, outflow fields it
omits count as claimed-zero.

## How it works

Pipeline (POLICY §6): **decode → census → simulate → evaluate → seal**.
(Market stage 4 is not implemented in v1 — see the coverage table.)

- **Decode (CD).** The target's verified ABI (Sourcify) first, then a
  generic interface covering ERC20 approvals/transfers, ERC-2612 and
  DAI-style permits, `setApprovalForAll`, WBNB, and the PancakeSwap V2
  router surface.
- **Census (SRC + CHAIN).** For the target — and, in buy/approval
  contexts, the token/spender — the engine fetches the verified source
  from **Sourcify** (free, no key) and enumerates *all* privileged
  functions (mint paths, blacklist, pause, fee setters, LP functions,
  transfer restrictions, renounce overrides, oracle reads,
  zero-slippage swapbacks), plus on-chain probes: `owner()`, cap
  getters (`cap()` / `MAX_SUPPLY()` / `maxSupply()`), EIP-1967
  implementation/admin slots, ERC4626 surface, and a **mint-liveness
  probe** (a simulated mint call with benign arguments — success proves
  an ungated live mint; a revert proves the path is gated in effect).
- **Simulate (SIM).** `eth_simulateV1`, which the public BSC endpoints
  support, executes the pending call in a synthetic block over the
  latest state (the wallet's native balance is topped up *inside the
  simulation only* when it could not cover the call, so underfunded
  previews still simulate). Effects are extracted from the call's logs:
  ERC20 `Transfer` deltas, synthetic native-transfer legs
  (`traceTransfers`), and `Approval` deltas. If no endpoint offers
  `eth_simulateV1`, the engine falls back to `eth_call` (status only,
  decode-based partial effects) and says so in the report.
- **Sell/fee probe.** When the wallet holds the subject token and a
  PancakeSwap V2 pair resolves (token's `pair()` getter, else the V2
  factory), one simulated block transfers a probe amount to the pair
  and re-reads the pair's balance: a revert or zero receipt means the
  sell path is blocked (B05); the shortfall measures the effective
  sell-leg transfer fee (B07/W03).
- **Contract age (B10).** Public BSC endpoints prune state — measured
  2026-11-16, the deepest free endpoint (`bsc.publicnode.com`) keeps
  roughly 1–2 h; the Binance seeds keep < 2,000 blocks — and no free
  endpoint offers archive state. Age is therefore established two
  ways: an exact creation block (binary search over `eth_getCode`)
  when creation falls inside the retention window — precisely the
  fresh contracts B10 exists for — or a *provable lower bound* ("the
  contract already had code at the oldest readable block"), which
  clears B10 when it exceeds 1 h. When neither is obtainable (the
  endpoint fleet is load-balanced and pruning is uneven), B10 reports
  NOT_IMPLEMENTED. It never guesses an age.
- **Evaluate + seal.** All 30 rules run (no short-circuit) as pure
  functions over the evidence object. The verdict is a pure function
  of the fired-rule bitmap (POLICY §7): BLOCK bits 0–13 → 2, else WARN
  bits 16–28 → 1, else 0; ALLOW-context bits 32–34 record positive
  evidence. The report carries the six canonical fields as decimal
  strings, the bitmap, the verdict, and
  `commitment = Poseidon(fields[0..5], verdict)` computed with
  circomlibjs (the same Poseidon as the circuit).

**Canonical effects encoding (v1)** — the string hashed into
`effectsDigest = uint256(keccak256(encoding)) mod p`:
`JSON.stringify({ nativeDelta, tokenDeltas: [[token, delta]…] sorted,
allowanceDeltas: [[token, spender, amount]…] sorted, probes:
{ sellPath, sellFeeBps }, simStatus })`, all integers as decimal
strings.

## Rule coverage (30 rules)

**Implemented: 23. Not implemented in v1: 7** — every unimplemented
rule reports `NOT_IMPLEMENTED` with its reason in each report; none is
ever silently treated as passed.

| Rule | Status | Basis / why |
|---|---|---|
| B01 Unlimited approval to untrusted spender | ✅ implemented | calldata decode + spender verification (Sourcify) + spender census; unknown verification treated as unverified (fail-closed) |
| B02 Unverified target with native value | ✅ implemented | Sourcify status + `value > 0`; unreachable Sourcify ⇒ treated unverified (fail-closed) |
| B03 Value-out mismatch | ✅ implemented | preview claim vs `eth_simulateV1` log effects (decode-based partial effects on the `eth_call` fallback, disclosed in the reason); no claim supplied ⇒ NOT_IMPLEMENTED for that report |
| B04 Simulation revert | ✅ implemented | simulation status; an un-completable simulation also BLOCKs (fail-closed) |
| B05 Honeypot — sell path blocked | ✅ implemented (probe-conditional) | transfer-to-pair probe; reports NOT_IMPLEMENTED when there is no resolvable V2 pair or the wallet holds no token to probe with |
| B06 Hidden mint is live | ✅ implemented | source/ABI census (state-changing mint paths only) + on-chain cap-getter probes + mint-liveness probe |
| B07 Sell fee > 50% | ✅ implemented (probe-conditional) | fee measured by the B05 probe; NOT_IMPLEMENTED when the probe cannot run |
| B08 Deployer rug history | ❌ not implemented | needs explorer labels / an operator denylist (META); no label source is configured (explorer APIs require a key) |
| B09 Fake renounce / hidden ownership | ✅ implemented | `owner()` probe + census for renounce overrides, second/shadow admins, `DEFAULT_ADMIN_ROLE`, `selfdestruct` |
| B10 Fresh contract, high value | ✅ implemented (window-conditional) | exact age inside the RPC retention window, else a provable age lower bound, else NOT_IMPLEMENTED (see "Contract age") |
| B11 LP held by deployer | ❌ not implemented | needs LP-holder data (MKT) from an indexer/explorer API (key-gated) |
| B12 Holder concentration, extreme | ❌ not implemented | needs holder distribution (MKT), as above |
| B13 Permit replay / mismatch | ✅ implemented* | deadline + claim mismatch + explicit-nonce check (DAI-style). *Disclosed limit: an ERC-2612 permit's nonce is implicit in its signature, so replay of a still-unused permit cannot be excluded off-chain; once consumed, a replay reverts and B04 catches it |
| B14 Proxy, uninitialized implementation | ✅ implemented* | EIP-1967 slots + a no-arg `initialize()` probe against the implementation. *Implementations exposing `initialize` only with arguments report NOT_IMPLEMENTED |
| W01 Limited approval to retained-authority spender | ✅ implemented | approval decode + spender census |
| W02 Unbounded fee setter | ✅ implemented | token census: fee setter present, no ≤ 10% cap found in source, owner retained |
| W03 Elevated transfer fee | ✅ implemented (probe-conditional) | sell-leg fee from the B05 probe |
| W04 Transfer-restriction capability | ✅ implemented | token census (blacklist / max-tx / max-wallet / trading gate) + retained owner |
| W05 Upgradeable proxy, retained admin | ✅ implemented | EIP-1967 admin slot; the known-good timelock/multisig list is empty in v1, so any retained admin fires |
| W06 LP not locked or burned | ❌ not implemented | needs LP lock/holder data (MKT) |
| W07 Holder concentration | ❌ not implemented | needs holder distribution (MKT) |
| W08 Thin liquidity | ❌ not implemented | needs pool liquidity in USD (MKT); v1 has no price source |
| W09 LP-drain functions present | ✅ implemented | census of target and token (`migrateLP`, `emergencyWithdraw`, `setPair`, `setRouter`) + retained owner |
| W10 Oracle read without staleness/confidence | ✅ implemented | source scan: `latestRoundData()` with no `updatedAt` anywhere in project sources, or Pyth `getPriceUnsafe` with no checked `getPrice`; value-flow dependence is inferred and stated in the reason |
| W11 Sandwich amplification by design | ✅ implemented | source scan for the token's own swapback calling `swapExact*` with literal `0` amountOutMin (matched snippet quoted in the reason) |
| W12 Bonding-curve admin controls | ✅ implemented | census (`setCurve` / virtual-reserve setters) + retained admin |
| W13 ERC4626 first-depositor window | ✅ implemented* | `totalAssets()`/`asset()`/`totalSupply()` probes. *The share-transfer stake-record clause is not evaluated (stated in the reason) |
| A01 Right-sized approval to clean spender | ✅ implemented | needs an `intendedSpend` claim; verified spender + clean census + amount ≤ 1.1× intended spend |
| A02 Authorities verifiably gone | ✅ implemented | token census + `owner()` + cap evidence |
| A03 LP burned or long-locked | ❌ not implemented | needs LP lock/holder data (MKT) |

## Unit fixtures — 5/5 pass

Synthetic previews in `fixtures/`, expectations in
`fixtures/expectations.json`, recorded run in `fixtures/results.json`
(re-run with `node engine/run_fixtures.js`; results are anchored to
live BSC state and record their block):

| Fixture | Expected | Got |
|---|---|---|
| Unlimited `approve` on USDT to a freshly deployed, Sourcify-unverified contract | BLOCK (B01) | ✅ BLOCK, B01 |
| Unlimited `approve` on USDT to the PancakeSwap V2 router (verified, clean census) | ALLOW, no B01 | ✅ ALLOW |
| Plain 0.001 BNB transfer with a matching claim | ALLOW | ✅ ALLOW (bitmap 0) |
| USDT `transfer` of 10³⁰ from a wallet without the balance | BLOCK (B04) | ✅ BLOCK, B04 |
| WBNB `deposit()` of 0.05 BNB with a claim of `nativeOut = 0` | BLOCK (B03) | ✅ BLOCK, B03 |

## Field-case replays — the real sarah.ai calls, re-screened today

`replays/*.preview.json` rebuild the three historical calls from the
agent wallet `0xB0CC11F63e5aAa7bcB6010B28A4C0A94FB23D889` (read-only
simulation only; selectors taken from the contracts' verified ABIs on
Sourcify). Full reports in `replays/*.report.json`. **All three screen
BLOCK today** — the correct answer *now*: each call reverts, because
the windows they were executed in have closed. This is POLICY §8 in
action: a verdict is anchored to its block and expires with it. (The
original executions all succeeded and were receipt-verified on the
day: RuninAI `claimFree()` 2026-11-02, BNBbaby `mint(0)` 2026-11-02,
and the FEG free share was attempted in the 2026-11-10 race, where the
tranche sold out in seconds and the wallet never claimed.)

| Replay | Verdict today | What fired / notable evidence |
|---|---|---|
| **FEG** `claimFreeShare()` on CanopySale `0xb9d0…e5f1` | **BLOCK** | B04 — the call reverts (sale over). W11 — the FEG token's own swapback swaps with `amountOutMin = 0` (matched snippet in the report). B05 not implementable for this report: the wallet holds no FEG, so no sell can be probed |
| **RuninAI** `claimFree()` on FairAgentLaunchV3 `0xfB50…e9e6` | **BLOCK** | B04 — reverts (already claimed). B06 — a live `mint` path with no supply cap found; a probe mint reverts, i.e. the path is gated to a retained authority/phase. W11 — zero-slippage swapback in the token source. The sell probe *passed* and **measured the real sell fee: 2.00%** (10 RUNINAI probed, pair received 9.8), clearing B05/B07/W03 |
| **BNBbaby** `mint(0)` on BabyMint `0xBB7e…2637` | **BLOCK** | B04 — reverts with the contract's own reason: "minting closed". B06 *cleared by evidence*: the token's `MAX_SUPPLY` getter reads 10²⁷ on-chain, so the no-cap condition fails. B05 not implementable: no PancakeSwap V2 pair resolves for the token |

## v1 limitations (beyond POLICY §8)

- BSC only; sell/fee probes understand PancakeSwap V2 pairs only.
- The census is pattern-based over verified sources (POLICY §8: novel
  logic bugs are out of scope). Contracts without verified source get
  fail-closed treatment where POLICY requires it (B02), and census
  rules report NOT_IMPLEMENTED for them.
- B10's age evidence is bounded by public-RPC state retention
  (~1–2 h on the deepest free endpoint); an archive RPC would make it
  exact for all ages.
- Unlocking the 7 unimplemented rules needs one keyed data source
  (explorer/indexer API) for holder distribution, LP holders/locks,
  pool liquidity in USD, and deployer labels.
