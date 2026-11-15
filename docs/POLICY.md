# AEGIS Policy Rule Set — Screening Engine Design

**Status:** design v1 (stage 2) · **Scope:** EVM chains, BSC (chainId 56) first ·
**Companion docs:** `../circuits/verdict_commit.circom` (proof layer),
`../SPIKE.md` (proof-path evidence)

## 0. Methodology provenance — where these rules come from

These rules are **not invented ad hoc**. Every trigger below is derived from
two supplied audit checklists, and each rule names the checklist class it
maps to:

- **Token audit checklist** (meme-coin / rug-pull audit): pre-dive **hard
  kills** and **soft kills**, 8 token bug classes — (T1) hidden mint, (T2)
  honeypot / transfer restriction, (T3) fee manipulation, (T4) LP drain,
  (T5) bonding-curve manipulation, (T6) authority retention, (T7) fake
  renounce / hidden ownership, (T8) sandwich amplification — and its one
  rule: *"Check ALL authorities and owner functions. The retained authority
  IS the rug vector."*
- **DeFi audit checklist** (smart-contract audit): 10 bug classes —
  (D1) accounting state desync, (D2) access control, (D3) incomplete code
  path, (D4) off-by-one / boundary, (D5) oracle manipulation, (D6) ERC4626
  vault attacks, (D7) reentrancy, (D8) flash-loan attacks, (D9) signature
  replay, (D10) proxy / upgrade issues — and its one rule: *"Read ALL
  sibling functions. The missing modifier on the sibling IS the bug."*

Translated into engine behaviour, those two "one rules" become AEGIS's two
foundational habits:

1. **Privileged-function census, not single-call inspection.** For every
   target contract the engine enumerates *all* privileged functions in the
   verified source (mint, blacklist, pause, fee setters, pair/router
   setters, LP migration, emergency withdraw, ownership paths) — not only
   the function the pending transaction happens to call. A capability that
   exists fires its rule even if this transaction never touches it.
2. **Claims-vs-effects comparison.** The wallet preview is treated as a
   *claim*; the simulation result is the *effect*. Any divergence between
   what the transaction says will happen and what simulation shows will
   happen is itself a finding (the accounting-desync mindset, D1).

## 1. Verdict semantics

| Verdict | Code | Meaning for the signing agent |
|---|---|---|
| BLOCK | 2 | Do not sign. No override path in the agent. |
| WARN | 1 | Do not sign autonomously; surface to the human with the fired rule(s) and require explicit confirmation of that exact preview. |
| ALLOW | 0 | No rule fired (or only ALLOW-context rules fired). Signing proceeds under the operator's normal preview → confirm discipline. |

Evaluation is deterministic and severity-ordered: **any BLOCK rule fired →
verdict 2; else any WARN rule fired → verdict 1; else verdict 0.** The
verdict is a pure function of the fired-rule bitmap (§5), so anyone shown
the report can re-derive it.

**Fail-closed defaults.** If a data source a rule needs is unavailable, the
engine degrades toward the safer verdict for value-bearing calls: an
unverifiable source status is treated as *unverified* (B02 can fire), a
failed simulation is a BLOCK (B04), and missing holder/LP data on a buy
leaves the corresponding WARN rules unevaluated-but-disclosed in the report
(the report lists data sources that were unavailable; it never silently
treats missing data as a pass).

## 2. Threshold constants (v1, all configurable in one place)

| Constant | Value | Basis |
|---|---|---|
| `UNLIMITED_APPROVAL` | amount ≥ 2²⁵⁵ (covers `type(uint256).max` and effectively-unlimited values) | ERC20 convention |
| `HIGH_VALUE` | native value ≥ 0.1 BNB-equivalent **or** ≥ 25% of the agent wallet's native balance, whichever is smaller | operator risk budget |
| `FEE_WARN` | effective sell fee > 10% | token checklist: fee cap benchmark `MAX_FEE ≤ 10%` (T3) |
| `FEE_BLOCK` | effective sell fee > 50% | halfway to the classic 99% fee rug (T3) |
| `HOLDER_WARN` | top non-pool holder > 20% of supply | token checklist soft kill |
| `HOLDER_BLOCK` | top non-pool holder (or deployer-linked cluster) > 50% of supply | escalation of the same soft kill |
| `MIN_LIQUIDITY` | pool liquidity < $5,000 | token checklist soft kill |
| `FRESH_AGE` | contract/token age < 1 hour | token checklist hard kill |
| `LP_LOCK_WARN` | LP lock < 30 days, or locker unverified | token checklist soft kill (T4) |
| `LP_LOCK_ALLOW` | LP burned, or locked ≥ 180 days in a verified locker | token checklist kill condition (T4) |

