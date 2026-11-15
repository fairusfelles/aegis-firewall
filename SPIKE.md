# AEGIS Proof Spike — Verdict-Commitment Proof on zkVerify

**Date:** 2026-11-16 (WIB) · **Scope:** testnet only (Volta) · **Network rule:** no mainnet, no user wallets/keys anywhere.

**Overall verdict: INCOMPLETE at the finalization stage — blocked by two
independent human-only gates, with every stage before those gates proven
below from raw outputs.** The circuit is authored for AEGIS (not a tutorial
circuit), compiled from source in this repo, and the proof verifies locally.
Neither submission path could be completed by an agent alone:

- **Kurier** requires an API key issued through a human account signup at
  https://testnet.kurier.xyz (raw 401 evidence in Stage 4).
- **zkVerifyJS (fallback)** requires tVFY, and every documented faucet route
  requires a human step (wallet-connect + CAPTCHA, Discord, or an email
  form). The throwaway account sits at `free: "0"` (raw evidence in Stage 5).

Exact unblock steps and the commands that finish the spike are in §6.

---

## Stage 0 — Toolchain ✅

```
$ node -v
v24.22.1
$ ./tools/circom --version
circom compiler 2.1.9
```

circom 2.1.9 is the official `iden3/circom` release binary
(`circom-linux-amd64`), stored at `tools/circom` (gitignored; fetch command
is in `scripts/build_proof.sh`). `snarkjs`, `circomlib`, `circomlibjs`,
`zkverifyjs` are pinned by `package.json` / `package-lock.json`.

## Stage 1 — Circuit (authored, compiled from source) ✅

`circuits/verdict_commit.circom` — template `VerdictCommit`:

- private inputs `fields[6]` — the canonical verdict-report fields;
- public inputs `verdict` and `commitment`;
- single constraint: `commitment === Poseidon(fields[0..5], verdict)`
  (circomlib `Poseidon(7)`).

This is a verdict-commitment circuit written for AEGIS. It is not the
zkVerify docs' toy example (an `a*b===c` circuit); the docs were used only
for Kurier API call formats.

Compile output / r1cs info (raw):

```
# of Wires: 389
# of Constraints: 381
# of Private Inputs: 6
# of Public Inputs: 2
# of Outputs: 0
```

## Stage 2 — Trusted setup (reproducible, local ceremony) ✅

The public powers-of-tau file was attempted first and is **not** usable
from this environment — raw S3 response:

```xml
<Error><Code>AccessDenied</Code><Message>Access Denied</Message>...</Error>
```

Fallback used (as planned): a local pot12 ceremony —
`powersoftau new bn128 12` → `contribute` → `prepare phase2` — then
`groth16 setup` → `zkey contribute` → `zkey export verificationkey`.
Full pipeline: `scripts/build_proof.sh`. Artifacts: `build/pot12_final.ptau`,
`build/verdict_commit_final.zkey`, `build/verification_key.json`
(ptau/zkey are gitignored and regenerable by the script; the vkey, r1cs,
proof and public signals are committed as spike evidence).

## Stage 3 — Proof generation + LOCAL verification ✅

Dummy report fields (semantic stand-ins for
`[reportVersion, chainId, walletHash, contractHash, simulationHash,
timestampBlock]`), verdict `2` (BLOCK) — `build/input.json`:

```json
{
  "fields": ["1", "56", "123456789", "987654321", "555555555", "1700000000"],
  "verdict": "2",
  "commitment": "4954722088366334405614505048853795618711906448956329676294600204393832980356"
}
```

The commitment was computed off-chain with circomlibjs `buildPoseidon`
(same Poseidon parameters as the circuit). Public signals emitted by the
prover (`build/public.json`) — verdict first, then commitment, matching the
declared public-input order:

```json
[
  "2",
  "4954722088366334405614505048853795618711906448956329676294600204393832980356"
]
```

Local verification (raw snarkjs output) — **passed before any network
submission was attempted**:

```
[INFO]  snarkJS: OK!
```

The full proof is in `build/proof.json`. The proof genuinely attests:
knowledge of six private field elements and the verdict `2` whose Poseidon
hash equals the public commitment above.

## Stage 4 — Kurier testnet: vk registration ❌ BLOCKED (API key = human signup)

Endpoint: `https://api-testnet.kurier.xyz/api/v1` (per docs.zkverify.io).
Request format follows the official Kurier tutorial exactly
(`proofType: "groth16"`, `proofOptions: {library: "snarkjs", curve: "bn128"}`,
`vk: <verification_key.json>`) via `scripts/kurier_register.js`.

Probe with no key in the path (raw response body):

