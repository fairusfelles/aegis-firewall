"use strict";
// Calldata decoding (POLICY pipeline stage 1, data source CD).
// Tries the target's verified ABI first (precise names for application
// calls like claimFreeShare()), then a generic interface covering the
// ERC20 / permit / NFT-approval / WBNB / PancakeSwap-router surface.

const { ethers } = require("ethers");

const GENERIC_ABI = [
  // ERC20
  "function approve(address spender, uint256 amount) returns (bool)",
  "function increaseAllowance(address spender, uint256 addedValue) returns (bool)",
  "function decreaseAllowance(address spender, uint256 subtractedValue) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  // ERC-2612 permit + DAI-style permit
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function permit(address holder, address spender, uint256 nonce, uint256 expiry, bool allowed, uint8 v, bytes32 r, bytes32 s)",
  // ERC721 / ERC1155 operator approval
  "function setApprovalForAll(address operator, bool approved)",
  // WBNB
  "function deposit() payable",
  "function withdraw(uint256 wad)",
  // PancakeSwap V2 router
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapTokensForExactETH(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapETHForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)",
  "function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)",
];

const genericIface = new ethers.utils.Interface(GENERIC_ABI);

const SWAP_NAMES = new Set(
  GENERIC_ABI.filter((s) => s.includes("swap")).map((s) => s.split(" ")[1].split("(")[0])
);

function selectorOf(data) {
  if (!data || data === "0x" || data.length < 10) return 0;
  return parseInt(data.slice(2, 10), 16);
}

function tryParse(iface, data, value) {
  try {
    const p = iface.parseTransaction({ data, value });
    const args = {};
    p.functionFragment.inputs.forEach((input, i) => {
      const v = p.args[i];
      args[input.name || `arg${i}`] = ethers.BigNumber.isBigNumber(v) ? v.toString() : v;
    });
    return { name: p.name, signature: p.signature, args };
  } catch {
    return null;
  }
}

// Decode a preview's calldata. `targetAbi` is the verified ABI of the
// target contract when available (may be null).
function decodeCall(data, value, targetAbi) {
  const selector = selectorOf(data);
  const base = {
    selector,
    selectorHex: "0x" + selector.toString(16).padStart(8, "0"),
    name: null,
    signature: null,
    args: {},
    kind: "generic",
  };
  if (!data || data === "0x") {
    base.kind = "native-transfer";
    return base;
  }
  let parsed = null;
  if (targetAbi && targetAbi.length) {
    try {
      parsed = tryParse(new ethers.utils.Interface(targetAbi), data, value);
    } catch {
      parsed = null;
    }
  }
  if (!parsed) parsed = tryParse(genericIface, data, value);
  if (!parsed) return base;

  base.name = parsed.name;
  base.signature = parsed.signature;
  base.args = parsed.args;

  const n = parsed.name;
  if (n === "approve" || n === "increaseAllowance" || n === "decreaseAllowance") base.kind = n;
  else if (n === "permit") base.kind = "permit";
  else if (n === "setApprovalForAll") base.kind = "setApprovalForAll";
  else if (n === "transfer" || n === "transferFrom") base.kind = n;
  else if (SWAP_NAMES.has(n)) base.kind = "swap";
  else if (n === "addLiquidity" || n === "addLiquidityETH") base.kind = "addLiquidity";
  else if (n === "deposit" || n === "withdraw") base.kind = n;
  else base.kind = "generic";

  if (base.kind === "swap" && Array.isArray(parsed.args.path)) {
    const path = parsed.args.path;
    base.swap = {
      tokenIn: path[0],
      tokenOut: path[path.length - 1],
      path,
      recipient: parsed.args.to || null,
    };
  }
  return base;
}

module.exports = { decodeCall, selectorOf, GENERIC_ABI };