**Contexts.** Rules marked *(buy context)* apply when the decoded call
acquires a token for the wallet (swap with token-out to the wallet,
liquidity add, purchase, or a claim whose payout is a token). Rules marked
*(approval context)* apply when the decoded call is `approve` /
`increaseAllowance` / `permit`. All other rules apply to every call.

**Data-source codes** used in the tables:

- **CD** — calldata decode: selector + ABI decode of the pending call
  (ABI from verified source where available, selector registry otherwise).
- **SIM** — `eth_call` simulation from the agent wallet at the latest
  block, with effect extraction (native balance delta, per-token
  `balanceOf` deltas, `allowance` deltas) via probe calls around the
  simulated call, plus dedicated probes (e.g. a sell-path probe).
- **SRC** — verified-source census: explorer-verified source scanned for
  the privileged-function patterns of the two checklists (mint paths,
  blacklist/pause, fee setters and their caps, LP functions, renounce
  overrides, oracle reads).
- **CHAIN** — direct contract reads: `owner()`, authority/cap getters,
  `allowance`, `nonces`, EIP-1967 proxy slots
  (`0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`
  implementation, `0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103`
  admin), `totalSupply`, pair/reserve reads.
- **META** — explorer metadata: source-verification status, contract
  creation transaction/block (age), deployer address and its history.
- **MKT** — market structure data: holder distribution and LP
  holder/lock status from explorer/indexer and locker contracts.

## 3. BLOCK rules (verdict 2)

| ID | Rule | Exact trigger condition | Data source | Maps to |
|---|---|---|---|---|
| AEGIS-B01 | Unlimited approval to untrusted spender | Decoded `approve(spender, amount)` or `increaseAllowance` with `amount ≥ UNLIMITED_APPROVAL`, **and** spender is unverified/unknown **or** spender's census shows any retained privileged function (mint, blacklist, pause, fee setter) | CD + META + SRC | Hard kill "contract not verified"; T6 authority retention; D2 access control (an approval *is* standing access) |
| AEGIS-B02 | Unverified target with native value | `tx.to` is a contract whose source is **not verified**, and `tx.value > 0` | CD + META | Hard kill "contract not verified → cannot audit = cannot trust" |
| AEGIS-B03 | Value-out mismatch (claims vs effects) | Simulation shows value leaving the wallet that the preview did not claim: any unclaimed native/token outflow > 0, or any claimed outflow amount ≠ simulated amount | SIM | D1 accounting desync — what the tx claims vs what it does |
| AEGIS-B04 | Simulation revert (fail closed) | The pending call itself reverts under `eth_call` simulation from the agent wallet | SIM | D3 incomplete code path mindset; engine fail-closed default |
| AEGIS-B05 | Honeypot — sell path blocked | *(buy context, or token already held)* Sell-path probe fails: simulated transfer of the token to the pair, or simulated sell swap of a probe amount, reverts or returns 0 | SIM | T2 honeypot / transfer restriction |
| AEGIS-B06 | Hidden mint is live | *(buy context)* Token census finds an externally callable mint / supply-increasing path, **and** no enforced supply cap exists (no `MAX_SUPPLY`-style check in every mint path, no cap getter), **and** a mint authority / owner is retained | SRC + CHAIN | T1 hidden mint / unlimited supply |
| AEGIS-B07 | Sell fee is confiscatory | *(buy context)* Effective sell fee measured in simulation (probe sell: amount in vs amount out, net of price impact at probe size) `> FEE_BLOCK` (50%) | SIM | T3 fee manipulation |
| AEGIS-B08 | Deployer has rug history | Deployer of the target/token has prior deployed contracts flagged as rugs/honeypots in explorer labels or the operator's denylist | META | Hard kill "deployer wallet has history of rug pulls" |
| AEGIS-B09 | Fake renounce / hidden ownership | `owner()` reads zero (ownership appears renounced) **but** census finds a renounce override, a second admin path (shadow/backup owner, `DEFAULT_ADMIN_ROLE` held, selfdestruct), or privileged setters still callable | CHAIN + SRC | T7 fake renounce / hidden ownership; D2 access control |
| AEGIS-B10 | Fresh contract, high value | Target contract age `< FRESH_AGE` (1 h from creation block) **and** `tx.value ≥ HIGH_VALUE` | META + CD | Hard kill "token age < 1 hour" |
| AEGIS-B11 | LP held by deployer | *(buy context)* LP tokens for the token's main pool are held directly by the deployer EOA (removable at will; not burned, not in a locker) | MKT + CHAIN | T4 LP drain; token checklist on-chain check "LP held by deployer → CRITICAL" |
| AEGIS-B12 | Holder concentration, extreme | *(buy context)* Top non-pool holder, or a deployer-linked cluster (shared funder / sequential wallets), holds `> HOLDER_BLOCK` (50%) of supply | MKT | Soft kill (top holder) escalated; T6 |
| AEGIS-B13 | Permit replay / permit mismatch | Call is or contains `permit(...)` (or a signed-approval relay) where `nonce ≠ nonces(owner)` on-chain, or `deadline < block.timestamp`, or the permit's spender/value differ from the preview claim | CD + CHAIN | D9 signature replay (missing/mismatched nonce, deadline) |
| AEGIS-B14 | Proxy with uninitialized implementation | Target is a proxy (EIP-1967 implementation slot set) whose implementation contract is initializable by anyone: `initialize(...)` present without a consumed `initializer` guard (implementation owner unset and an `initialize` probe succeeds in simulation) | CHAIN + SIM | D10 proxy issues + D2 variant "uninitialized proxy" (Wormhole pattern) |

