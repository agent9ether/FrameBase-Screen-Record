// Timed edits: which text shows, how it looks, and how far the picture is zoomed at a moment of the clip.
// Shared by the editor preview and the export renderer, and loaded by the unit tests.
(function (root) {
  const MAX_SECONDS = 86400;
  const MIN_LENGTH = 0.2;
  const ZOOM_EASE = 0.8; // default seconds to ease into and out of a zoom
  const JOIN_GAP = 0.25; // zooms this close glide from one to the next instead of zooming out in between
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

  function timing(item) {
    const start = clamp(number(item.start, 0), 0, MAX_SECONDS - MIN_LENGTH);
    const end = clamp(number(item.end, MAX_SECONDS), start + MIN_LENGTH, MAX_SECONDS);
    return { start, end };
  }

  // Text fonts: the first three ship with the app; the rest are system fonts, with a fallback where one is missing.
  const FONTS = {
    manrope: { label: 'Manrope', css: 'Manrope, sans-serif' },
    'dm-sans': { label: 'DM Sans', css: "'DM Sans', sans-serif" },
    'dm-mono': { label: 'DM Mono', css: "'DM Mono', monospace" },
    arial: { label: 'Arial', css: 'Arial, Helvetica, sans-serif' },
    verdana: { label: 'Verdana', css: 'Verdana, sans-serif' },
    trebuchet: { label: 'Trebuchet MS', css: "'Trebuchet MS', sans-serif" },
    impact: { label: 'Impact', css: "Impact, 'Arial Black', sans-serif" },
    georgia: { label: 'Georgia', css: 'Georgia, serif' },
    times: { label: 'Times New Roman', css: "'Times New Roman', Times, serif" },
    courier: { label: 'Courier New', css: "'Courier New', Courier, monospace" },
    comic: { label: 'Comic Sans MS', css: "'Comic Sans MS', 'Comic Sans', cursive" }
  };
  // size is in pixels of a 1080-pixel-tall frame, so text keeps its proportions at any resolution
  const TEXT_STYLE = { font: 'manrope', size: 48, bold: true, italic: false, color: '#ffffff', background: '#000000', backgroundOpacity: 55 };
  const isColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  function textStyle(item = {}) {
    return {
      font: Object.hasOwn(FONTS, item.font) ? item.font : TEXT_STYLE.font,
      size: Math.round(clamp(number(item.size, TEXT_STYLE.size), 12, 200)),
      bold: typeof item.bold === 'boolean' ? item.bold : TEXT_STYLE.bold,
      italic: item.italic === true,
      color: isColor(item.color) ? item.color.toLowerCase() : TEXT_STYLE.color,
      background: isColor(item.background) ? item.background.toLowerCase() : TEXT_STYLE.background,
      backgroundOpacity: Math.round(clamp(number(item.backgroundOpacity, TEXT_STYLE.backgroundOpacity), 0, 100))
    };
  }
  // the CSS / canvas font for a text item at a pixel size
  const fontCss = (item, px) => `${item.italic ? 'italic ' : ''}${item.bold ? 700 : 400} ${px}px ${(FONTS[item.font] || FONTS.manrope).css}`;
  const rgba = (hex, opacity) => `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${opacity / 100})`;

  const zoomEase = value => Math.round(clamp(number(value, ZOOM_EASE), 0.2, 2) * 10) / 10;

  // Older projects had one zoom for the whole clip and text without times or styles: they get the whole clip and
  // the original look.
  function normalizeEdits(edits = {}) {
    const textItems = (Array.isArray(edits.textItems) ? edits.textItems : []).slice(0, 100)
      .filter(item => item && typeof item.text === 'string')
      .map(item => ({ text: item.text.slice(0, 500), x: clamp(number(item.x, 38), 0, 100), y: clamp(number(item.y, 44), 0, 100), ...timing(item), ...textStyle(item) }));
    let zooms = (Array.isArray(edits.zooms) ? edits.zooms : []).slice(0, 100)
      .filter(item => item && typeof item === 'object')
      .map(item => ({ level: clamp(number(item.level, 1.5), 1.1, 3), x: clamp(number(item.x, 50), 0, 100), y: clamp(number(item.y, 50), 0, 100), ease: zoomEase(item.ease), ...timing(item) }));
    if (!Array.isArray(edits.zooms) && number(edits.zoomLevel, 1) > 1) {
      zooms = [{ level: clamp(number(edits.zoomLevel, 1), 1.1, 3), x: 50, y: 50, ease: ZOOM_EASE, start: 0, end: MAX_SECONDS }];
    }
    return { cropEnabled: edits.cropEnabled === true, textItems, zooms };
  }

  // Keep every item inside a clip of this length (after loading, or when the clip turns out shorter).
  function fitToDuration(items, duration) {
    if (!(duration > 0)) return;
    items.forEach(item => {
      item.end = Math.min(item.end, duration);
      item.start = Math.min(item.start, Math.max(0, item.end - MIN_LENGTH));
    });
  }

  // A new item at the playhead, shortened or moved back so it fits in the clip.
  function placeAt(time, duration, length = 3) {
    const total = duration > 0 ? duration : length;
    const span = Math.min(length, total);
    const start = clamp(time, 0, Math.max(0, total - span));
    return { start, end: start + span };
  }

  const active = (item, time) => time >= item.start && time < item.end;
  const textsAt = (items, time) => items.filter(item => active(item, time));

  // smootherstep: starts and stops with no jolt in speed or acceleration
  const ease = t => t * t * t * (t * (t * 6 - 15) + 10);
  const FULL = { left: 0, top: 0, width: 1, height: 1 };

  // Glide between two views. The size changes at a steady rate (each step closer feels the same) and the edges
  // move in step with the size, so the camera pivots around one point instead of drifting sideways.
  function blend(from, to, t) {
    const width = from.width * Math.pow(to.width / from.width, t);
    const s = Math.abs(to.width - from.width) > 1e-9 ? (width - from.width) / (to.width - from.width) : t;
    return { left: from.left + (to.left - from.left) * s, top: from.top + (to.top - from.top) * s, width, height: width };
  }

  const rampOf = zoom => Math.min(zoom.ease || ZOOM_EASE, (zoom.end - zoom.start) / 3);
  // A zoom followed closely by another one stays zoomed until that one has eased in, so the view glides straight
  // across.
  function nextJoined(zooms, zoom, ramp) {
    return zooms.filter(item => item !== zoom && item.start > zoom.start && item.start > zoom.end - ramp && item.start <= zoom.end + JOIN_GAP && item.end > zoom.end)
      .sort((a, b) => a.start - b.start)[0];
  }

  // The part of the frame on screen at this moment, as fractions of the frame. Outside any zoom it is the whole
  // frame; a zoom eases from whatever was on screen (the whole frame, or the zoom it starts inside) to its own view
  // and back. The latest-starting zoom wins where two overlap.
  function boxAt(zooms, time, skip) {
    let winner = null, winnerRamp = 0, joined = null;
    for (const zoom of zooms) {
      if (skip.has(zoom) || (winner && zoom.start <= winner.start)) continue;
      const ramp = rampOf(zoom);
      const next = nextJoined(zooms, zoom, ramp);
      if (time >= zoom.start && time < Math.max(zoom.end, next ? next.start + rampOf(next) : 0)) { winner = zoom; winnerRamp = ramp; joined = next; }
    }
    if (!winner) return FULL;
    const progress = Math.min(1, (time - winner.start) / winnerRamp, joined ? 1 : (winner.end - time) / winnerRamp);
    const own = zoomView(winner).box;
    if (progress >= 1) return own;
    skip.add(winner);
    return blend(boxAt(zooms, time, skip), own, ease(clamp(progress, 0, 0.999999)));
  }

  // How to draw the picture at this moment: scale by `level`, then move by (tx, ty) as fractions of the frame.
  function viewAt(zooms, time) {
    const box = boxAt(zooms, time, new Set());
    return { level: 1 / box.width, tx: -box.left / box.width, ty: -box.top / box.width, box };
  }

  // Where the picture goes when zoomed by `level` toward the point (x%, y%) of the frame:
  // scale, then move by (tx, ty) as fractions of the frame, keeping the view inside the picture.
  function zoomView({ level, x, y }) {
    const half = 1 / (2 * level);
    const cx = clamp(x / 100, half, 1 - half), cy = clamp(y / 100, half, 1 - half);
    return { level, tx: 0.5 - cx * level, ty: 0.5 - cy * level, box: { left: cx - half, top: cy - half, width: 2 * half, height: 2 * half } };
  }

  // Rows for drawing overlapping items on one timeline track: each item gets the first row it fits in.
  function stackRows(items) {
    const rowEnds = [];
    const rows = new Map();
    [...items].sort((a, b) => a.start - b.start).forEach(item => {
      let row = rowEnds.findIndex(end => end <= item.start);
      if (row === -1) { row = rowEnds.length; rowEnds.push(0); }
      rowEnds[row] = item.end;
      rows.set(item, row);
    });
    return { rows, count: Math.max(1, rowEnds.length) };
  }

  const api = { MAX_SECONDS, MIN_LENGTH, ZOOM_EASE, FONTS, TEXT_STYLE, textStyle, fontCss, rgba, normalizeEdits, fitToDuration, placeAt, textsAt, viewAt, zoomView, stackRows };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.editTiming = api;
})(typeof window !== 'undefined' ? window : globalThis);
