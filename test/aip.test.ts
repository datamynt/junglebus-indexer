/**
 * test/aip.test.ts — REAL AIP (BITCOIN_ECDSA) signature verification tests.
 *
 * These do genuine ECDSA: we generate a real secp256k1 key, sign the
 * canonical AIP preimage with @bsv/sdk's BSM, and assert the verifier
 * RECOVERS the signing address and accepts it. The negative cases prove the
 * verifier rejects tampered content, a spoofed signing address, the old
 * sha256(content) "legacy shortcut", and a truncated AIP block — so a passing
 * positive case cannot be faked by hardcoding `true`.
 *
 * Mirrors the proven Go reference (kryp2/peck-indexer-go aip_verify_test.go),
 * including the exact chunk layout and preimage construction.
 */

import { describe, test, expect } from "vitest";
import { PrivateKey, BSM, Hash } from "@bsv/sdk";
import { verifyAip, buildAipPreimage, AIP_PROTOCOL } from "../src/aip.js";
import { PROTOCOLS } from "../src/parser.js";
import type { Chunk } from "../src/parser.js";

const mk = (s: string): Chunk => ({
  hex: Buffer.from(s, "utf8").toString("hex"),
  str: s,
});
const PIPE: Chunk = { hex: "7c", str: "|" };

/**
 * Build the canonical-AIP chunk layout (B | MAP | AIP). Mirrors
 * buildCanonicalChunks() in the Go test. AIP prefix sits at index 14.
 */
const buildCanonicalChunks = (
  content: string,
  app: string,
  contextURN: string,
  signerAddr: string,
  sigB64: string,
): Chunk[] => [
  mk(PROTOCOLS.B),
  mk(content),
  mk("text/markdown"),
  mk("UTF-8"),
  PIPE,
  mk(PROTOCOLS.MAP),
  mk("SET"),
  mk("app"),
  mk(app),
  mk("type"),
  mk("comment"),
  mk("context"),
  mk(contextURN),
  PIPE,
  mk(AIP_PROTOCOL),
  mk("BITCOIN_ECDSA"),
  mk(signerAddr),
  mk(sigB64), // signature push
];

const AIP_IDX = 14; // index of the AIP protocol prefix in the layout above

/** Sign a preimage (byte array) BSM-style and return base64 compact sig. */
const bsmSign = (priv: PrivateKey, preimage: number[]): string =>
  BSM.sign(preimage, priv, "base64") as string;

describe("verifyAip (BITCOIN_ECDSA)", () => {
  test("round-trips a real signature → verified true, recovered address matches", () => {
    const priv = PrivateKey.fromRandom();
    const addr = priv.toPublicKey().toAddress();

    // Build skeleton without sig to compute the preimage, then sign it.
    const skeleton = buildCanonicalChunks(
      "Hello canonical",
      "margin",
      "url:https://example.com/x",
      addr,
      "",
    );
    const preimage = buildAipPreimage(skeleton, AIP_IDX);
    expect(preimage).not.toBeNull();

    const sig = bsmSign(priv, preimage!);
    const chunks = buildCanonicalChunks(
      "Hello canonical",
      "margin",
      "url:https://example.com/x",
      addr,
      sig,
    );

    const res = verifyAip(chunks, AIP_IDX);
    expect(res.verified).toBe(true);
    expect(res.claimedSigner).toBe(addr);
    expect(res.recoveredAddress).toBe(addr);
  });

  test("rejects tampered content (signed original, swapped body)", () => {
    const priv = PrivateKey.fromRandom();
    const addr = priv.toPublicKey().toAddress();

    const skeleton = buildCanonicalChunks(
      "original",
      "margin",
      "url:https://example.com/x",
      addr,
      "",
    );
    const sig = bsmSign(priv, buildAipPreimage(skeleton, AIP_IDX)!);

    const chunks = buildCanonicalChunks(
      "TAMPERED",
      "margin",
      "url:https://example.com/x",
      addr,
      sig,
    );
    expect(verifyAip(chunks, AIP_IDX).verified).toBe(false);
  });

  test("rejects a spoofed signing address", () => {
    const priv = PrivateKey.fromRandom();
    const addr = priv.toPublicKey().toAddress();

    const skeleton = buildCanonicalChunks(
      "hi",
      "margin",
      "url:https://example.com/",
      addr,
      "",
    );
    const sig = bsmSign(priv, buildAipPreimage(skeleton, AIP_IDX)!);

    // Swap in a different address — recovered key won't hash to it.
    const otherAddr = PrivateKey.fromRandom().toPublicKey().toAddress();
    const chunks = buildCanonicalChunks(
      "hi",
      "margin",
      "url:https://example.com/",
      otherAddr,
      sig,
    );
    expect(verifyAip(chunks, AIP_IDX).verified).toBe(false);
  });

  test("rejects the legacy sha256(content) shortcut", () => {
    // Old peck.to convention signed sha256(content), not the canonical
    // preimage. The canonical verifier must reject these by design.
    const priv = PrivateKey.fromRandom();
    const addr = priv.toPublicKey().toAddress();

    const hashed = Hash.sha256([...Buffer.from("legacy post", "utf8")]);
    const sig = bsmSign(priv, hashed);

    const chunks = buildCanonicalChunks(
      "legacy post",
      "margin",
      "url:https://example.com/",
      addr,
      sig,
    );
    expect(verifyAip(chunks, AIP_IDX).verified).toBe(false);
  });

  test("rejects a truncated AIP block (no signature push)", () => {
    const skeleton = buildCanonicalChunks(
      "hi",
      "margin",
      "url:https://example.com/",
      "1abc",
      "",
    );
    const chunks = skeleton.slice(0, skeleton.length - 1); // drop signature
    expect(verifyAip(chunks, AIP_IDX).verified).toBe(false);
  });

  test("matches a compressed-pubkey-hex signer field too", () => {
    const priv = PrivateKey.fromRandom();
    const pubHex = priv.toPublicKey().toDER("hex") as string; // 66-char compressed hex

    const skeleton = buildCanonicalChunks(
      "pubkey variant",
      "margin",
      "url:https://example.com/p",
      pubHex,
      "",
    );
    const sig = bsmSign(priv, buildAipPreimage(skeleton, AIP_IDX)!);
    const chunks = buildCanonicalChunks(
      "pubkey variant",
      "margin",
      "url:https://example.com/p",
      pubHex,
      sig,
    );
    expect(verifyAip(chunks, AIP_IDX).verified).toBe(true);
  });
});