```json
{"error":"Payment required"}
```

Probe with a placeholder key and the **full, valid** register-vk body
(raw response, HTTP 401; also saved as
`build/kurier_register_vk_response.json`):

```
HTTP status: 401
{"statusCode":401,"code":"UNAUTHORIZED","error":"Unauthorized","message":"Unauthorized or disabled API key"}
```

(The earlier schema error with an incomplete body was Fastify validation
running before auth; with a complete body, auth is enforced.)

Why no key can be obtained by an agent: the official docs
(*Verifying proofs with Kurier*, docs.zkverify.io) state — "Create your own
API key by signing up **here for mainnet** (kurier.xyz) or **here for
testnet** (testnet.kurier.xyz)". Key issuance is an account signup on
https://testnet.kurier.xyz; no public/demo key is documented anywhere in
docs.zkverify.io or on kurier.xyz. Per spike rules, no account was created
with anyone's identity or credentials.

## Stage 5 — Fallback: zkVerifyJS on Volta ⚠️ PIPELINE VALID, BLOCKED AT FUNDING

A throwaway account was generated locally
(`scripts/gen_volta_account.js`); its mnemonic exists only in
`.secrets/volta.json` (mode 600, gitignored) and is never printed or
committed. Public address:

```
5DPkxBdMPSwqULP7MqtyQPAuKcYQFqTnX9HinmqdABAjtd8V
```

Session + balance read via `scripts/volta_submit.js --balance-only`
(raw chain response):

```json
{"nonce":"0","consumers":"0","providers":"0","sufficients":"0","data":{"free":"0","reserved":"0","frozen":"0","flags":"170,141,183,460,469,231,731,687,303,715,884,105,728"}}
```

`free: "0"` — the account is unfunded and does not yet exist on-chain
(`providers: "0"`). A full submission was then attempted
(`node scripts/volta_submit.js`, log: `build/volta_submit_attempt.txt`).
Raw result returned by `verify().execute()` (also in
`build/volta_verify_result.json`):

```json
{
  "events": { "_events": {}, "_eventsCount": 0 },
  "transactionResult": {}
}
```

No tx hash, no `ProofVerified` event, no extrinsic — **nothing was
submitted on-chain**, exactly as the docs warn ("confirm the account has
tVFY, otherwise the transaction will not be accepted on-chain"). This is
reported as a non-submission, not dressed up as a result.

Why funding is a human step — every documented tVFY route:

- Official docs point to the community faucet at faucy.com. Its page text:
  *"Claim **0.5** Volta testnet tokens by connecting your wallet and
  completing the CAPTCHA."* — live-browser wallet connect + CAPTCHA.
- Docs' alternative: the zkVerify **Discord**.
- The wallet-guide variant: a manual form — "submit your email address and
  Wallet Address and you will receive $tVFY within 24 hours."

Environment caveat (observed, not a blocker): the WSS path from this VM to
`wss://volta-rpc.zkverify.io` is intermittent — one session attempt logged
repeated `API-WS: disconnected ... 1006:: Abnormal Closure` for ~28 minutes
before connecting; subsequent attempts connected immediately (the balance
read above had zero disconnects).

## Stage 6 — What unblocks the spike (either option suffices)

**Option A — Kurier (preferred, no chain funds needed):**

1. A human signs up at https://testnet.kurier.xyz and generates an API key
   from the dashboard (account signup; a couple of minutes).
2. Then, in this repo:
   ```
   KURIER_API_KEY=<key> node scripts/kurier_register.js   # expect 200 + vkHash
   KURIER_API_KEY=<key> node scripts/kurier_submit.js     # polls to "Finalized"
   ```
   `kurier_submit.js` writes the raw submit body to
   `build/kurier_submit_response.json` and the Finalized job body
   (with `txHash`) to `build/kurier_job_finalized.json` — that `txHash` is
   the public proof reference.

**Option B — Volta / zkVerifyJS:**

1. A human sends tVFY to `5DPkxBdMPSwqULP7MqtyQPAuKcYQFqTnX9HinmqdABAjtd8V`
   via any faucet route above (faucy claim is 0.5 tVFY — far more than one
   verification fee; the email form can name this address directly, so the
   throwaway seed never has to enter a browser wallet).
2. Then: `node scripts/volta_submit.js` — it submits the same proof and
   writes the raw result (tx hash + events) to
   `build/volta_verify_result.json`.

## Reproduction

```
bash scripts/build_proof.sh   # circuit -> setup -> input -> proof -> local verify (OK!)
```

Everything up to the two human gates re-runs from committed source with
pinned dependencies.
