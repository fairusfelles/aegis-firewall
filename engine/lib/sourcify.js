"use strict";
// Sourcify (https://sourcify.dev) — free, no API key. Used for
// source-verification status, ABI and verified sources (the SRC and META
// data sources of docs/POLICY.md). Fails gracefully: any transport error
// yields status "unknown", which the rules treat fail-closed.

const BASE = process.env.AEGIS_SOURCIFY_URL || "https://sourcify.dev/server";
const cache = new Map();

async function fetchJson(url, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "aegis-engine/1.0", accept: "application/json" },
      signal: ctrl.signal,
    });
    if (res.status === 404) return { notFound: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Returns:
//   { status: "verified", match, name, abi, sources }  — sources: {path: content}
//   { status: "unverified" }                            — Sourcify has no match (definitive)
//   { status: "unknown" }                               — Sourcify unreachable / errored
async function fetchContract(chainId, address) {
  const key = `${chainId}:${address.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);
  let out;
  try {
    const status = await fetchJson(`${BASE}/v2/contract/${chainId}/${address}`);
    if (status.notFound || !status.match) {
      out = { status: "unverified" };
    } else {
      const full = await fetchJson(
        `${BASE}/v2/contract/${chainId}/${address}?fields=abi,sources,compilation`
      );
      const sources = {};
      if (full.sources) {
        for (const [path, entry] of Object.entries(full.sources)) {
          if (entry && typeof entry.content === "string") sources[path] = entry.content;
        }
      }
      out = {
        status: "verified",
        match: status.match,
        name: (full.compilation && full.compilation.name) || null,
        abi: Array.isArray(full.abi) ? full.abi : [],
        sources,
      };
    }
  } catch {
    out = { status: "unknown" };
  }
  cache.set(key, out);
  return out;
}

// Verification status only (cheap, no source download).
async function verificationStatus(chainId, address) {
  const key = `${chainId}:${address.toLowerCase()}:status`;
  if (cache.has(key)) return cache.get(key);
  let out;
  try {
    const status = await fetchJson(`${BASE}/v2/contract/${chainId}/${address}`);
    out = status.notFound || !status.match ? "unverified" : "verified";
  } catch {
    out = "unknown";
  }
  cache.set(key, out);
  return out;
}

module.exports = { fetchContract, verificationStatus };
