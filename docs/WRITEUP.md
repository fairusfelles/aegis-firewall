# AEGIS — Verifiable Signing Firewall for Agent Wallets

**Wildcard submission — Agent Games (zkVerify)**
Participant: @mahrusfelles · Repository: https://github.com/fairusfelles/aegis-firewall · Demo: {{DEMO_URL}}

## The problem

AI agents now hold wallets and sign real transactions. The signing flow,
as it exists today, asks the agent (and its operator) to trust whatever
the interface shows: a preview that says "free claim, 0 out" is a
*claim*, written by the same party that profits from the signature. The
calldata is the truth, and almost nobody reads it before the signature
lands.

This is not hypothetical for us. AEGIS was designed against cases from
live operations of one agent wallet (`sarah.ai`, BSC) run by the author:

- **The FEG free-share race (2026-11-10).** A free tranche on a launch
  contract was exhausted within seconds of the sale opening; the wallet
  never claimed. In that environment, review time is measured in
  seconds — a human cannot audit calldata at race speed, and an agent
  that "just signs" signs blind.
- **The rejected approve.** An NFT listing flow died at an `approve`
  that the wallet provider's risk engine rejected outright, with no
  actionable explanation. The failure mode cuts both ways: gates that
  are too loose let lying previews through; gates that are too blunt
  reject without recourse or evidence.
- **Paid-mint and approval traps as a class.** "Free" mints that carry
  native value, fresh contracts asking for high value in their first
  hour, unlimited approvals to contracts nobody has audited — the
  policy set below (rules B01, B02, B10) exists because these patterns
  recur across launches.

A signing gate for agent wallets has to be fast, deterministic, and —
this is the part existing gates miss — *accountable*: its verdicts must
be checkable by third parties after the fact, not just asserted.

## What AEGIS does

AEGIS sits between an agent and the chain as a signing firewall:

1. **Intercept & simulate.** Every pending contract call is decoded and
   simulated against current chain state before signing. Effects are
   extracted from the simulation itself — tokens in/out, approvals
   granted, native value moved — not from the interface's description
   of them.
2. **Deterministic policy verdict.** The effects and a privileged-function
   census of the target contract are evaluated against a fixed set of
   **30 rules** (`docs/POLICY.md`): 14 BLOCK, 13 WARN, 3 ALLOW-context.
   The rules are derived from two established audit checklists — a
   token/rug-pull checklist (hidden mint, honeypot, fee manipulation,
   LP drain, authority retention, fake renounce, sandwich amplification)
   and a DeFi audit checklist (accounting desync, access control,
   signature replay, proxy issues, and more) — translated into
   pre-signing checks. No LLM judgement is in the verdict path.
   Unlimited approval to an unverified or authority-retaining spender:
   BLOCK. Value leaving the wallet that the preview did not claim:
   BLOCK. A simulation that reverts: BLOCK (fail-closed).
3. **Proof-sealed verdicts.** The verdict is a **pure function of the
   fired-rule bitmap**: any BLOCK bit → verdict 2, else any WARN bit →
   1, else 0. That bitmap is hashed into the report's canonical fields,
   and a Groth16 proof (Circom circuit `VerdictCommit`) attests that
   the published commitment equals `Poseidon(fields[0..5], verdict)` —
   so the proof binds not just *that* a verdict was issued, but *which
   evidence and which rules produced it*. Verification is via zkVerify.

## What's actually built and verified

Everything below is in the repository and reproducible from committed
source.

**Proof layer** (`circuits/`, `SPIKE.md`):

- Circuit authored for AEGIS (not a tutorial circuit):
  `circuits/verdict_commit.circom` — 381 constraints; private inputs
  are the six canonical report fields; public inputs are the verdict
  and the Poseidon commitment.
- Local Groth16 pipeline (circom 2.1.9, local powers-of-tau ceremony —
  the public Hermez file was unreachable from our environment, raw
  evidence in `SPIKE.md`) produced a proof for a dummy BLOCK report
  with commitment
  `4954722088366334405614505048853795618711906448956329676294600204393832980356`,
  and **local verification passed** (`snarkJS: OK!`).