## 4. WARN rules (verdict 1)

| ID | Rule | Exact trigger condition | Data source | Maps to |
|---|---|---|---|---|
| AEGIS-W01 | Limited approval to authority-retained spender | *(approval context)* Approval below `UNLIMITED_APPROVAL` to a spender whose census shows retained privileged functions (mint, blacklist, pause, fee setter) — the unlimited case is B01 | CD + SRC | T6 authority retention — "the retained authority IS the rug vector" |
| AEGIS-W02 | Unbounded fee setter | *(buy context)* Token census finds a fee setter (`setFee` / `setSellFee` / tax setters) with **no** on-chain cap (no `require(fee ≤ MAX)` with `MAX ≤ 10%` in the setter path) callable by a retained owner | SRC | T3 fee manipulation (kill condition inverted) |
| AEGIS-W03 | Elevated transfer fee | *(buy context)* Effective fee measured in simulation `> FEE_WARN` (10%): buy fee, sell fee, or their combination on a round trip at probe size | SIM | T3 fee manipulation |
| AEGIS-W04 | Transfer-restriction capability | *(buy context)* Token census finds blacklist / `maxTxAmount` / max-wallet / `tradingEnabled`-type controls with a retained owner — capability present even if not currently exercised | SRC | T2 honeypot / transfer restriction (capability form) |
| AEGIS-W05 | Upgradeable proxy, retained admin | Target is behind a proxy and the EIP-1967 admin slot is non-zero and not a timelock/multisig on the operator's known-good list — logic can be replaced after a clean check | CHAIN | Soft kill "upgradeable / proxy with retained admin"; D10 |
| AEGIS-W06 | LP not locked or burned | *(buy context)* LP tokens are neither burned to a dead address nor locked in a verified locker; or lock duration `< LP_LOCK_WARN` (30 d); or locker contract unverified | MKT + CHAIN | Soft kill "LP not burned or locked"; T4 |
| AEGIS-W07 | Holder concentration | *(buy context)* Top non-pool holder `> HOLDER_WARN` (20%) of supply | MKT | Soft kill "top holder > 20%" |
| AEGIS-W08 | Thin liquidity | *(buy context)* Main pool liquidity `< MIN_LIQUIDITY` ($5,000) | MKT | Soft kill "less than $5K liquidity" |
| AEGIS-W09 | LP-drain functions present | Token/pool census finds `migrateLP`, `emergencyWithdraw`, `setPair`, or `setRouter` callable by a retained owner | SRC | T4 liquidity pool drain |
| AEGIS-W10 | Oracle read without staleness/confidence check | Verified source of the target reads `latestRoundData()` without an `updatedAt` staleness check, or Pyth `getPriceUnsafe` without a confidence check, **and** the pending call's value flow depends on that price path | SRC | D5 oracle manipulation (missing staleness / confidence) |
| AEGIS-W11 | Sandwich amplification by design | Token census finds its own auto-swap / swapback path calling a swap with `amountOutMin = 0` (zero-slippage `swapExactTokensForETH`-style call) | SRC | T8 sandwich amplification |
| AEGIS-W12 | Bonding-curve admin controls | *(buy context on launchpad tokens)* Curve contract census finds `setCurve` / `virtualReserve` setters or a permissioned `graduate` path with retained admin | SRC | T5 bonding-curve manipulation |
| AEGIS-W13 | ERC4626 first-depositor window | Target is an ERC4626 vault and (totalSupply ≈ 0 or totalAssets ≈ 0 while deposits are open) or its share `transfer` does not move stake/lock records | CHAIN + SRC | D6 ERC4626 vault attacks |

