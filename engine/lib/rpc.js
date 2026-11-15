"use strict";
// Minimal JSON-RPC client with endpoint failover (read-only methods only).
// No private keys, no signing, no transaction submission anywhere in the
// engine — this client only ever reads chain state and simulates calls.

// Order matters for historical reads: publicnode retains ~1-2 h of
// state while the Binance seed nodes prune within ~2,000 blocks
// (measured 2026-11-16). All three serve current state equally.
const DEFAULT_ENDPOINTS = [
  "https://bsc.publicnode.com",
  "https://bsc-dataseed.binance.org",
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
      // Fail over when the failure is endpoint-specific: method not
      // available (-32601) or pruned state (-32000 "missing trie node"
      // on historical reads — another endpoint may hold the archive).
      // Execution reverts are deterministic across endpoints: rethrow.
      const failoverable =
        e.rpcCode === undefined ||
        e.rpcCode === -32601 ||
        /not (available|exist)/i.test(e.message) ||
        (e.rpcCode === -32000 && !/revert/i.test(e.message));
      if (!failoverable) throw e;
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

// The endpoints' state-retention boundary (oldest readable block).
// Readability is monotonic in block height — pruning removes old state
// first — so the boundary is found by exponential bracketing +
// binary search, and cached per process (it is a property of the
// endpoints, not of any contract; a stale cache can only degrade the
// age bound toward "unknown", never toward a false "not fresh").
let boundaryCache = null;
async function retentionBoundary(latest, readable) {
  if (boundaryCache && Math.abs(latest - boundaryCache.forLatest) < 100000)
    return boundaryCache.oldestReadable;
  let offset = 8192;
  let deepest = latest; // deepest block proven readable
  while (latest - offset >= 1 && (await readable(latest - offset))) {
    deepest = latest - offset;
    offset *= 2;
  }
  let result;
  if (latest - offset < 1) {
    result = 1; // everything readable back to genesis
  } else {
    // Boundary lies in (latest - offset, deepest].
    let lo = latest - offset + 1;
    let hi = deepest;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await readable(mid)) hi = mid;
      else lo = mid + 1;
    }
    result = lo;
  }
  boundaryCache = { forLatest: latest, oldestReadable: result };
  return result;
}

// Locate a contract's creation block via eth_getCode probes. Public
// BSC endpoints prune state (no free archive), so the search is
// bounded by the state-retention window:
//   - { creationBlock }  — exact first block with code, when creation
//     happened inside the readable window;
//   - { existedByBlock } — the contract already had code at the oldest
//     readable block: a sound lower bound on its age (all the B10
//     freshness rule needs for anything older than the window);
//   - both null when neither can be shown.
async function findCreationBlock(address, latest) {
  const codeAt = async (n) => {
    const c = await getCode(address, n);
    return c && c !== "0x";
  };
  // A block counts as readable when ANY endpoint can serve its state
  // (full failover); the endpoint order above puts the deepest
  // retention first, so historical probes usually succeed at once.
  const readable = async (n) => {
    try {
      await getCode(address, n);
      return true;
    } catch {
      return false;
    }
  };
  if (!(await codeAt(latest))) return { creationBlock: null, existedByBlock: null };
  const oldestReadable = await retentionBoundary(latest, readable);
  // existedBy is claimed only when a code read at the boundary block
  // succeeds right now — that read is the proof.
  let existed;
  try {
    existed = await codeAt(oldestReadable);
  } catch {
    return { creationBlock: null, existedByBlock: null };
  }
  if (existed) return { creationBlock: null, existedByBlock: oldestReadable };
  // Creation is inside (oldestReadable, latest]: binary-search it.
  // Probe errors are treated as "no code": public endpoints are
  // load-balanced fleets with uneven pruning, so a transient
  // missing-state error can only push the found creation block later
  // (age underestimated) — the fail-safe direction for a freshness rule.
  const codeAtSafe = async (n) => {
    try {
      return await codeAt(n);
    } catch {
      return false;
    }
  };
  let lo2 = oldestReadable + 1;
  let hi2 = latest;
  while (lo2 < hi2) {
    const mid = Math.floor((lo2 + hi2) / 2);
    if (await codeAtSafe(mid)) hi2 = mid;
    else lo2 = mid + 1;
  }
  return { creationBlock: lo2, existedByBlock: null };
}

module.exports = {
  rpc,
  rpcOnce,
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
