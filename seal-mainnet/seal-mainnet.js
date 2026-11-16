// AEGIS — seal the RuninAI verdict proof on zkVerify via Kurier MAINNET.
// Runs on the operator's own device (Termux). The API key is read from a
// local key.txt in this folder and is only ever sent to api.kurier.xyz.
// Usage: node seal-mainnet.js
// Outputs: register.json, submit.json, finalized.json + printed summary.
const fs = require("fs");
const path = require("path");

const API = "https://api.kurier.xyz/api/v1";
const D = (...p) => path.join(__dirname, ...p);

const key = fs.readFileSync(D("key.txt"), "utf-8").trim();
if (!key) {
  console.error("key.txt is empty — paste your Kurier MAINNET API key into key.txt first.");
  process.exit(1);
}

async function main() {
  // 1. Register the VerdictCommit verification key.
  const vk = JSON.parse(fs.readFileSync(D("verification_key.json"), "utf-8"));
  const regRes = await fetch(`${API}/register-vk/${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      proofType: "groth16",
      proofOptions: { library: "snarkjs", curve: "bn128" },
      vk,
    }),
  });
  const regText = await regRes.text();
  fs.writeFileSync(D("register.json"), regText);
  console.log("register-vk HTTP", regRes.status);
  console.log(regText);
  if (regRes.status !== 200) {
    console.error("register-vk failed — stopping.");
    process.exit(1);
  }
  const reg = JSON.parse(regText);
  const vkHash = reg.vkHash || (reg.meta && reg.meta.vkHash);
  if (!vkHash) {
    console.error("No vkHash in register response — stopping. Send register.json to Muse.");
    process.exit(1);
  }
  console.log("vkHash:", vkHash);

  // 2. Submit the RuninAI verdict proof.
  const proof = JSON.parse(fs.readFileSync(D("runinai_proof.json"), "utf-8"));
  const publicSignals = JSON.parse(fs.readFileSync(D("runinai_public.json"), "utf-8"));
  const subRes = await fetch(`${API}/submit-proof/${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      proofType: "groth16",
      vkRegistered: true,
      proofOptions: { library: "snarkjs", curve: "bn128" },
      proofData: { proof, publicSignals, vk: vkHash },
    }),
  });
  const subText = await subRes.text();
  fs.writeFileSync(D("submit.json"), subText);
  console.log("submit-proof HTTP", subRes.status);
  console.log(subText);
  if (subRes.status !== 200) {
    console.error("submit-proof failed — stopping.");
    process.exit(1);
  }
  const sub = JSON.parse(subText);
  console.log("optimisticVerify:", sub.optimisticVerify, "| jobId:", sub.jobId);
  if (sub.optimisticVerify !== "success" || !sub.jobId) {
    console.error("Unexpected submit response — stopping. Send submit.json to Muse.");
    process.exit(1);
  }

  // 3. Poll job-status until Finalized (max 10 minutes).
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const stRes = await fetch(`${API}/job-status/${key}/${sub.jobId}`);
    const stText = await stRes.text();
    console.log("job-status:", stText);
    const st = JSON.parse(stText);
    if (st.status === "Finalized") {
      fs.writeFileSync(D("finalized.json"), stText);
      console.log("=== FINALIZED ===");
      console.log("txHash:", st.txHash);
      console.log("Send this txHash (or a screenshot of this screen) to Muse.");
      return;
    }
    if (st.status === "Failed") {
      console.error("Kurier job Failed — send the job-status line above to Muse.");
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.error("Timed out after 10 minutes — send the last job-status line to Muse.");
  process.exit(1);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