## 5. ALLOW-context rules (verdict 0 contributors)

These rules never fire a warning. When one evaluates true it is recorded
in the report as positive evidence — the explicit, checkable form of
"this concern was examined and cleared", mirroring the checklists'
*kill conditions* (the conditions under which a finding dies).

| ID | Rule | Exact evaluation condition | Data source | Maps to |
|---|---|---|---|---|
| AEGIS-A01 | Right-sized approval to clean spender | *(approval context)* Approval amount ≤ 1.1 × the amount the simulation shows this transaction will spend, spender source verified, spender census shows no retained privileged functions | CD + SIM + SRC | D2 access control (least-privilege approval) |
| AEGIS-A02 | Authorities verifiably gone | *(buy context)* Token has no callable mint path or a cap enforced in every mint path; ownership renounced with no override and no second admin role; no blacklist or fee setters in census | SRC + CHAIN | T1/T6/T7 kill conditions ("kill if: mint removed / all authorities = None") |
| AEGIS-A03 | LP burned or long-locked | *(buy context)* LP tokens burned to a dead address, or locked ≥ `LP_LOCK_ALLOW` (180 d) in a verified locker contract | MKT + CHAIN | T4 kill condition ("LP tokens burned, no migration function") |

## 6. Engine pipeline

```
preview JSON ──▶ 1 DECODE ──▶ 2 CENSUS ──▶ 3 SIMULATE ──▶ 4 MARKET ──▶ 5 EVALUATE ──▶ 6 REPORT + SEAL
```

1. **Ingest.** Input is one preview document — the same JSON a wallet's
   contract-call preview produces: `{from, to, value, data, chainId}` plus
   the human-facing claim (what the operator was told will happen:
   amounts out/in, recipient, purpose). The claim is data, never truth.
2. **Decode (CD).** Selector → function signature; ABI-decode arguments.
   Classify the call: native transfer / approval / permit / swap /
   generic contract call. Extract spender + amount for approvals, token
   identity for buy contexts.
3. **Census (SRC + META + CHAIN).** For the target (and, in buy context,
   the token): verification status, age, deployer history; privileged-
   function census over the verified source; authority reads (`owner()`,
   cap getters, EIP-1967 slots, `nonces`). This stage implements the two
   "one rules" of §0: *all* authorities, *all* sibling functions.
4. **Simulate (SIM).** `eth_call` of the exact pending call from the
   agent wallet at the latest block. Extract effects: native delta,
   per-token balance deltas, allowance deltas — then run the probes the
   rules need (sell-path probe, round-trip fee probe). Compare effects
   against the preview claim (B03).
5. **Market (MKT).** Buy contexts only: holder distribution, pool
   liquidity, LP holder/lock status.
6. **Evaluate.** Rules run in severity order — all BLOCK rules, then all
   WARN rules, then ALLOW-context evaluations. Evaluation does **not**
   short-circuit: the report lists every rule that fired, so a BLOCK
   verdict still shows the WARNs behind it. Verdict derives from the
   fired-rule bitmap (§7) by the §1 rule.
7. **Report + seal.** Emit the canonical report (human-readable JSON for
   the operator + the six committed field elements of §7), compute the
   Poseidon commitment, and produce the Groth16 verdict-commitment proof
   for zkVerify verification (see `../circuits/verdict_commit.circom` and
   `../SPIKE.md`).

Determinism note: given the same preview, the same chain state (block
number, §7 field 5), and the same rule version, the engine emits the
same report and the same verdict. All randomness, wall-clock dependence,
and LLM judgement are excluded from the verdict path by construction —
an advisory natural-language explanation may be attached to the report,
but it is not an input to any rule.

## 7. Canonical report fields → `VerdictCommit` circuit mapping

The circuit commits to six private field elements plus the public
verdict: `commitment = Poseidon(fields[0..5], verdict)`. The engine's
canonical report is defined so that these six elements bind everything
the verdict depends on. (This refines the spike's placeholder semantics
in `../SPIKE.md` §3, where the same six positions were exercised with
dummy values `["1", "56", …]`.)