**Screening engine** (`engine/`, `engine/README.md`):

- **23 of 30 rules implemented.** The 7 unimplemented rules (deployer
  labels, holder/LP market data) report `NOT_IMPLEMENTED` with their
  reason in every report — never a silent pass. The engine is
  read-only by construction: it holds no keys, signs nothing, submits
  nothing.
- **Unit fixtures: 5/5 pass** against live BSC state — including an
  unlimited approval to an unverified contract (BLOCK, B01), the same
  approval to the verified PancakeSwap V2 router (ALLOW), and a WBNB
  deposit whose preview claim lied about value out (BLOCK, B03).
- **Field replays: 3/3 real historical calls re-screened**
  (`engine/replays/`). All three verdict BLOCK today — correctly:
  each call now reverts, because the windows they executed in have
  closed (a verdict is anchored to its block and expires with it).
  - FEG `claimFreeShare()` — BLOCK: reverts (sale over); the token's
    own swapback swaps with `amountOutMin = 0` (WARN W11).
  - RuninAI `claimFree()` — BLOCK: reverts (already claimed
    2026-11-02); a live, uncapped mint path is still present and
    authority-gated (BLOCK B06). The engine's sell probe passed and
    **measured the token's real sell fee at exactly 2.00%** (10
    RUNINAI probed, the pair received 9.8).
  - BNBbaby `mint(0)` — BLOCK: reverts with the contract's own reason
    string, "minting closed"; the hidden-mint rule was *cleared by
    evidence* (the token's `MAX_SUPPLY` reads 10²⁷ on-chain).
  Each replay report carries the six canonical fields and its Poseidon
  commitment (BSC blocks 133802131–133802259), ready to seal.

**The one step that is NOT done — stated plainly.** The final on-chain
sealing of a proof via zkVerify is **pending a human-only gate**, and
we do not claim otherwise. Both submission paths are blocked at
exactly one human step, with raw evidence in `SPIKE.md`:

- **Kurier** requires an API key issued through a human account signup
  at testnet.kurier.xyz. Without a key the API returns "Payment
  required"; with a placeholder key and a complete, valid request it
  returns HTTP 401, "Unauthorized or disabled API key". The
  register/submit scripts are written and ready
  (`scripts/kurier_register.js`, `scripts/kurier_submit.js`).
- **Volta (zkVerifyJS fallback)** requires tVFY; the throwaway account
  stands at `free: "0"`, and every documented faucet route is
  human-gated (wallet-connect + CAPTCHA, Discord, or an email form).
  The submit script is ready (`scripts/volta_submit.js`).

The moment either gate is passed, sealing a real engine verdict is a
two-command run, and the resulting transaction hash becomes the public
proof reference.

## Limits

Condensed from `docs/POLICY.md` §8 — we state them because a firewall
that hides its limits is just another lying preview:

- AEGIS screens code, authorities, and simulated effects. It cannot
  detect off-chain intent or social rugs; a clean verdict means "no
  rule fired at this block", nothing more.
- Verdicts are snapshots. A retained owner can change fees tomorrow;
  a clean contract can be upgraded at the next block. Capability rules
  flag the retained power; they cannot remove it.
- Time- or state-delayed traps can pass a sell probe and still trap
  later, or trap other wallets.
- The census matches known audit patterns; a novel logic bug in a
  verified contract can pass. AEGIS is a pre-signing screen, not an
  audit.
- The proof proves the report, not the world: it attests that a
  specific report was committed and that the verdict follows from its
  bitmap. It cannot attest that the underlying RPC/indexer data was
  truthful.
- v1 scope is EVM (BSC). The Solana token classes are specified by the
  same capability logic but not implemented.

## Links

- Repository: https://github.com/fairusfelles/aegis-firewall
- Demo: {{DEMO_URL}}
- Policy rule set: `docs/POLICY.md` · Proof spike evidence: `SPIKE.md`
  · Engine + replay reports: `engine/`

Built by @mahrusfelles with an AI coding assistant.
