/**
 * Tests for the PNG -> MPEG-TS segment decoder (pixel-packed anti-hotlink
 * segments). Builds synthetic PNGs with the same layout the upstream packer
 * emits (RGBA pixels, kwLn length chunk, KWP1 in-band header or raw TS).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { deflateSync, crc32 } from 'node:zlib';
import { decodePngToTs, isPng } from '../pngTs';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  out.writeUInt32BE(crc >>> 0, 8 + data.length);
  return out;
}

function buildPng(w: number, h: number, rows: Buffer[], kwln?: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // colorType RGBA
  ihdr[10] = 0;     // compression
  ihdr[11] = 0;     // filter
  ihdr[12] = 0;     // interlace
  const parts = [PNG_SIG, chunk('IHDR', ihdr)];
  if (kwln !== undefined) parts.push(chunk('kwLn', (() => { const b = Buffer.alloc(4); b.writeUInt32BE(kwln, 0); return b; })()));
  parts.push(chunk('IDAT', deflateSync(Buffer.concat(rows))));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function pixelRow(rawRgb: Buffer): Buffer {
  // stride = 4 * w ; filter byte 0 + RGBA rows (alpha 255). Pads RGB to a full row.
  const w = Math.ceil(rawRgb.length / 3);
  const row = Buffer.alloc(1 + w * 4);
  for (let i = 0; i < w; i++) {
    row[1 + i * 4] = i * 3 < rawRgb.length ? rawRgb[i * 3] : 0;
    row[2 + i * 4] = i * 3 + 1 < rawRgb.length ? rawRgb[i * 3 + 1] : 0;
    row[3 + i * 4] = i * 3 + 2 < rawRgb.length ? rawRgb[i * 3 + 2] : 0;
    row[4 + i * 4] = 0xff;
  }
  return row;
}

/** Splits a byte payload into per-row RGB scanlines for a given width. */
function rowsFor(payload: Buffer, w: number): Buffer[] {
  const rows: Buffer[] = [];
  for (let off = 0; off < payload.length; off += w * 3) {
    rows.push(pixelRow(payload.subarray(off, off + w * 3)));
  }
  return rows;
}

test('isPng detects the PNG signature', () => {
  assert.strictEqual(isPng(PNG_SIG), true);
  assert.strictEqual(isPng(Buffer.from([0x47, 0x49, 0x46, 0x38])), false);
});

test('decodePngToTs unwraps a KWP1 pixel-packed segment', () => {
  const payload = Buffer.concat([
    Buffer.from('KWP1', 'latin1'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(16, 0); return b; })(),
    Buffer.alloc(16, 0x47)
  ]); // 24 bytes -> w=4, h=2 RGB after alpha strip
  const rows = [pixelRow(payload.subarray(0, 12)), pixelRow(payload.subarray(12, 24))];
  const decoded = decodePngToTs(buildPng(4, 2, rows));
  assert.strictEqual(decoded.length, 16);
  assert.strictEqual(Buffer.compare(decoded, Buffer.alloc(16, 0x47)), 0);
});

test('decodePngToTs honours the kwLn truncation length', () => {
  const data = Buffer.alloc(32, 0x47);
  const payload = Buffer.concat([
    Buffer.from('KWP1', 'latin1'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(24, 0); return b; })(),
    data
  ]); // 40 bytes -> w=5, h=3 (rows padded); kwLn covers KWP1 header + 24 data bytes
  const decoded = decodePngToTs(buildPng(5, 3, rowsFor(payload, 5), 32));
  assert.strictEqual(decoded.length, 24);
  assert.strictEqual(Buffer.compare(decoded, data.subarray(0, 24)), 0);
});

test('decodePngToTs passes through raw TS payloads trimmed to 188-byte packets', () => {
  const pkts = Buffer.concat([Buffer.alloc(188, 0x47), Buffer.alloc(188, 0x47)]);
  const tail = Buffer.alloc(10, 0x47); // partial packet to be trimmed
  const payload = Buffer.concat([pkts, tail]); // 386 bytes -> w=5, h=26
  const decoded = decodePngToTs(buildPng(5, Math.ceil(386 / 15), rowsFor(payload, 5), 386));
  assert.strictEqual(decoded.length, 376);
  assert.strictEqual(decoded[0], 0x47);
});

test('decodePngToTs rejects non-PNG input', () => {
  assert.throws(() => decodePngToTs(Buffer.alloc(64, 0x47)), /Not a PNG/);
});
