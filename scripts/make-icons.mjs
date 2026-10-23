// Renders the RoBulk icon (blue tile, 2x2 grid with a check in the corner)
// to PNGs at the sizes Chrome and Firefox ask for. No image libraries needed:
// shapes are rasterized with 4x4 supersampling and written with node:zlib.
//
//   node scripts/make-icons.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const SIZES = [16, 32, 48, 128];
const BG = [51, 95, 255];
const FG = [255, 255, 255];

// Shapes in a 0..1 coordinate space.
const roundedRect = (x, y, w, h, r) => (px, py) => {
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r && px >= x && px <= x + w && py >= y && py <= y + h;
};

const segment = (ax, ay, bx, by, width) => (px, py) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2 <= (width / 2) ** 2;
};

const tile = roundedRect(0, 0, 1, 1, 0.22);
const cells = [
  [roundedRect(0.2, 0.2, 0.25, 0.25, 0.05), 1],
  [roundedRect(0.55, 0.2, 0.25, 0.25, 0.05), 0.6],
  [roundedRect(0.2, 0.55, 0.25, 0.25, 0.05), 0.6],
];
const check = [segment(0.57, 0.68, 0.65, 0.76, 0.075), segment(0.65, 0.76, 0.8, 0.6, 0.075)];

function pixel(px, py) {
  if (!tile(px, py)) return [0, 0, 0, 0];
  let color = BG;
  for (const [shape, alpha] of cells) {
    if (shape(px, py)) color = BG.map((c, i) => c + (FG[i] - c) * alpha);
  }
  if (check.some((s) => s(px, py))) color = FG;
  return [...color, 255];
}

function render(size) {
  const ss = 4;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [0]; // filter byte
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const p = pixel((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          acc[0] += p[0] * p[3];
          acc[1] += p[1] * p[3];
          acc[2] += p[2] * p[3];
          acc[3] += p[3];
        }
      const a = acc[3] / (ss * ss);
      row.push(...(acc[3] ? [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3]].map(Math.round) : [0, 0, 0]), Math.round(a));
    }
    rows.push(Buffer.from(row));
  }
  return png(size, Buffer.concat(rows));
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("public/icons", { recursive: true });
for (const size of SIZES) writeFileSync(`public/icons/icon-${size}.png`, render(size));
console.log(`Wrote ${SIZES.map((s) => `icon-${s}.png`).join(", ")} to public/icons`);
