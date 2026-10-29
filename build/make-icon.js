// Regenerate the app icon: node build/make-icon.js build/icon.png
// Draws the FrameBase mark (three lime bars on a dark rounded tile) as a 1024px PNG with anti-aliasing.
const fs = require('node:fs'), zlib = require('node:zlib');
const S = 1024, px = Buffer.alloc(S * S * 4);
const roundRect = (x, y, x0, y0, w, h, r) => { const dx = Math.max(x0 + r - x, 0, x - (x0 + w - r)), dy = Math.max(y0 + r - y, 0, y - (y0 + h - r)); return Math.hypot(dx, dy) - r; };
const bars = [[352, 470, 80, 190], [472, 370, 80, 290], [592, 430, 80, 230]];
const angle = -7 * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  let r = 0, g = 0, b = 0, a = 0;
  for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
    const fx = x + (sx + .5) / 4, fy = y + (sy + .5) / 4;
    if (roundRect(fx, fy, 64, 64, 896, 896, 200) > 0) continue;
    const rx = (fx - 512) * c - (fy - 512) * s + 512, ry = (fx - 512) * s + (fy - 512) * c + 512;
    let col = [17, 20, 22];
    const ring = roundRect(rx, ry, 250, 250, 524, 524, 120);
    if (ring <= 0 && ring > -22) col = [86, 96, 67];
    if (bars.some(([bx, by, bw, bh]) => roundRect(rx, ry, bx, by, bw, bh, 40) <= 0)) col = [214, 242, 121];
    r += col[0]; g += col[1]; b += col[2]; a += 255;
  }
  const i = (y * S + x) * 4, n = 16;
  px[i] = a ? r / (a / 255) : 0; px[i + 1] = a ? g / (a / 255) : 0; px[i + 2] = a ? b / (a / 255) : 0; px[i + 3] = a / n;
}
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
const crcTable = Array.from({ length: 256 }, (_, n) => { let k = n; for (let j = 0; j < 8; j++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1; return k >>> 0; });
const crc = buf => { let k = 0xffffffff; for (const v of buf) k = crcTable[(k ^ v) & 255] ^ (k >>> 8); return (k ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
fs.writeFileSync(process.argv[2], Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
