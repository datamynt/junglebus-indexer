/**
 * parser.ts — OP_RETURN protocol parser for BSV transactions.
 *
 * Extracts structured data from B, MAP, and AIP protocol outputs.
 * These are the standard Bitcoin Schema protocols used across the
 * BSV ecosystem for on-chain data.
 *
 * Protocols:
 *   B   (19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut) — Binary/text content
 *   MAP (1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5) — Structured metadata (key-value)
 *   AIP (15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva) — Author Identity Protocol (ECDSA signature)
 *
 * Thanks to GorillaPool for JungleBus and the Bitcoin Schema ecosystem.
 */

import { verifyAip } from "./aip.js";

/** Canonical Bitcom protocol-prefix addresses. */
export const PROTOCOLS = {
  B: "19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut",
  MAP: "1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5",
  AIP: "15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva",
} as const;

/** A single decoded OP_RETURN pushdata chunk. */
export interface Chunk {
  /** Raw hex of the pushed data payload (no length prefix). */
  hex: string;
  /** UTF-8 interpretation of the payload (may be empty for binary data). */
  str: string;
}

/** B-protocol content extracted from an OP_RETURN output. */
export interface BData {
  /** Decoded text content, or `"HEX:<hex>"` for binary media types. */
  content: string;
  /** Declared media type (defaults to `text/plain`). */
  mediaType: string;
  /** Declared filename, if present. */
  filename: string | null;
}

/**
 * MAP-protocol metadata. Carries the well-known `tags` array plus any
 * arbitrary key/value pairs the transaction emitted (apps decide what they
 * care about).
 */
export interface MapData {
  /** Collected `MAP ADD tags` values. */
  tags: string[];
  /** Any other MAP SET key/value pairs. */
  [key: string]: string | string[] | undefined;
}

/**
 * Result of {@link extractProtocols}: the parsed B/MAP data plus the AIP
 * author identity. `signer` is the *claimed* address (backward compatible);
 * `signerVerified` is the result of actually checking the ECDSA signature.
 */
export interface ExtractedProtocols {
  /** MAP metadata (key/value pairs + `tags`). */
  map: MapData;
  /** B-protocol content. */
  b: BData;
  /** Claimed AIP signing address (or `"unknown"` if no AIP block). */
  signer: string;
  /** True iff the AIP signature was present AND cryptographically verified. */
  signerVerified: boolean;
  /**
   * Address derived from the recovered signature key, or null when no valid
   * AIP signature was verified. When `signerVerified` is true this equals
   * `signer` (or, for pubkey-hex AIP blocks, the address derived from it).
   */
  signerAddress: string | null;
}

/**
 * Parse a hex locking script into data chunks.
 * Handles OP_PUSHDATA1 (0x4c), OP_PUSHDATA2 (0x4d), OP_PUSHDATA4 (0x4e),
 * and direct push opcodes (0x01-0x4b).
 *
 * @param hex - Raw hex string from output.lockingScript.toHex()
 * @returns Decoded chunks
 */
export const parseScript = (hex: string | null | undefined): Chunk[] => {
  if (!hex) return [];
  const chunks: Chunk[] = [];
  let i = 0;

  while (i < hex.length) {
    const byte = parseInt(hex.substring(i, i + 2), 16);
    i += 2;
    let len = 0;
    let dataHex = "";

    if (byte >= 0x01 && byte <= 0x4b) {
      len = byte;
      dataHex = hex.substring(i, i + len * 2);
      i += len * 2;
    } else if (byte === 0x4c) {
      len = parseInt(hex.substring(i, i + 2), 16);
      i += 2;
      dataHex = hex.substring(i, i + len * 2);
      i += len * 2;
    } else if (byte === 0x4d) {
      const lenHex = hex.substring(i, i + 4);
      len = parseInt(lenHex.match(/../g)!.reverse().join(""), 16);
      i += 4;
      dataHex = hex.substring(i, i + len * 2);
      i += len * 2;
    } else if (byte === 0x4e) {
      const lenHex = hex.substring(i, i + 8);
      len = parseInt(lenHex.match(/../g)!.reverse().join(""), 16);
      i += 8;
      dataHex = hex.substring(i, i + len * 2);
      i += len * 2;
    } else {
      continue;
    }

    let dataStr = "";
    try {
      dataStr = Buffer.from(dataHex, "hex").toString("utf8");
    } catch {
      // Binary data — leave str empty
    }
    chunks.push({ hex: dataHex, str: dataStr });
  }

  return chunks;
};

/**
 * Extract B, MAP, and AIP protocol data from parsed chunks.
 *
 * The AIP signature (if present and using `BITCOIN_ECDSA`) is cryptographically
 * verified: the public key is recovered from the signature and its derived
 * address is compared against the claimed signing address. The claimed
 * `signer` is always returned (backward compatible), and `signerVerified`
 * reports whether the signature actually checks out.
 *
 * @param chunks - Decoded OP_RETURN chunks from {@link parseScript}.
 * @returns The extracted protocol data, including verification result.
 */
export const extractProtocols = (chunks: Chunk[]): ExtractedProtocols => {
  const map: MapData = { tags: [] };
  const b: BData = { content: "", mediaType: "text/plain", filename: null };
  let signer = "unknown";
  let signerVerified = false;
  let signerAddress: string | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    // --- B Protocol: content + media type ---
    if (chunk.str === PROTOCOLS.B && chunks[i + 1]) {
      const mimeChunk = chunks[i + 2];
      b.mediaType = mimeChunk ? mimeChunk.str : "text/plain";
      if (chunks[i + 4]) b.filename = chunks[i + 4].str;

      const mime = b.mediaType.toLowerCase();
      const isText =
        mime.startsWith("text/") ||
        mime.includes("json") ||
        mime.includes("xml") ||
        mime.includes("javascript");

      if (isText) {
        b.content = chunks[i + 1].str.trim();
      } else {
        b.content = "HEX:" + chunks[i + 1].hex;
      }
    }

    // --- MAP Protocol: structured metadata ---
    if (chunk.str === PROTOCOLS.MAP) {
      const cmd = chunks[i + 1] ? chunks[i + 1].str : "";

      if (cmd === "SET") {
        for (let k = i + 2; k < chunks.length; k += 2) {
          const key = chunks[k] ? chunks[k].str : null;
          const valChunk = chunks[k + 1];
          const val = valChunk ? valChunk.str : "";

          if (!key) break;
          if (key === "|") continue;
          if (!val || val === "|") break;

          // Store all MAP keys — no filtering, apps decide what they care about
          map[key] = val;
        }
      }

      if (cmd === "ADD" && chunks[i + 2] && chunks[i + 2].str === "tags") {
        for (let k = i + 3; k < chunks.length; k++) {
          const val = chunks[k] ? chunks[k].str : "";
          if (val === "|" || val === PROTOCOLS.AIP) break;
          map.tags.push(val);
        }
      }
    }

    // --- AIP Protocol: author identity (claimed + verified) ---
    if (chunk.str === PROTOCOLS.AIP) {
      if (
        chunks[i + 1] &&
        chunks[i + 1].str === "BITCOIN_ECDSA" &&
        chunks[i + 2]
      ) {
        signer = chunks[i + 2].str;
        // Real ECDSA verification against the claimed signer.
        const result = verifyAip(chunks, i);
        signerVerified = result.verified;
        signerAddress = result.recoveredAddress;
      }
    }
  }

  return { map, b, signer, signerVerified, signerAddress };
};
