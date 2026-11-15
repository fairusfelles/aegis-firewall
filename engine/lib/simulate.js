"use strict";
// Simulation (POLICY pipeline stage 3, data source SIM) built on
// eth_simulateV1, which the public BSC endpoints support: it executes
// the pending call (plus optional probe calls) sequentially in one
// synthetic block over the latest state and returns per-call status and
// logs, so real effects can be extracted. Falls back to a plain
// eth_call (status only, effects partial) when simulate is unavailable.

const rpc = require("./rpc");

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const SYNTHETIC_NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ZERO = "0x0000000000000000000000000000000000000000";

const topicAddress = (t) => "0x" + t.slice(-40).toLowerCase();
const lc = (a) => (a || "").toLowerCase();

// Extract wallet-relative effects from a simulated call's logs.
// - ERC20 Transfer events on token contracts -> per-token deltas.
// - Synthetic native-transfer logs (traceTransfers) -> native delta.
// - Approval events emitted by the wallet -> allowance deltas.
function extractEffects(logs, wallet) {
  const w = lc(wallet);
  let nativeDelta = 0n;
  let sawSynthetic = false;
  const tokenDeltas = new Map();
  const allowanceDeltas = [];
  for (const log of logs || []) {
    const topic0 = (log.topics && log.topics[0] || "").toLowerCase();
    if (topic0 !== TRANSFER_TOPIC && topic0 !== APPROVAL_TOPIC) continue;
    const from = topicAddress(log.topics[1]);
    const to = topicAddress(log.topics[2]);
    const amount = BigInt(log.data || "0x0");
    if (topic0 === APPROVAL_TOPIC) {
      if (from === w) {
        allowanceDeltas.push({ token: lc(log.address), spender: to, amount: amount.toString() });
      }
      continue;
    }
    if (lc(log.address) === SYNTHETIC_NATIVE) {
      sawSynthetic = true;
      if (from === w) nativeDelta -= amount;
      if (to === w) nativeDelta += amount;
      continue;
    }
    const token = lc(log.address);
    let d = tokenDeltas.get(token) || 0n;
    if (from === w) d -= amount;
    if (to === w) d += amount;
    tokenDeltas.set(token, d);
  }
  return { nativeDelta, tokenDeltas, allowanceDeltas, sawSynthetic };
}

// Simulate the pending call. `walletNativeBalance` is the wallet's real
// balance; a state override tops it up inside the simulation only when
// it could not cover value + headroom, so underfunded previews still
// simulate (the real wallet is never touched — this is read-only).
async function simulatePending(preview, walletNativeBalance) {
  const value = BigInt(preview.value || "0");
  const overrides = {};
  const headroom = value + 2000000000000000000n; // value + 2 BNB headroom
  if (walletNativeBalance !== null && walletNativeBalance < headroom) {
    overrides[lc(preview.from)] = { balance: rpc.toHex(headroom) };
  }
  const call = {
    from: preview.from,
    to: preview.to,
    value: rpc.toHex(value),
    data: preview.data || "0x",
  };
  const sim = await rpc.simulateV1([call], overrides);
  if (sim && Array.isArray(sim) && sim[0] && Array.isArray(sim[0].calls) && sim[0].calls[0]) {
    const c = sim[0].calls[0];
    const ok = c.status === "0x1";
    let errStr = null;
    if (!ok) {
      if (typeof c.error === "string") errStr = c.error;
      else if (c.error && typeof c.error === "object") errStr = c.error.message || JSON.stringify(c.error);
      else errStr = "execution reverted";
    }
    return {
      method: "eth_simulateV1",
      status: ok ? "success" : "revert",
      returnData: c.returnData || "0x",
      logs: c.logs || [],
      error: errStr,
      effectsPartial: false,
    };
  }
  // Fallback: plain eth_call (status only; no logs on public endpoints).
  try {
    const returnData = await rpc.call({
      from: preview.from,
      to: preview.to,
      value,
      data: preview.data || "0x",
    });
    return { method: "eth_call", status: "success", returnData, logs: [], error: null, effectsPartial: true };
  } catch (e) {
    const isRevert = /revert/i.test(e.message) || e.rpcCode === 3 || e.rpcCode === -32000;
    return {
      method: "eth_call",
      status: isRevert ? "revert" : "error",
      returnData: "0x",
      logs: [],
      error: e.message,
      effectsPartial: true,
    };
  }
}

// Sell-path / transfer-fee probe (B05/B07/W03): in one simulated block,
// transfer `amount` of `token` from the wallet to the pair, then read
// the pair's token balance inside the same block. received = post - pre
// (pre read at the latest real block). Detects blocked sell paths and
// measures the effective transfer tax on the sell leg.
async function probeSellTransfer({ from, token, pair, amount }) {
  const { ethers } = require("ethers");
  const tokenIface = new ethers.utils.Interface([
    "function transfer(address to, uint256 amount) returns (bool)",
    "function balanceOf(address account) view returns (uint256)",
  ]);
  let pairBefore;
  try {
    const res = await rpc.call({ to: token, data: tokenIface.encodeFunctionData("balanceOf", [pair]) });
    pairBefore = BigInt(res);
  } catch (e) {
    return { ran: false, reason: `pair balance read failed: ${e.message}` };
  }
  const calls = [
    { from, to: token, value: "0x0", data: tokenIface.encodeFunctionData("transfer", [pair, amount.toString()]) },
    { from, to: token, value: "0x0", data: tokenIface.encodeFunctionData("balanceOf", [pair]) },
  ];
  const sim = await rpc.simulateV1(calls, {});
  if (!sim || !sim[0] || !sim[0].calls || sim[0].calls.length < 2) {
    return { ran: false, reason: "eth_simulateV1 unavailable for probe" };
  }
  const [transferCall, balanceCall] = sim[0].calls;
  if (transferCall.status !== "0x1") {
    return { ran: true, transferOk: false, received: "0", feeBps: null, error: transferCall.error || "transfer reverted" };
  }
  if (balanceCall.status !== "0x1" || !balanceCall.returnData || balanceCall.returnData === "0x") {
    return { ran: false, reason: "post-transfer pair balance read failed in simulation" };
  }
  const pairAfter = BigInt(balanceCall.returnData);
  const received = pairAfter - pairBefore;
  const amt = BigInt(amount);
  const feeBps = amt > 0n ? Number(((amt - received) * 10000n) / amt) : null;
  return {
    ran: true,
    transferOk: true,
    received: received.toString(),
    feeBps,
    error: null,
  };
}

module.exports = { simulatePending, extractEffects, probeSellTransfer, TRANSFER_TOPIC, ZERO };
