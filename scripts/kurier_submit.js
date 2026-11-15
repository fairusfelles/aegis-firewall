// Submit the VerdictCommit proof to Kurier testnet and poll to Finalized.
// Prereq: scripts/kurier_register.js has run and its RAW response saved to
// build/kurier_register_vk_response.json (contains the vkHash).
// Usage: KURIER_API_KEY=<key> node scripts/kurier_submit.js
// Writes RAW submit + final job-status bodies to build/ and prints them.
const fs = require("fs");
const path = require("path");

const API_URL = "https://api-testnet.kurier.xyz/api/v1";
const API_KEY = process.env.KURIER_API_KEY || "";
const B = (...p) => path.join(__dirname, "..", "build", ...p);

(async () => {
  const reg = JSON.parse(fs.readFileSync(B("kurier_register_vk_response.json"), "utf-8"));
  const vkHash = reg.vkHash || (reg.meta && reg.meta.vkHash);
  if (!vkHash) throw new Error("No vkHash in register-vk response — register first.");

  const proof = JSON.parse(fs.readFileSync(B("proof.json"), "utf-8"));
  const publicSignals = JSON.parse(fs.readFileSync(B("public.json"), "utf-8"));

  const params = {
    proofType: "groth16",
    vkRegistered: true,
    proofOptions: { library: "snarkjs", curve: "bn128" },
    proofData: { proof, publicSignals, vk: vkHash },
  };

  const subRes = await fetch(`${API_URL}/submit-proof/${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const subText = await subRes.text();
  console.log("submit-proof HTTP status:", subRes.status);
  console.log("RAW submit-proof RESPONSE BODY:");
  console.log(subText);
  fs.writeFileSync(B("kurier_submit_response.json"), subText);

  const sub = JSON.parse(subText);
  if (sub.optimisticVerify !== "success") {
    throw new Error("optimisticVerify != success — see raw body above.");
  }

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const stRes = await fetch(`${API_URL}/job-status/${API_KEY}/${sub.jobId}`);
    const stText = await stRes.text();
    console.log("job-status:", stText);
    const st = JSON.parse(stText);
    if (st.status === "Finalized") {
      fs.writeFileSync(B("kurier_job_finalized.json"), stText);
      console.log("FINALIZED. Proof reference (txHash):", st.txHash);
      return;
    }
    if (st.status === "Failed") throw new Error("Kurier job Failed — see raw body above.");
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("Timed out after 10 minutes waiting for Finalized.");
})();
