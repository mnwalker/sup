'use strict';

/**
 * Generates the app icons without pulling in an image toolchain: everything is
 * rasterised here (4x supersampled) and written out with a minimal PNG writer.
 *
 *   node scripts/make-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets');
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const SS = 4; // supersampling factor

const BG = [0x12, 0x14, 0x1a];
const TAB = [0x05, 0x06, 0x09];
const RING_BG = [0x2a, 0x2e, 0x3a];
const RING = [0x6e, 0xe7, 0xa0];

function writePng(file, width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ])
  );
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

/** Distance from a point to a rounded rectangle (negative = inside). */
function roundedRectSdf(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

function draw(size) {
  const w = size * SS;
  const buf = Buffer.alloc(w * w * 4);
  const s = w; // work in pixels, scale factors are fractions of the icon

  const cx = w / 2;
  const cy = w / 2;
  const ringCx = w * 0.43;
  const ringCy = w / 2;
  const ringR = w * 0.245;
  const ringWidth = w * 0.088;

  // 70% of a ring, starting at the top and sweeping clockwise.
  const sweep = Math.PI * 2 * 0.7;

  for (let y = 0; y < w; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      let color = null;
      let alpha = 0;

      if (roundedRectSdf(px, py, cx, w / 2, w / 2, w / 2, s * 0.22) < 0) {
        color = BG;
        alpha = 255;
      }

      if (alpha) {
        // The tab: a pill clinging to the right edge, matching the default.
        const tabHalfH = w * 0.22;
        const tabDepth = w * 0.15;
        if (py > cy - tabHalfH && py < cy + tabHalfH && px > w - tabDepth) {
          const inner = roundedRectSdf(px, py, w - tabDepth + w * 0.13, cy, w * 0.13, tabHalfH, w * 0.075);
          if (px > w - tabDepth * 0.45 || inner < 0) color = TAB;
        }

        const d = Math.hypot(px - ringCx, py - ringCy);
        if (Math.abs(d - ringR) < ringWidth / 2) {
          let angle = Math.atan2(px - ringCx, -(py - ringCy)); // 0 at top, clockwise
          if (angle < 0) angle += Math.PI * 2;
          color = angle <= sweep ? RING : RING_BG;
        }
      }

      const i = (y * w + x) * 4;
      if (alpha && color) {
        buf[i] = color[0];
        buf[i + 1] = color[1];
        buf[i + 2] = color[2];
        buf[i + 3] = 255;
      }
    }
  }

  return downsample(buf, w, size);
}

function downsample(src, srcSize, size) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = ((y * SS + sy) * srcSize + (x * SS + sx)) * 4;
          const av = src[i + 3] / 255;
          r += src[i] * av;
          g += src[i + 1] * av;
          b += src[i + 2] * av;
          a += src[i + 3];
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const norm = alpha > 0 ? 255 / alpha : 0;
      const o = (y * size + x) * 4;
      out[o] = Math.round(Math.min(255, (r / n) * norm));
      out[o + 1] = Math.round(Math.min(255, (g / n) * norm));
      out[o + 2] = Math.round(Math.min(255, (b / n) * norm));
      out[o + 3] = Math.round(alpha);
    }
  }
  return out;
}

fs.mkdirSync(path.join(OUT, 'icons'), { recursive: true });
for (const size of SIZES) {
  const rgba = draw(size);
  writePng(path.join(OUT, 'icons', `${size}x${size}.png`), size, size, rgba);
}
fs.copyFileSync(path.join(OUT, 'icons', '512x512.png'), path.join(OUT, 'icon.png'));
fs.copyFileSync(path.join(OUT, 'icons', '32x32.png'), path.join(OUT, 'tray.png'));
console.log(`wrote ${SIZES.length} icons to ${path.join(OUT, 'icons')}`);
