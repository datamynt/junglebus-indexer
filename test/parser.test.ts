/**
 * test/parser.test.ts — Unit tests for the OP_RETURN protocol parser.
 *
 * These exercise the two pure functions that form the heart of the
 * library — parseScript() and extractProtocols() — with no network or
 * database dependency. Run with: npm test
 */

import { describe, test, expect } from "vitest";
import { parseScript, extractProtocols, PROTOCOLS } from "../src/parser.js";

// ---------------------------------------------------------------------------
// Helpers — build OP_RETURN locking-script hex the same way the chain does.
// ---------------------------------------------------------------------------

/** Encode one data push for a Buffer of bytes. */
const pushBuf = (buf: Buffer): string => {
  const len = buf.length;
  const data = buf.toString("hex");
  if (len <= 0x4b) {
    return len.toString(16).padStart(2, "0") + data;
  }
  if (len <= 0xff) {
    // OP_PUSHDATA1
    return "4c" + len.toString(16).padStart(2, "0") + data;
  }
  if (len <= 0xffff) {
    // OP_PUSHDATA2 (little-endian length)
    const lo = len & 0xff;
    const hi = (len >> 8) & 0xff;
    return (
      "4d" +
      lo.toString(16).padStart(2, "0") +
      hi.toString(16).padStart(2, "0") +
      data
    );
  }
  throw new Error("test helper does not handle pushes > 65535 bytes");
};

/** Encode one data push (direct push or OP_PUSHDATA1) for a utf8 string. */
const pushStr = (s: string): string => pushBuf(Buffer.from(s, "utf8"));

/** Build a full OP_RETURN script: OP_FALSE OP_RETURN <pushes...>. */
const opReturn = (...pushes: string[]): string => "006a" + pushes.join("");

// ---------------------------------------------------------------------------
// parseScript
// ---------------------------------------------------------------------------

describe("parseScript", () => {
  test("returns [] for empty/falsy input", () => {
    expect(parseScript("")).toEqual([]);
    expect(parseScript(undefined)).toEqual([]);
    expect(parseScript(null)).toEqual([]);
  });

  test("decodes direct-push (0x01-0x4b) chunks", () => {
    const hex = opReturn(pushStr("hi"));
    const chunks = parseScript(hex);
    const strs = chunks.map((c) => c.str);
    expect(strs).toContain("hi");
  });

  test("decodes OP_PUSHDATA1 (0x4c) chunks", () => {
    const big = "x".repeat(200); // forces OP_PUSHDATA1
    const push = pushBuf(Buffer.from(big, "utf8"));
    expect(push.startsWith("4c")).toBe(true);
    const chunks = parseScript(opReturn(push));
    expect(chunks.some((c) => c.str === big)).toBe(true);
  });

  test("exposes both hex and utf8 string for each chunk", () => {
    const chunks = parseScript(opReturn(pushStr("abc")));
    const chunk = chunks.find((c) => c.str === "abc");
    expect(chunk).toBeDefined();
    expect(chunk!.hex).toBe(Buffer.from("abc", "utf8").toString("hex"));
  });
});

// ---------------------------------------------------------------------------
// extractProtocols
// ---------------------------------------------------------------------------

describe("extractProtocols", () => {
  test("extracts B protocol text content + media type", () => {
    const chunks = parseScript(
      opReturn(pushStr(PROTOCOLS.B), pushStr("Hello world"), pushStr("text/plain")),
    );
    const { b } = extractProtocols(chunks);
    expect(b.content).toBe("Hello world");
    expect(b.mediaType).toBe("text/plain");
  });

  test("extracts MAP SET key/value pairs", () => {
    const chunks = parseScript(
      opReturn(
        pushStr(PROTOCOLS.MAP),
        pushStr("SET"),
        pushStr("type"),
        pushStr("post"),
        pushStr("app"),
        pushStr("myapp"),
      ),
    );
    const { map } = extractProtocols(chunks);
    expect(map.type).toBe("post");
    expect(map.app).toBe("myapp");
  });

  test("extracts AIP signer address (claimed)", () => {
    const addr = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
    const chunks = parseScript(
      opReturn(pushStr(PROTOCOLS.AIP), pushStr("BITCOIN_ECDSA"), pushStr(addr)),
    );
    const { signer } = extractProtocols(chunks);
    expect(signer).toBe(addr);
  });

  test("defaults signer to 'unknown' when no AIP present", () => {
    const chunks = parseScript(
      opReturn(pushStr(PROTOCOLS.MAP), pushStr("SET"), pushStr("type"), pushStr("post")),
    );
    const res = extractProtocols(chunks);
    expect(res.signer).toBe("unknown");
    expect(res.signerVerified).toBe(false);
  });

  test("collects MAP ADD tags", () => {
    const chunks = parseScript(
      opReturn(
        pushStr(PROTOCOLS.MAP),
        pushStr("ADD"),
        pushStr("tags"),
        pushStr("bsv"),
        pushStr("dev"),
      ),
    );
    const { map } = extractProtocols(chunks);
    expect(map.tags).toEqual(["bsv", "dev"]);
  });

  test("handles a combined B + MAP + AIP transaction", () => {
    const addr = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
    const chunks = parseScript(
      opReturn(
        pushStr(PROTOCOLS.B),
        pushStr("gm"),
        pushStr("text/plain"),
        pushStr(PROTOCOLS.MAP),
        pushStr("SET"),
        pushStr("type"),
        pushStr("post"),
        pushStr(PROTOCOLS.AIP),
        pushStr("BITCOIN_ECDSA"),
        pushStr(addr),
      ),
    );
    const { b, map, signer } = extractProtocols(chunks);
    expect(b.content).toBe("gm");
    expect(map.type).toBe("post");
    expect(signer).toBe(addr);
  });

  test("an unsigned/claim-only AIP block does NOT verify", () => {
    // A forged signer with no real signature push: signerVerified must be false.
    const addr = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
    const chunks = parseScript(
      opReturn(pushStr(PROTOCOLS.AIP), pushStr("BITCOIN_ECDSA"), pushStr(addr)),
    );
    expect(extractProtocols(chunks).signerVerified).toBe(false);
  });
});
