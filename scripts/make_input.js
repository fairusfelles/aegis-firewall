// Build the spike input for VerdictCommit and compute the Poseidon
// commitment off-chain with circomlibjs (same Poseidon parameters as
// circomlib's circuits/poseidon.circom, so the in-circuit hash matches).
const { buildPoseidon } = require("circomlibjs");
const fs = require("fs");
const path = require("path");

(async () => {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  // Dummy canonical verdict-report fields (opaque field elements).
  // Semantic stand-ins for: [reportVersion, chainId, walletHash,
  // contractHash, simulationHash, timestampBlock]
  const fields = ["1", "56", "123456789", "987654321", "555555555", "1700000000"];
  const verdict = "2"; // BLOCK

  const commitment = F.toString(poseidon([...fields, verdict]));

  const input = { fields, verdict, commitment };
  const out = path.join(__dirname, "..", "build", "input.json");
  fs.writeFileSync(out, JSON.stringify(input, null, 2));
  console.log("commitment =", commitment);
  console.log("wrote", out);
})();
