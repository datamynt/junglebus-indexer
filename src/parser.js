/**
 * parser.js — OP_RETURN protocol parser for BSV transactions.
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

const PROTOCOLS = {
    B:   "19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut",
    MAP: "1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5",
    AIP: "15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva",
};

/**
 * Parse a hex locking script into data chunks.
 * Handles OP_PUSHDATA1 (0x4c), OP_PUSHDATA2 (0x4d), OP_PUSHDATA4 (0x4e),
 * and direct push opcodes (0x01-0x4b).
 *
 * @param {string} hex - Raw hex string from output.lockingScript.toHex()
 * @returns {Array<{hex: string, str: string}>} Decoded chunks
 */
export const parseScript = (hex) => {
    if (!hex) return [];
    const chunks = [];
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
            len = parseInt(lenHex.match(/../g).reverse().join(''), 16);
            i += 4;
            dataHex = hex.substring(i, i + len * 2);
            i += len * 2;
        } else if (byte === 0x4e) {
            const lenHex = hex.substring(i, i + 8);
            len = parseInt(lenHex.match(/../g).reverse().join(''), 16);
            i += 8;
            dataHex = hex.substring(i, i + len * 2);
            i += len * 2;
        } else {
            continue;
        }

        let dataStr = "";
        try {
            dataStr = Buffer.from(dataHex, 'hex').toString('utf8');
        } catch (e) {
            // Binary data — leave str empty
        }
        chunks.push({ hex: dataHex, str: dataStr });
    }

    return chunks;
};

/**
 * Extract B, MAP, and AIP protocol data from parsed chunks.
 *
 * @param {Array<{hex: string, str: string}>} chunks
 * @returns {{ map: object, b: object, signer: string }}
 *   - map: All MAP key-value pairs + tags array
 *   - b: { content, mediaType, filename }
 *   - signer: Bitcoin address from AIP, or "unknown"
 */
export const extractProtocols = (chunks) => {
    const map = { tags: [] };
    const b = { content: "", mediaType: "text/plain", filename: null };
    let signer = "unknown";

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        // --- B Protocol: content + media type ---
        if (chunk.str === PROTOCOLS.B && chunks[i + 1]) {
            const mimeChunk = chunks[i + 2];
            b.mediaType = mimeChunk ? mimeChunk.str : "text/plain";
            if (chunks[i + 4]) b.filename = chunks[i + 4].str;

            const mime = b.mediaType.toLowerCase();
            const isText = mime.startsWith('text/') || mime.includes('json') || mime.includes('xml') || mime.includes('javascript');

            if (isText) {
                b.content = chunks[i + 1].str.trim();
            } else {
                b.content = "HEX:" + chunks[i + 1].hex;
            }
        }

        // --- MAP Protocol: structured metadata ---
        if (chunk.str === PROTOCOLS.MAP) {
            const cmd = chunks[i + 1] ? chunks[i + 1].str : "";

            if (cmd === 'SET') {
                for (let k = i + 2; k < chunks.length; k += 2) {
                    const key = chunks[k] ? chunks[k].str : null;
                    const valChunk = chunks[k + 1];
                    const val = valChunk ? valChunk.str : "";

                    if (!key) break;
                    if (key === '|') continue;
                    if (!val || val === '|') break;

                    // Store all MAP keys — no filtering, apps decide what they care about
                    map[key] = val;
                }
            }

            if (cmd === 'ADD' && chunks[i + 2] && chunks[i + 2].str === 'tags') {
                for (let k = i + 3; k < chunks.length; k++) {
                    const val = chunks[k] ? chunks[k].str : "";
                    if (val === '|' || val === PROTOCOLS.AIP) break;
                    map.tags.push(val);
                }
            }
        }

        // --- AIP Protocol: author identity ---
        if (chunk.str === PROTOCOLS.AIP) {
            if (chunks[i + 1] && chunks[i + 1].str === "BITCOIN_ECDSA" && chunks[i + 2]) {
                signer = chunks[i + 2].str;
            }
        }
    }

    return { map, b, signer };
};

export { PROTOCOLS };
