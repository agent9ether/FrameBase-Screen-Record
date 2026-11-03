// Regenerate the app icon and the in-app logo from the artwork: npx electron build/make-icon.js
// Or cut any logo on a dark background out to a transparent PNG: npx electron build/make-icon.js <in> <out.png> <height>
// The artwork is a glowing logo on a near-black background. Each pixel is "unblended" from that background colour, so
// the glow keeps its look on any dark surface and there is no visible box around the logo.
const { app, nativeImage } = require('electron');
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');

// premultiplied RGBA floats (0-1) with the background taken out
function cutout(file) {
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error(`Could not read ${file}`);
  const { width: w, height: h } = image.getSize(), bgra = image.toBitmap();
  const at = i => [bgra[i * 4 + 2], bgra[i * 4 + 1], bgra[i * 4]];
  // the background is the median of the outer border, per channel
  const edge = [];
  for (let x = 0; x < w; x++) edge.push(at(x), at((h - 1) * w + x));
  for (let y = 0; y < h; y++) edge.push(at(y * w), at(y * w + w - 1));
  const bg = [0, 1, 2].map(c => edge.map(p => p[c]).sort((a, b) => a - b)[edge.length >> 1]);
  const px = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const p = at(i);
    // only what's brighter than the background counts; the background is too close to black to tell darker shades from noise
    let a = Math.max(...p.map((v, c) => Math.max(0, v - bg[c]) / (255 - bg[c])));
    a = a < 0.04 ? 0 : Math.min(1, (a - 0.04) / 0.96); // drop JPEG noise and the background's faint vignette
    for (let c = 0; c < 3; c++) px[i * 4 + c] = a ? Math.min(1, Math.max(0, (bg[c] + (p[c] - bg[c]) / a) / 255)) * a : 0;
    px[i * 4 + 3] = a;
  }
  return trim({ w, h, px }, 0.08);
}

function trim(img, min) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (img.px[(y * img.w + x) * 4 + 3] > min) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1, px = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) px.set(img.px.subarray(((y + y0) * img.w + x0) * 4, ((y + y0) * img.w + x1 + 1) * 4), y * w * 4);
  return { w, h, px };
}

// area-average downscale (premultiplied, so edges don't darken)
function resize(img, w, h) {
  const px = new Float32Array(w * h * 4), sx = img.w / w, sy = img.h / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ax = x * sx, bx = ax + sx, ay = y * sy, by = ay + sy, sum = [0, 0, 0, 0];
    let total = 0;
    for (let yy = Math.floor(ay); yy < Math.ceil(by); yy++) for (let xx = Math.floor(ax); xx < Math.ceil(bx); xx++) {
      const wgt = (Math.min(bx, xx + 1) - Math.max(ax, xx)) * (Math.min(by, yy + 1) - Math.max(ay, yy));
      const i = (Math.min(yy, img.h - 1) * img.w + Math.min(xx, img.w - 1)) * 4;
      for (let c = 0; c < 4; c++) sum[c] += img.px[i + c] * wgt;
      total += wgt;
    }
    for (let c = 0; c < 4; c++) px[(y * w + x) * 4 + c] = sum[c] / total;
  }
  return { w, h, px };
}

function writePng(file, { w, h, px }) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, o = y * (w * 4 + 1) + 1 + x * 4, a = px[i + 3];
    for (let c = 0; c < 3; c++) raw[o + c] = a ? Math.round(Math.min(1, px[i + c] / a) * 255) : 0;
    raw[o + 3] = Math.round(a * 255);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let k = n; for (let j = 0; j < 8; j++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1; return k >>> 0; });
  const crc = buf => { let k = 0xffffffff; for (const v of buf) k = crcTable[(k ^ v) & 255] ^ (k >>> 8); return (k ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
}

const fit = (img, height) => resize(img, Math.round(img.w * height / img.h), height);

// the logo on a dark rounded tile, 1024px, for the window, taskbar and installers
function icon(logo) {
  const S = 1024, tile = [64, 896, 200], fill = [11 / 255, 12 / 255, 14 / 255];
  const scale = Math.min(820 / logo.w, 820 / logo.h), art = resize(logo, Math.round(logo.w * scale), Math.round(logo.h * scale));
  const ox = (S - art.w) >> 1, oy = (S - art.h) >> 1, px = new Float32Array(S * S * 4);
  const inside = (x, y) => { const [o, size, r] = tile, dx = Math.max(o + r - x, 0, x - (o + size - r)), dy = Math.max(o + r - y, 0, y - (o + size - r)); return Math.hypot(dx, dy) <= r; };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let cover = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) cover += inside(x + (sx + .5) / 4, y + (sy + .5) / 4);
    if (!cover) continue;
    const i = (y * S + x) * 4, ax = x - ox, ay = y - oy, a = cover / 16;
    const j = ax >= 0 && ay >= 0 && ax < art.w && ay < art.h ? (ay * art.w + ax) * 4 : -1;
    for (let c = 0; c < 3; c++) px[i + c] = ((j < 0 ? 0 : art.px[j + c]) + fill[c] * (1 - (j < 0 ? 0 : art.px[j + 3]))) * a;
    px[i + 3] = a;
  }
  return { w: S, h: S, px };
}

app.whenReady().then(() => {
  try {
    const [input, output, height] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
    if (input) writePng(output, fit(cutout(input), Number(height)));
    else {
      const logo = cutout(path.join(__dirname, 'logo-art.jpg'));
      writePng(path.join(__dirname, 'icon.png'), icon(logo));
      writePng(path.join(__dirname, '..', 'assets', 'logo-mark.png'), fit(logo, 96));
    }
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
