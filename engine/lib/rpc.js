"use strict";
// Minimal JSON-RPC client with endpoint failover (read-only methods only).
// No private keys, no signing, no transaction submission anywhere in the
// engine — this client only ever reads chain state and simulates calls.

const DEFAULT_ENDPOINTS = [
  "https://bsc-dataseed.binance.org",
  "https://bsc.publicnode.com",
  "https://bsc-dataseed1.bnbchain.org",
];

function endpoints() {
  const env = process.env.AEGIS_RPC_URLS || process.env.AEGIS_RPC_URL;
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
  return DEFAULT_ENDPOINTS;
}

let idCounter = 1;

async function rpcOnce(url, method, params, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "aegis-engine/1.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: idCounter++, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) {
      const e = new Error(body.error.message || "RPC error");
      e.rpcCode = body.error.code;
      e.rpcData = body.error.data;
      throw e;
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

// Call a method, failing over across endpoints on transport errors.
// JSON-RPC *execution* errors (e.g. an eth_call revert) are returned by
// throwing an error with .rpcCode set — failover also applies to them
// only when the code indicates the method is unavailable (-32601 etc.).
async function rpc(method, params, { timeoutMs = 25000 } = {}) {
  let lastErr = null;
  for (const url of endpoints()) {
    try {
      return await rpcOnce(url, method, params, timeoutMs);
    } catch (e) {
      lastErr = e;
      // Method-not-available on this endpoint: try the next one.
      // Execution reverts are deterministic: rethrow immediately.
      if (e.rpcCode !== undefined && e.rpcCode !== -32601 && !/not (available|exist)/i.test(e.message)) {
        throw e;
      }
    }
  }
  throw lastErr || new Error("all RPC endpoints failed");
}

const toHex = (n) => "0x" + BigInt(n).toString(16);

async function getBlockNumber() {
  return Number(BigInt(await rpc("eth_blockNumber", [])));
}

async function getBlock(n) {
  const b = await rpc("eth_getBlockByNumber", [toHex(n), false]);
  if (!b) return null;
  return { number: Number(BigInt(b.number)), timestamp: Number(BigInt(b.timestamp)) };
}

async function getBalance(address) {
  return BigInt(await rpc("eth_getBalance", [address, "latest"]));
}

async function getCode(address, block = "latest") {
  const tag = block === "latest" ? "latest" : toHex(block);
  return rpc("eth_getCode", [address, tag]);
}

async function getStorageAt(address, slot) {
  return rpc("eth_getStorageAt", [address, slot, "latest"]);
}

// eth_call. Throws (with .rpcCode / revert message) when the call reverts.
async function call({ from, to, value = 0n, data = "0x" }, block = "latest") {
  const tx = { to, data, value: toHex(value) };
  if (from) tx.from = from;
  return rpc("eth_call", [tx, block]);
}

// eth_call that returns null instead of throwing (for optional probes).
async function tryCall(tx, block = "latest") {
  try {
    return await call(tx, block);
  } catch {
    return null;
  }
}

// eth_simulateV1: simulate a sequence of calls in one synthetic block on
// top of the latest state. Returns the raw result array, or null when no
// endpoint supports the method.
async function simulateV1(calls, stateOverrides) {
  const block = { calls };
  if (stateOverrides && Object.keys(stateOverrides).length) block.stateOverrides = stateOverrides;
  try {
    return await rpc("eth_simulateV1", [{ blockStateCalls: [block], traceTransfers: true, validation: false }, "latest"]);
  } catch (e) {
    if (e.rpcCode === -32601 || /does not exist|not available|not supported/i.test(e.message)) return null;
    throw e;
  }
}

// Find the first block at which `address` has code (contract creation
// block) by binary search over eth_getCode. ~27 reads for BSC history.
async function findCreationBlock(address, latest) {
  let lo = 1;
  let hi = latest;
  const codeAt = async (n) => {
    const c = await getCode(address, n);
    return c && c !== "0x";
  };
  if (!(await codeAt(hi))) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await codeAt(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

module.exports = {
  rpc,
  toHex,
  getBlockNumber,
  getBlock,
  getBalance,
  getCode,
  getStorageAt,
  call,
  tryCall,
  simulateV1,
  findCreationBlock,
  endpoints,
};