| Field | Name | Definition (all values reduced into the BN128 scalar field) |
|---|---|---|
| `fields[0]` | `reportVersion` | Schema + rule-set version. `1` for this document. Any rule or threshold change increments it — a commitment is only meaningful against a known rule version. |
| `fields[1]` | `chainId` | EIP-155 chain id of the screened call (e.g. `56` = BSC). Binds the verdict to one chain; a report cannot be replayed as evidence on another chain. |
| `fields[2]` | `walletHash` | `Poseidon([uint160(agentWallet)])` — the wallet whose funds the call would move, hashed from its 160-bit address as a single field element. The raw address appears in the off-chain report body. |
| `fields[3]` | `contractHash` | `Poseidon([uint160(target), uint32(selector)])` — the target contract and the exact function being called. A verdict about `approve` is not a verdict about `transfer`. |
| `fields[4]` | `simulationHash` | `Poseidon([effectsDigest, rulesBitmap])`, where `effectsDigest = uint256(keccak256(canonical effects encoding)) mod p` over the extracted simulation effects (native delta, sorted per-token deltas, allowance deltas, probe outcomes), and `rulesBitmap` is the fired-rule bitmask defined below. This binds the verdict to both the observed effects and the exact rules that fired. |
| `fields[5]` | `blockNumber` | The block number whose state the simulation and all CHAIN/MKT reads ran against — the unambiguous chain-state anchor. (Wall-clock time is kept in the off-chain report body; the committed anchor is the block.) |
| *(public)* | `verdict` | `0` ALLOW / `1` WARN / `2` BLOCK, derived from `rulesBitmap`: any BLOCK bit → 2; else any WARN bit → 1; else 0. |

**`rulesBitmap` layout** (bit *i* set ⇔ the rule fired):

- bits 0–13 → BLOCK rules AEGIS-B01…B14 (bit 0 = B01, …, bit 13 = B14)
- bits 16–28 → WARN rules AEGIS-W01…W13 (bit 16 = W01, …, bit 28 = W13)
- bits 32–34 → ALLOW-context rules AEGIS-A01…A03 (recorded as positive
  evidence; they never affect the verdict derivation)

Because the bitmap is inside `simulationHash`, and `simulationHash` is
inside the commitment, the proof attests not just *that* a verdict was
issued but *which evidence and which rules produced it* — while the
report contents themselves stay private unless the operator chooses to
reveal them for verification.

## 8. Honesty section — what this engine cannot detect

Judges reward stated limits. These are AEGIS's:

- **Off-chain intent and social rugs.** The engine screens code,
  authorities, and simulated effects. A team can pass every check and
  still abandon the project, dump treasury tokens acquired legitimately,
  or rug through channels no contract exposes. A clean verdict means
  "no screened capability or effect fired a rule at this block" —
  nothing more.
- **The future.** Capability rules (W01, W02, W04, W05, W09) flag
  retained power precisely because a clean check is a snapshot: an owner
  who is honest today can set a 99% fee tomorrow if the setter exists.
  Conversely, a contract clean at block *N* can be upgraded at *N+1*
  (W05 discloses this; it cannot prevent it). Verdicts expire with the
  block they are anchored to.
- **Time- and state-delayed traps.** A honeypot that activates only
  after a delay, after a holder threshold, or for wallets other than the
  probing wallet can pass the sell-path probe (B05) and still trap
  later or trap others. Probes reduce this class; they do not eliminate
  it.
- **Novel logic bugs.** The census matches the two checklists' known
  patterns. A verified contract with a *novel* accounting or reentrancy
  flaw (D1/D7 patterns outside the census patterns) can pass. AEGIS is
  a pre-signing screen, not a full audit, and does not claim to be one.
- **What the human was shown.** The firewall judges the transaction
  itself, which defeats a lying front-end *only if* the preview claim
  fed to B03 is the claim the human actually saw. If a compromised
  interface shows the human one thing and feeds the engine the same
  false claim it executes, B03 cannot catch the gap — the defence is
  that the *effects*, not the story, drive every other rule.
- **Data-source dependence.** Holder and LP data come from
  explorers/indexers and can lag or be wrong; deployer-history labels
  (B08) are only as complete as the labelling source. The report lists
  which sources were consulted and which were unavailable.
- **Price and liquidity are point-in-time.** `MIN_LIQUIDITY` and fee
  probes are measured at one block and one probe size; a larger trade
  can face worse effective fees through price impact alone (impact is
  excluded from the B07/W03 fee measurement by design, and disclosed).
- **Scope of v1.** EVM only. The token checklist's Solana classes
  (authority retention on SPL, Token-2022 transfer hooks and permanent
  delegate — hard kills on Solana) are specified by the same capability
  logic but are **not implemented** in the v1 engine; no Solana verdict
  should be inferred from this rule set.
- **The proof proves the report, not the world.** The zkVerify-verified
  commitment attests that a specific report (fields, bitmap, verdict)
  was committed and that the verdict follows from the bitmap. It cannot
  attest that the underlying RPC/indexer data was truthful — only that
  the engine's decision over the data it saw is fixed and checkable.
