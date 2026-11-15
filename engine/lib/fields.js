"use strict";
// Canonical report fields, rules bitmap, verdict derivation and the
// Poseidon commitment — exactly as specified in docs/POLICY.md §7.
// The verdict is a pure function of the rules bitmap: any BLOCK bit
// (0-13) -> 2, else any WARN bit (16-28) -> 1, else 0. ALLOW-context
// bits (32-34) are recorded evidence and never affect the verdict.

const { ethers } = require("ethers");
const { buildPoseidon } = require("circomlibjs");

const BN128_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const REPORT_VERSION = 1;

const BLOCK_IDS = Array.from({ length: 14 }, (_, i) => `AEGIS-B${String(i + 1).padStart(2, "0")}`);
const WARN_IDS = Array.from({ length: 13 }, (_, i) => `AEGIS-W${String(i + 1).padStart(2, "0")}`);
const ALLOW_IDS = Array.from({ length: 3 }, (_, i) => `AEGIS-A${String(i + 1).padStart(2, "0")}`);
const ALL_IDS = [...BLOCK_IDS, ...WARN_IDS, ...ALLOW_IDS];

function bitIndex(id) {
  const n = parseInt(id.slice(7), 10);
  if (id.startsWith("AEGIS-B")) return n - 1; // bits 0..13
  if (id.startsWith("AEGIS-W")) return 16 + (n - 1); // bits 16..28
  if (id.startsWith("AEGIS-A")) return 32 + (n - 1); // bits 32..34
  throw new Error(`unknown rule id ${id}`);
}

function computeBitmap(ruleResults) {
  let bitmap = 0n;
  for (const r of ruleResults) {
    if (r.status === "TRIGGERED") bitmap |= 1n << BigInt(bitIndex(r.id));
  }
  return bitmap;
}

function verdictFromBitmap(bitmap) {
  const blockMask = (1n << 14n) - 1n;
  const warnMask = (((1n << 13n) - 1n) << 16n);
  if (bitmap & blockMask) return 2;
  if (bitmap & warnMask) return 1;
  return 0;
}

// Canonical effects encoding (v1), hashed into effectsDigest:
// JSON with sorted keys; BigInt values as decimal strings; token and
// allowance deltas sorted by address. Covers exactly the POLICY §7
// inputs: native delta, per-token deltas, allowance deltas, probe
// outcomes — plus the simulation status, so a reverted call's report
// cannot share a digest with a successful no-op.
function canonicalEffectsEncoding(effects, probes, simStatus) {
  const tokenDeltas = [...effects.tokenDeltas.entries()]
    .map(([token, delta]) => [token, delta.toString()])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const allowanceDeltas = effects.allowanceDeltas
    .map((a) => [a.token, a.spender, a.amount])
    .sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
  return JSON.stringify({
    nativeDelta: effects.nativeDelta.toString(),
    tokenDeltas,
    allowanceDeltas,
    probes: {
      sellPath: probes && probes.sellPath ? probes.sellPath : "not-run",
      sellFeeBps: probes && probes.sellFeeBps !== undefined ? probes.sellFeeBps : null,
    },
    simStatus,
  });
}

function effectsDigest(encoding) {
  const hash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(encoding));
  return BigInt(hash) % BN128_PRIME;
}

let poseidonPromise = null;
function getPoseidon() {
  if (!poseidonPromise) poseidonPromise = buildPoseidon();
  return poseidonPromise;
}

// Compute fields[0..5] and the commitment Poseidon(fields, verdict),
// matching circuits/verdict_commit.circom (circomlib Poseidon).
async function computeFields({ chainId, from, to, selector, digest, bitmap, blockNumber }) {
  const poseidon = await getPoseidon();
  const F = poseidon.F;
  const h = (inputs) => F.toString(poseidon(inputs.map((x) => BigInt(x))));
  const walletHash = h([BigInt(from)]);
  const contractHash = h([BigInt(to), BigInt(selector)]);
  const simulationHash = h([digest, bitmap]);
  const fields = [
    String(REPORT_VERSION),
    String(chainId),
    walletHash,
    contractHash,
    simulationHash,
    String(blockNumber),
  ];
  return { fields };
}

async function computeCommitment(fields, verdict) {
  const poseidon = await getPoseidon();
  const F = poseidon.F;
  return F.toString(poseidon([...fields.map((x) => BigInt(x)), BigInt(verdict)]));
}

module.exports = {
  BN128_PRIME,
  REPORT_VERSION,
  BLOCK_IDS,
  WARN_IDS,
  ALLOW_IDS,
  ALL_IDS,
  computeBitmap,
  verdictFromBitmap,
  canonicalEffectsEncoding,
  effectsDigest,
  computeFields,
  computeCommitment,
};
