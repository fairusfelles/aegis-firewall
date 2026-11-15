pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";

/*
 * VerdictCommit — AEGIS verdict-commitment circuit (Groth16 / BN128).
 *
 * Proves knowledge of the six private field elements of a canonical
 * verdict report (fields[0..5]) plus the public verdict, such that the
 * public commitment equals Poseidon(fields[0..5], verdict).
 *
 * Anyone can later be shown the report fields and check the commitment
 * off-chain; the proof itself reveals nothing about the fields beyond
 * the verdict and the commitment.
 *
 * Public inputs (in circuit declaration order):
 *   - verdict     (output ordering: public signals are emitted by snarkjs
 *                  in the order [outputs..., public inputs...]; here the
 *                  only declared public inputs are `verdict` and
 *                  `commitment`, both declared `public` below.)
 *   - commitment
 */
template VerdictCommit() {
    // Private: canonical verdict-report fields (opaque field elements).
    signal input fields[6];

    // Public: the verdict code (0 = ALLOW, 1 = WARN, 2 = BLOCK).
    signal input verdict;
    // Public: Poseidon commitment over the fields and the verdict.
    signal input commitment;

    component hasher = Poseidon(7);
    hasher.inputs[0] <== fields[0];
    hasher.inputs[1] <== fields[1];
    hasher.inputs[2] <== fields[2];
    hasher.inputs[3] <== fields[3];
    hasher.inputs[4] <== fields[4];
    hasher.inputs[5] <== fields[5];
    hasher.inputs[6] <== verdict;

    commitment === hasher.out;
}

component main { public [verdict, commitment] } = VerdictCommit();
