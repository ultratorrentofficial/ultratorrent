#!/usr/bin/env node
/**
 * Every page that documents a screen carries a screenshot placeholder like:
 *
 *     :::note Screenshot needed
 *     Capture: Smart Download → Missing Episodes
 *     :::
 *     ![Missing Episodes overview](/img/screenshots/missing-episodes-overview.png)
 *
 * Docusaurus resolves local images at build time and **fails the build** if one is
 * missing. We do not want to silence that (a genuinely broken image should still
 * fail) — so instead we materialise a real, visible placeholder PNG for every
 * referenced-but-missing screenshot.
 *
 * Why this shape:
 *   • The file keeps its final `.png` name, so contributing a real screenshot is
 *     just "overwrite the file" — no doc edit, no renaming.
 *   • The placeholder renders as an obvious slate panel, so an undocumented screen
 *     is visible at a glance rather than silently absent.
 *   • The *specific* instruction ("capture this screen") lives in the admonition
 *     above the image, which is where a human is actually looking.
 *
 * There is no image library available here, so the PNG is hand-encoded with
 * Node's built-in zlib (IHDR + IDAT + IEND, CRC32 per chunk).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.resolve(HERE, '../docs');
const STATIC = path.resolve(HERE, '../static');

// --- minimal PNG encoder ---------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/**
 * A 16:9 slate: dark panel, lighter inset border, faint diagonal hatching — the
 * universal "asset pending" look. Neutral enough to sit in both light and dark
 * themes without shouting.
 */
function placeholderPng(width = 1280, height = 720) {
  const BG = [30, 33, 39];
  const PANEL = [42, 46, 54];
  const LINE = [70, 76, 88];

  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const inset = x > 40 && x < width - 40 && y > 40 && y < height - 40;
      const onBorder =
        inset &&
        (x < 44 || x > width - 44 || y < 44 || y > height - 44);
      // 45° hatch inside the panel
      const hatch = inset && (x + y) % 28 < 2;
      const c = onBorder || hatch ? LINE : inset ? PANEL : BG;
      raw[o++] = c[0];
      raw[o++] = c[1];
      raw[o++] = c[2];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- scan the docs for referenced images -----------------------------------
const referenced = new Set();
(function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.mdx?$/.test(e.name)) {
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/\]\((\/img\/[^)\s]+\.(?:png|jpg|jpeg|gif|webp))\)/g)) {
        referenced.add(m[1]);
      }
      for (const m of src.matchAll(/src=["'](\/img\/[^"']+\.(?:png|jpg|jpeg|gif|webp))["']/g)) {
        referenced.add(m[1]);
      }
    }
  }
})(DOCS);

let created = 0;
let existing = 0;
const png = placeholderPng();

for (const ref of referenced) {
  const dest = path.join(STATIC, ref.replace(/^\//, ''));
  if (fs.existsSync(dest)) {
    existing++;
    continue;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, png);
  created++;
}

console.log(
  `Screenshot placeholders: ${referenced.size} referenced · ${created} placeholder(s) created · ${existing} real image(s) already present`,
);
if (created) {
  console.log(
    'To contribute a screenshot, just overwrite the placeholder file — no doc edit needed.',
  );
}
