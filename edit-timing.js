// Timed edits: which text shows, how it looks, and how far the picture is zoomed at a moment of the clip.
// Shared by the editor preview and the export renderer, and loaded by the unit tests.
(function (root) {
  const MAX_SECONDS = 86400;
  const MIN_LENGTH = 0.2;
  const RAMP = 0.4; // seconds to ease into and out of a zoom
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

  // Older projects had one zoom for the whole clip and text without times or styles: they get the whole clip and
  // the original look.
  function normalizeEdits(edits = {}) {
    const textItems = (Array.isArray(edits.textItems) ? edits.textItems : []).slice(0, 100)
      .filter(item => item && typeof item.text === 'string')
      .map(item => ({ text: item.text.slice(0, 500), x: clamp(number(item.x, 38), 0, 100), y: clamp(number(item.y, 44), 0, 100), ...timing(item), ...textStyle(item) }));
    let zooms = (Array.isArray(edits.zooms) ? edits.zooms : []).slice(0, 100)
      .filter(item => item && typeof item === 'object')
      .map(item => ({ level: clamp(number(item.level, 1.5), 1.1, 3), x: clamp(number(item.x, 50), 0, 100), y: clamp(number(item.y, 50), 0, 100), ...timing(item) }));
    if (!Array.isArray(edits.zooms) && number(edits.zoomLevel, 1) > 1) {
      zooms = [{ level: clamp(number(edits.zoomLevel, 1), 1.1, 3), x: 50, y: 50, start: 0, end: MAX_SECONDS }];
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

  const ease = t => t * t * (3 - 2 * t);
  // The zoom at this moment: level 1 outside any zoom, easing in and out at the edges.
  // The latest-starting zoom wins where two overlap.
  function zoomAt(zooms, time) {
    const zoom = zooms.filter(item => active(item, time)).sort((a, b) => b.start - a.start)[0];
    if (!zoom) return { level: 1, x: 50, y: 50 };
    const ramp = Math.min(RAMP, (zoom.end - zoom.start) / 3);
    const progress = ramp > 0 ? Math.min(1, (time - zoom.start) / ramp, (zoom.end - time) / ramp) : 1;
    return { level: 1 + (zoom.level - 1) * ease(clamp(progress, 0, 1)), x: zoom.x, y: zoom.y };
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

  const api = { MAX_SECONDS, MIN_LENGTH, FONTS, TEXT_STYLE, textStyle, fontCss, rgba, normalizeEdits, fitToDuration, placeAt, textsAt, zoomAt, zoomView, stackRows };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.editTiming = api;
})(typeof window !== 'undefined' ? window : globalThis);
