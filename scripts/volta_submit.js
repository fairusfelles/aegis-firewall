// AEGIS spike — FALLBACK path: submit the VerdictCommit Groth16 proof
// directly to the Volta testnet via zkVerifyJS using the LOCALLY GENERATED
// throwaway account in .secrets/volta.json (testnet only; the mnemonic is
// read from disk and never printed).
//
// Usage: node scripts/volta_submit.js [--balance-only]
const fs = require("fs");
const path = require("path");
const { zkVerifySession, Library, CurveType } = require("zkverifyjs");

(async () => {
  const secret = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", ".secrets", "volta.json"), "utf-8")
  );
  const session = await zkVerifySession.start().Volta().withAccount(secret.mnemonic);
  const address = secret.address; // stored at generation time (scripts/gen_volta_account.js)
  console.log("account:", address);

  const balance = await session.api.query.system.account(address);
  console.log("RAW system.account:", JSON.stringify(balance.toHuman()));

  if (process.argv.includes("--balance-only")) {
    await session.close();
    return;
  }

  const vk = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "build", "verification_key.json"), "utf-8")
  );
  const proof = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "build", "proof.json"), "utf-8")
  );
  const publicSignals = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "build", "public.json"), "utf-8")
  );

  const result = await session
    .verify()
    .groth16({ library: Library.snarkjs, curve: CurveType.bn128 })
    .execute({ proofData: { vk, proof, publicSignals }, domainId: 0 });

  console.log("RAW verify result:");
  console.log(JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(__dirname, "..", "build", "volta_verify_result.json"),
    JSON.stringify(result, null, 2)
  );
  await session.close();
})().catch((e) => {
  console.error("ERROR:", e.message || e);
  process.exit(1);
});
