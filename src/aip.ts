/**
 * aip.ts — Real AIP (Author Identity Protocol) signature verification.
 *
 * AIP (15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva) lets an author cryptographically
 * sign the OP_RETURN data that precedes the AIP block, proving control of a
 * Bitcoin address. The parser extracts the *claimed* signing address from the
 * AIP block — this module actually VERIFIES the ECDSA signature against that
 * claim, so a forged `signer` field can be detected.
 *
 * Only the generic `BITCOIN_ECDSA` algorithm is implemented here. The signing
 * scheme is Bitcoin-Signed-Message (BSM) style ECDSA: the signature is a
 * 65-byte compact signature (recovery-header || R || S), base64-encoded, over
 * the magicHash (double-SHA256 of the BSM-prefixed preimage).
 *
 * Preimage construction (mirrors the proven Go indexer EXACTLY):
 *   - The preimage is the concatenation of the *content bytes* of every chunk
 *     from index 0 up to and including the claimed signing-address chunk
 *     (i.e. chunks[0 .. aipStartIdx + 2]).
 *   - "Content bytes" means the decoded pushdata payload only — pushdata
 *     length prefixes (0x4c/0x4d/0x4e and direct-push opcodes) are NOT part of
 *     the preimage.
 *   - This therefore INCLUDES: the leading B/MAP protocol pushes, every data
 *     push, the pipe protocol-separators (each a single 0x7c byte pushed as
 *     1-byte data), the AIP protocol-prefix push (15Pci...), the
 *     "BITCOIN_ECDSA" algorithm push, and the signing-address push.
 *   - It EXCLUDES the signature push itself (chunks[aipStartIdx + 3]) — that
 *     is what we are verifying — and the OP_FALSE OP_RETURN script prefix
 *     (the `006a` bytes), which never becomes a chunk.
 *
 * Verification recovers the public key from the compact signature (using the
 * recovery id encoded in the signature header byte), derives its P2PKH
 * address, and checks it equals the claimed signing address. Some Bitcom
 * variants put a compressed pubkey hex in the signing-address field instead of
 * a P2PKH address — both shapes are matched.
 */

import { BSM, Signature, PublicKey, BigNumber } from "@bsv/sdk";
import type { Chunk } from "./parser.js";

/** AIP protocol prefix address. */
export const AIP_PROTOCOL = "15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva";

/** Result of verifying an AIP block against its claimed signer. */
export interface AipVerifyResult {
  /** True iff the recovered key matches the claimed signing address/pubkey. */
  verified: boolean;
  /** The claimed signing address (or pubkey hex) taken from the AIP block. */
  claimedSigner: string;
  /**
   * The address derived from the recovered public key, or null if the
   * signature could not be parsed / recovered. Useful for debugging a
   * mismatch between claimed and actual signer.
   */
  recoveredAddress: string | null;
}

/** Decode a hex string into a byte array. Returns null on malformed input. */
const hexToBytes = (hex: string): number[] | null => {
  if (hex.length % 2 !== 0) return null;
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    const b = parseInt(hex.substring(i, i + 2), 16);
    if (Number.isNaN(b)) return null;
    out.push(b);
  }
  return out;
};

/** Decode a standard base64 string into a byte array. Returns null on error. */
const base64ToBytes = (b64: string): number[] | null => {
  try {
    return [...Buffer.from(b64, "base64")];
  } catch {
    return null;
  }
};

/**
 * Build the AIP signing preimage from the parsed chunks.
 *
 * Concatenates the decoded content bytes of chunks[0 .. aipStartIdx + 2]
 * inclusive (B/MAP pushes, separators, AIP prefix, algorithm, signing
 * address) — but NOT the signature push and NOT the pushdata length prefixes.
 *
 * @param chunks      All parsed OP_RETURN chunks for the output.
 * @param aipStartIdx Index of the AIP protocol-prefix push within `chunks`.
 * @returns The preimage bytes, or null if any chunk hex is malformed.
 */
export const buildAipPreimage = (
  chunks: Chunk[],
  aipStartIdx: number,
): number[] | null => {
  if (aipStartIdx + 2 >= chunks.length) return null;
  const preimage: number[] = [];
  for (let i = 0; i <= aipStartIdx + 2; i++) {
    const bytes = hexToBytes(chunks[i].hex);
    if (bytes === null) return null;
    preimage.push(...bytes);
  }
  return preimage;
};

/**
 * Verify a generic BITCOIN_ECDSA AIP block.
 *
 * Layout expected at `aipStartIdx`:
 *   chunks[aipStartIdx + 0] = AIP_PROTOCOL ("15Pci...")
 *   chunks[aipStartIdx + 1] = "BITCOIN_ECDSA"
 *   chunks[aipStartIdx + 2] = signing address (or compressed pubkey hex)
 *   chunks[aipStartIdx + 3] = base64(65-byte compact signature)
 *
 * @returns An {@link AipVerifyResult}. `verified` is false for any malformed
 *   block, unparseable signature, or address mismatch.
 */
export const verifyAip = (
  chunks: Chunk[],
  aipStartIdx: number,
): AipVerifyResult => {
  const fail = (claimed: string): AipVerifyResult => ({
    verified: false,
    claimedSigner: claimed,
    recoveredAddress: null,
  });

  // Need algorithm, signing address, and signature pushes present.
  if (aipStartIdx + 3 >= chunks.length) return fail("");
  if (chunks[aipStartIdx + 1].str !== "BITCOIN_ECDSA") {
    return fail(chunks[aipStartIdx + 2]?.str ?? "");
  }

  const claimedSigner = chunks[aipStartIdx + 2].str;
  const sigB64 = chunks[aipStartIdx + 3].str;

  const preimage = buildAipPreimage(chunks, aipStartIdx);
  if (preimage === null) return fail(claimedSigner);

  const sigBytes = base64ToBytes(sigB64);
  // Compact BSM signature is exactly 65 bytes: header(1) || R(32) || S(32).
  if (sigBytes === null || sigBytes.length !== 65) return fail(claimedSigner);

  // Recovery id lives in the low 2 bits of (header - 27); the +4 marks a
  // compressed pubkey. This matches @bsv/sdk's BSM.sign / Signature.toCompact
  // encoding and bec.RecoverCompact in the Go reference.
  const header = sigBytes[0];
  if (header < 27 || header >= 35) return fail(claimedSigner);
  const recovery = (header - 27) & 3;

  let recoveredAddress: string | null = null;
  try {
    const sig = Signature.fromCompact(sigBytes, undefined);
    // magicHash = double-SHA256 of the BSM-prefixed preimage (matches Go bsmDigest).
    const digest = new BigNumber(BSM.magicHash(preimage));
    const recoveredPub: PublicKey = sig.RecoverPublicKey(recovery, digest);
    recoveredAddress = recoveredPub.toAddress(); // mainnet P2PKH (version 0x00)

    // Some Bitcom variants carry a compressed pubkey hex (66 chars, 02/03
    // prefix) in the signing-address field rather than a P2PKH address.
    if (
      claimedSigner.length === 66 &&
      (claimedSigner.startsWith("02") || claimedSigner.startsWith("03"))
    ) {
      const recoveredPubHex = recoveredPub.toDER("hex") as string;
      return {
        verified: recoveredPubHex === claimedSigner,
        claimedSigner,
        recoveredAddress,
      };
    }

    return {
      verified: recoveredAddress === claimedSigner,
      claimedSigner,
      recoveredAddress,
    };
  } catch {
    return { verified: false, claimedSigner, recoveredAddress };
  }
};
