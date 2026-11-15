// Generate a THROWAWAY Volta testnet account for the AEGIS spike.
// The mnemonic is written ONLY to .secrets/volta.json (mode 600, gitignored)
// and is never printed. Only the public address is printed.
const { Keyring } = require("@polkadot/keyring");
const { mnemonicGenerate, cryptoWaitReady } = require("@polkadot/util-crypto");
const fs = require("fs");
const path = require("path");

(async () => {
  await cryptoWaitReady();
  const mnemonic = mnemonicGenerate();
  const keyring = new Keyring({ type: "sr25519" });
  const pair = keyring.addFromMnemonic(mnemonic);
  const dir = path.join(__dirname, "..", ".secrets");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "volta.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ address: pair.address, mnemonic }, null, 2),
    { mode: 0o600 }
  );
  fs.chmodSync(file, 0o600);
  console.log("Volta throwaway address:", pair.address);
  console.log("Secret stored at .secrets/volta.json (mode 600, not printed).");
})();
