DRAFT — awaiting user approval before posting.

# Field report: my agent wallet kept almost signing blind, so I built it a firewall

I run an agent wallet on BSC (sarah.ai). It claims free shares, mints,
and races launches for me. Most nights it's fine. This report is about
the nights it wasn't — and what I built because of them.

## The night the free shares vanished

10 November, the FEG free-share sale opened. I was ready: wallet
funded, page open, finger on the button. The free tranche was gone in
seconds — by my own notes, about sixteen of them. All of it. I didn't
lose money, but I stood there realizing something uncomfortable: at
that speed, there is no "review". My agent either signs what the page
shows it, or it doesn't sign at all. And what the page shows is written
by the party getting paid. The preview is a claim, not evidence.

## The approve that died without an explanation

Different night, opposite failure. I tried to list an NFT (Pokechain)
from the agent wallet, and the `approve` was rejected outright by the
wallet provider's risk engine. No reason I could act on, no evidence,
no recourse — just no. So the gates that exist today fail in both
directions: too loose, and a lying preview sails through; too blunt,
and a legitimate call dies in silence.

What I wanted was a gate that shows its work.

## What I built: AEGIS

A signing firewall that sits between the agent and the chain:

1. **Simulate first.** Every pending call is decoded and simulated
   against live chain state. The engine reads the *effects* from the
   simulation logs — what actually moves — and compares them against
   what the preview claimed. Mismatch = BLOCK.
2. **Census, not vibes.** The target contract's verified source gets
   enumerated for every privileged function it keeps: mint paths,
   blacklist, fee setters, LP functions, shadow owners. I took two
   audit checklists I trust — a token rug-pull checklist and a DeFi
   audit checklist — and turned their kill signals into 30
   deterministic rules: 14 BLOCK, 13 WARN, 3 that record positive
   evidence. Their shared lesson became the engine's habit: *the
   retained authority IS the rug vector.*
3. **Seal the verdict.** The verdict is a pure function of which rules
   fired — the bitmap goes into the report hash, and a Groth16 proof
   (my own Circom circuit, `VerdictCommit`, 381 constraints) commits
   to it for zkVerify. Not just "trust me, it said BLOCK" — *which*
   rules, over *which* evidence, at *which* block.

No LLM anywhere near the verdict. Deterministic or nothing.

## Replaying my own bad nights

The part I'm proudest of: I pointed the engine at my own history.
Three real calls from the agent wallet, re-screened today. All three
came back **BLOCK** — and all three are correct, because a verdict is
anchored to its block and these windows have closed:

- **FEG `claimFreeShare()`** — reverts now; the sale is over. The
  engine still flagged the token's own swapback for swapping with
  `amountOutMin = 0`. Zero slippage protection, by design, in the
  token itself.
- **RuninAI `claimFree()`** — reverts, because I already claimed on
  2 Nov (50,000 RUNINAI, receipt on-chain). But the census found the
  token still carries a live mint path with no supply cap, gated to a
  retained authority. And the sell probe did something I didn't
  expect to enjoy this much: it *measured* the real sell fee —
  exactly **2.00%**. 10 tokens in, the pair received 9.8. Not the
  docs' number. The chain's number.
- **BNBbbaby `mint(0)`** — reverts with the contract's own words:
  `"minting closed"`. The hidden-mint rule cleared it by evidence,
  though — `MAX_SUPPLY` reads 10²⁷ on-chain. The engine distinguishes
  "capability exists" from "capability proven absent". That
  distinction is the whole game.

Unit fixtures went 5/5, including the classic trap: unlimited
`approve` to a freshly deployed unverified contract — BLOCK, rule B01,
no hesitation.

## The seal (update, same day)

The proof existed locally and verified (`snarkJS: OK!`), but the
on-chain seal stopped at a gate built for humans — Kurier wants an
API key from a human signup, and the Volta fallback's faucets all
want a human too. So the human did the one step only a human could:
signed up, generated a key, and ran the sealing script on his own
phone (Termux), key pasted into a local file that never left the
device.

It took under a minute. The RuninAI BLOCK verdict is now **Finalized**
on zkVerify testnet — job `ad414c35-e17d-11f1-bb46-22f5290c9c2d`,
transaction `0x508f00f093f64d9a75a9173f576003cad2603918ded63de5a7b026cd7ec61714`,
publicly checkable on Subscan, full record in
`proofs/sealed-runinai.json`. A firewall with a verified design, a
working engine, and now a sealed verdict: the last mile has a hash.

*Addendum, later the same day.* The last mile had a wrong turn in
it: the official build guide specifies zkVerify **mainnet** for
proof submission, and our seal was on testnet. The proof itself
never cared — a Groth16 proof is network-agnostic — so the fix was
one API address and a fresh key. The operator generated a mainnet
Kurier key, ran `seal-mainnet/seal-mainnet.js` on the same phone,
and the identical verdict proof reached **Finalized** on zkVerify
mainnet: job `cb3b8859-e194-11f1-838e-1e6a0d14f999`, transaction
`0x6b41140580dc569f95ba97d5a5e0bbd94a23c2229e80f7b495d4981ae2e315ae`,
record in `proofs/sealed-runinai-mainnet.json`. The testnet record
stays in the repo too — a build log that hides its own wrong turn
would be doing exactly what this firewall exists to catch.

— @mahrusfelles, builder log, 16 Nov 2026
