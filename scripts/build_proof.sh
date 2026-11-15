#!/usr/bin/env bash
# AEGIS — regenerate every proof artifact from the committed circuit source.
# Toolchain: circom 2.1.9 (iden3/circom release binary, linux-amd64),
# Node 24, snarkjs + circomlib + circomlibjs (package.json / package-lock).
#
# One-time toolchain fetch (binary lands in tools/, gitignored):
#   mkdir -p tools
#   curl -sL -o tools/circom https://github.com/iden3/circom/releases/download/v2.1.9/circom-linux-amd64
#   chmod +x tools/circom
#   npm ci
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build

# 1. Compile the authored circuit -> r1cs + wasm witness generator.
./tools/circom circuits/verdict_commit.circom --r1cs --wasm --sym -o build

# 2. Powers of tau (pot12). The public hermez S3 file returned
#    AccessDenied during the spike, so a local ceremony is used:
#    new -> contribute -> prepare phase2.
npx snarkjs powersoftau new bn128 12 build/pot12_0000.ptau
echo "aegis-spike-entropy" | npx snarkjs powersoftau contribute \
  build/pot12_0000.ptau build/pot12_0001.ptau --name="AEGIS spike"
npx snarkjs powersoftau prepare phase2 build/pot12_0001.ptau build/pot12_final.ptau

# 3. Groth16 setup + phase-2 contribution + verification key export.
npx snarkjs groth16 setup build/verdict_commit.r1cs build/pot12_final.ptau \
  build/verdict_commit_0000.zkey
echo "aegis-spike-phase2-entropy" | npx snarkjs zkey contribute \
  build/verdict_commit_0000.zkey build/verdict_commit_final.zkey --name="AEGIS spike"
npx snarkjs zkey export verificationkey \
  build/verdict_commit_final.zkey build/verification_key.json

# 4. Dummy verdict-report input + Poseidon commitment (circomlibjs).
node scripts/make_input.js

# 5. Witness, proof, and LOCAL verification (must print "snarkJS: OK!").
node build/verdict_commit_js/generate_witness.js \
  build/verdict_commit_js/verdict_commit.wasm build/input.json build/witness.wtns
npx snarkjs groth16 prove build/verdict_commit_final.zkey build/witness.wtns \
  build/proof.json build/public.json
npx snarkjs groth16 verify build/verification_key.json build/public.json build/proof.json
