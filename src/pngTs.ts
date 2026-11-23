/**
 * PNG -> MPEG-TS segment decoder.
 *
 * Some upstream secure-token CDNs disguise their live HLS segments as PNG
 * images (anti-hotlinking). The video bytes are losslessly packed into the
 * PNG pixel data (custom "kwLn" length chunk + "KWP1" in-band header), so a
 * plain player receives an image instead of media and playback fails.
 *
 * This module mirrors the decoder used by the upstream web players:
 * 1. Parse PNG chunks (IHDR, kwLn, IDAT, IEND).
 * 2. Inflate the IDAT stream and undo the per-row PNG filters (None/Sub/Up/
 *    Average/Paeth) to recover the raw pixel bytes.
 * 3. Strip the alpha channel when the packer used RGBA/gray+alpha.
 * 4. Truncate to the byte length declared in the kwLn chunk (if present).
 * 5. Unwrap the payload: "KWP1" + 4-byte big-endian length header, or a raw
 *    MPEG-TS packet stream (0x47 sync bytes, trimmed to 188-byte packets).
 */
import { inflateSync } from 'zlib';

export function isPng(buf: Buffer): boolean {
  return buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodes a pixel-packed PNG into the original media segment bytes. */
export function decodePngToTs(buf: Buffer): Buffer {
  if (!isPng(buf)) throw new Error('Not a PNG');

  let pos = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0, kwln = -1;
  const idatParts: Buffer[] = [];

  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('latin1');
    const dStart = pos + 8;
    const dEnd = dStart + len;
    if (dEnd + 4 > buf.length) throw new Error(`Truncated PNG chunk: ${type}`);

    if (type === 'IHDR') {
      w = buf.readUInt32BE(dStart);
      h = buf.readUInt32BE(dStart + 4);
      bitDepth = buf[dStart + 8];
      colorType = buf[dStart + 9];
      interlace = buf[dStart + 12];
    } else if (type === 'kwLn' && len === 4) {
      kwln = buf.readUInt32BE(dStart);
    } else if (type === 'IDAT') {
      idatParts.push(buf.subarray(dStart, dEnd));
    } else if (type === 'IEND') {
      break;
    }
    pos = dEnd + 4;
  }

  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`Unsupported PNG layout (bitDepth=${bitDepth}, interlace=${interlace})`);
  }
  const bppMap: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const bpp = bppMap[colorType];
  if (!bpp) throw new Error(`Unsupported PNG colorType=${colorType}`);

  const filtered = inflateSync(Buffer.concat(idatParts));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let prev: Buffer = Buffer.alloc(stride);
  let fi = 0;

  for (let y = 0; y < h; y++) {
    const f = filtered[fi++];
    const row = filtered.subarray(fi, fi + stride);
    fi += stride;
    const dest = out.subarray(y * stride, (y + 1) * stride);
    if (f === 0) {
      row.copy(dest);
    } else if (f === 1) {
      for (let i = 0; i < stride; i++) dest[i] = (row[i] + (i >= bpp ? dest[i - bpp] : 0)) & 0xff;
    } else if (f === 2) {
      for (let i = 0; i < stride; i++) dest[i] = (row[i] + prev[i]) & 0xff;
    } else if (f === 3) {
      for (let i = 0; i < stride; i++) dest[i] = (row[i] + (((i >= bpp ? dest[i - bpp] : 0) + prev[i]) >> 1)) & 0xff;
    } else if (f === 4) {
      for (let i = 0; i < stride; i++) {
        dest[i] = (row[i] + paeth(i >= bpp ? dest[i - bpp] : 0, prev[i], i >= bpp ? prev[i - bpp] : 0)) & 0xff;
      }
    } else {
      throw new Error(`Bad PNG filter ${f}`);
    }
    prev = dest;
  }

  // Strip alpha channel if the packer converted RGB (2) -> RGBA (6) or gray (0) -> gray+alpha (4)
  let payload: Buffer = out;
  if (colorType === 4 || colorType === 6) {
    const keep = colorType === 4 ? 1 : 3;
    const stripped = Buffer.alloc(w * h * keep);
    for (let i = 0, j = 0; j < stripped.length; i += bpp, j += keep) {
      for (let k = 0; k < keep; k++) stripped[j + k] = out[i + k];
    }
    payload = stripped;
  }

  if (kwln >= 0 && kwln <= payload.length) {
    payload = payload.subarray(0, kwln);
  }

  // In-band 8-byte header: "KWP1" (4b 57 50 31) + 4-byte big-endian payload byte length
  if (
    payload.length >= 8 &&
    payload[0] === 0x4b && payload[1] === 0x57 && payload[2] === 0x50 && payload[3] === 0x31
  ) {
    const dataLen = payload.readUInt32BE(4);
    if (8 + dataLen > payload.length) {
      throw new Error(`KWP1 length (${dataLen}) exceeds decoded bytes (${payload.length - 8})`);
    }
    return Buffer.from(payload.subarray(8, 8 + dataLen));
  }

  // Raw MPEG-TS: trim trailing partial packets
  if (payload.length >= 188 && payload[0] === 0x47) {
    let end = Math.floor(payload.length / 188) * 188;
    while (end >= 376 && (payload[end - 188] !== 0x47 || payload[end - 376] !== 0x47)) end -= 188;
    return Buffer.from(end > 0 ? payload.subarray(0, end) : payload);
  }

  throw new Error('Decoded pixels do not start with KWP1 or 0x47 TS sync byte');
}
