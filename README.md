# AEGIS — Verifiable Signing Firewall for Agent Wallets

**Don't trust the agent. Verify it.**

AI agents now hold wallets and sign real transactions. AEGIS sits between an
agent and the chain as a signing firewall:

1. **Intercept & simulate** every contract call before signing — decode the
   calldata, simulate against current chain state, extract exactly what will
   move (tokens in/out, approvals granted, native value).
2. **Deterministic policy verdict** — ALLOW / WARN / BLOCK with
   machine-readable reasons. Unlimited approval to an unknown contract:
   BLOCK. Value-out that disagrees with the preview: BLOCK. No LLM guessing —
   auditable rules.
3. **Proof-sealed verdicts** — every verdict is published with a
   zero-knowledge proof, verified by [zkVerify](https://zkverify.io), that the
   verdict was produced over a committed report: *at time T, for call C from
   wallet W, the simulation returned R, and the verdict was V.* Anyone can
   check it without trusting AEGIS or any single RPC.
4. **Field-proven** — the demo replays real cases from live agent-wallet
   operations (a free-share sale race, a clean free claim, a malicious
   unlimited approval), with on-chain receipts.

## Status

Building — Agent Games (zkVerify) entry: **Wildcard** + **Creator Track**.
Participant: @mahrusfelles.

## Layout

- `circuits/` — the verdict-commitment Circom circuit (Groth16/BN128)
- `src/` — screening engine, policy rules, proof sealing (Kurier API)
- `docs/` — use case, build context, field reports

Built by @mahrusfelles with an AI coding assistant.
