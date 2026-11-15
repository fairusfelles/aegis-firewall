// Probe/register the VerdictCommit verification key with Kurier testnet.
// Usage: KURIER_API_KEY=<key> node scripts/kurier_register.js
// Writes the RAW response body to build/kurier_register_vk_response.json
// and prints it verbatim.
const fs = require("fs");
const path = require("path");

const API_URL = "https://api-testnet.kurier.xyz/api/v1";
const API_KEY = process.env.KURIER_API_KEY || "";

(async () => {
  const vk = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "build", "verification_key.json"), "utf-8")
  );
  const params = {
    proofType: "groth16",
    proofOptions: { library: "snarkjs", curve: "bn128" },
    vk,
  };
  const res = await fetch(`${API_URL}/register-vk/${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  console.log("HTTP status:", res.status);
  console.log("RAW RESPONSE BODY:");
  console.log(text);
  fs.writeFileSync(
    path.join(__dirname, "..", "build", "kurier_register_vk_response.json"),
    text
  );
})();
