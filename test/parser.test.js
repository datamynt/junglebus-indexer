/**
 * test/parser.test.js — Unit tests for the OP_RETURN protocol parser.
 *
 * These exercise the two pure functions that form the heart of the
 * library — parseScript() and extractProtocols() — with no network or
 * database dependency. Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, extractProtocols, PROTOCOLS } from '../src/parser.js';

// ---------------------------------------------------------------------------
// Helpers — build OP_RETURN locking-script hex the same way the chain does.
// ---------------------------------------------------------------------------

/** Encode one data push (direct push or OP_PUSHDATA1) for a utf8 string. */
const pushStr = (s) => pushBuf(Buffer.from(s, 'utf8'));

/** Encode one data push for a Buffer of bytes. */
const pushBuf = (buf) => {
    const len = buf.length;
    const data = buf.toString('hex');
    if (len <= 0x4b) {
        return len.toString(16).padStart(2, '0') + data;
    }
    if (len <= 0xff) {
        // OP_PUSHDATA1
        return '4c' + len.toString(16).padStart(2, '0') + data;
    }
    if (len <= 0xffff) {
        // OP_PUSHDATA2 (little-endian length)
        const lo = len & 0xff;
        const hi = (len >> 8) & 0xff;
        return '4d' + lo.toString(16).padStart(2, '0') + hi.toString(16).padStart(2, '0') + data;
    }
    throw new Error('test helper does not handle pushes > 65535 bytes');
};

/** Build a full OP_RETURN script: OP_FALSE OP_RETURN <pushes...>. */
const opReturn = (...pushes) => '006a' + pushes.join('');

// ---------------------------------------------------------------------------
// parseScript
// ---------------------------------------------------------------------------

test('parseScript returns [] for empty/falsy input', () => {
    assert.deepEqual(parseScript(''), []);
    assert.deepEqual(parseScript(undefined), []);
    assert.deepEqual(parseScript(null), []);
});

test('parseScript decodes direct-push (0x01-0x4b) chunks', () => {
    // OP_FALSE OP_RETURN "hi" — the 006a prefix decodes as two empty-ish ops
    // and is skipped, so only the data push should produce a chunk.
    const hex = opReturn(pushStr('hi'));
    const chunks = parseScript(hex);
    const strs = chunks.map((c) => c.str);
    assert.ok(strs.includes('hi'), `expected "hi" in ${JSON.stringify(strs)}`);
});

test('parseScript decodes OP_PUSHDATA1 (0x4c) chunks', () => {
    const big = 'x'.repeat(200); // forces OP_PUSHDATA1
    const push = pushBuf(Buffer.from(big, 'utf8'));
    assert.ok(push.startsWith('4c'), 'helper should have emitted OP_PUSHDATA1');
    const chunks = parseScript(opReturn(push));
    assert.ok(chunks.some((c) => c.str === big));
});

test('parseScript exposes both hex and utf8 string for each chunk', () => {
    const chunks = parseScript(opReturn(pushStr('abc')));
    const chunk = chunks.find((c) => c.str === 'abc');
    assert.ok(chunk, 'chunk for "abc" should exist');
    assert.equal(chunk.hex, Buffer.from('abc', 'utf8').toString('hex'));
});

// ---------------------------------------------------------------------------
// extractProtocols
// ---------------------------------------------------------------------------

test('extractProtocols extracts B protocol text content + media type', () => {
    // B | <content> | <media_type>
    const chunks = parseScript(
        opReturn(pushStr(PROTOCOLS.B), pushStr('Hello world'), pushStr('text/plain')),
    );
    const { b } = extractProtocols(chunks);
    assert.equal(b.content, 'Hello world');
    assert.equal(b.mediaType, 'text/plain');
});

test('extractProtocols extracts MAP SET key/value pairs', () => {
    const chunks = parseScript(
        opReturn(
            pushStr(PROTOCOLS.MAP),
            pushStr('SET'),
            pushStr('type'),
            pushStr('post'),
            pushStr('app'),
            pushStr('myapp'),
        ),
    );
    const { map } = extractProtocols(chunks);
    assert.equal(map.type, 'post');
    assert.equal(map.app, 'myapp');
});

test('extractProtocols extracts AIP signer address', () => {
    const addr = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
    const chunks = parseScript(
        opReturn(pushStr(PROTOCOLS.AIP), pushStr('BITCOIN_ECDSA'), pushStr(addr)),
    );
    const { signer } = extractProtocols(chunks);
    assert.equal(signer, addr);
});

test('extractProtocols defaults signer to "unknown" when no AIP present', () => {
    const chunks = parseScript(
        opReturn(pushStr(PROTOCOLS.MAP), pushStr('SET'), pushStr('type'), pushStr('post')),
    );
    assert.equal(extractProtocols(chunks).signer, 'unknown');
});

test('extractProtocols collects MAP ADD tags', () => {
    const chunks = parseScript(
        opReturn(
            pushStr(PROTOCOLS.MAP),
            pushStr('ADD'),
            pushStr('tags'),
            pushStr('bsv'),
            pushStr('dev'),
        ),
    );
    const { map } = extractProtocols(chunks);
    assert.deepEqual(map.tags, ['bsv', 'dev']);
});

test('extractProtocols handles a combined B + MAP + AIP transaction', () => {
    const addr = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
    const chunks = parseScript(
        opReturn(
            pushStr(PROTOCOLS.B),
            pushStr('gm'),
            pushStr('text/plain'),
            pushStr(PROTOCOLS.MAP),
            pushStr('SET'),
            pushStr('type'),
            pushStr('post'),
            pushStr(PROTOCOLS.AIP),
            pushStr('BITCOIN_ECDSA'),
            pushStr(addr),
        ),
    );
    const { b, map, signer } = extractProtocols(chunks);
    assert.equal(b.content, 'gm');
    assert.equal(map.type, 'post');
    assert.equal(signer, addr);
});
