const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEdits, textStyle, fontCss, rgba, TEXT_STYLE, fitToDuration, placeAt, textsAt, viewAt, zoomView, stackRows, MAX_SECONDS } = require('../edit-timing');

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} is not ${expected}`);

test('text shows only between its start and end', () => {
  const items = [{ text: 'a', start: 1, end: 3 }, { text: 'b', start: 2, end: 5 }];
  assert.deepEqual(textsAt(items, 0.5).map(item => item.text), []);
  assert.deepEqual(textsAt(items, 1).map(item => item.text), ['a']);
  assert.deepEqual(textsAt(items, 2.5).map(item => item.text), ['a', 'b']);
  assert.deepEqual(textsAt(items, 3).map(item => item.text), ['b'], 'the end is exclusive');
});

test('zoom eases in, holds, eases out, and is off outside its time', () => {
  const zooms = [{ level: 2, x: 30, y: 70, ease: 0.8, start: 2, end: 6 }];
  assert.equal(viewAt(zooms, 1).level, 1);
  assert.deepEqual(viewAt(zooms, 1).box, { left: 0, top: 0, width: 1, height: 1 });
  near(viewAt(zooms, 2).level, 1, 'starts unzoomed');
  near(viewAt(zooms, 2.4).level, Math.SQRT2, 'halfway through the ease, in size terms');
  near(viewAt(zooms, 4).level, 2, 'holds');
  near(viewAt(zooms, 4).box.left, 0.05, 'aimed at its point');
  near(viewAt(zooms, 5.6).level, Math.SQRT2, 'eases out');
  near(viewAt(zooms, 6).level, 1, 'done at its end');
  // the ease is gentle at both ends: barely moving just after the start
  assert.ok(viewAt(zooms, 2.04).level < 1.001);
  // short zooms ease over a third of their length each way
  near(viewAt([{ level: 3, x: 50, y: 50, ease: 0.8, start: 0, end: 0.6 }], 0.3).level, 3, 'short zoom still reaches its level');
});

test('zoom pivots around one point instead of drifting', () => {
  const zooms = [{ level: 3, x: 90, y: 10, ease: 1, start: 0, end: 10 }];
  // the end view's top-right corner area: the fixed point is where the frame and the zoomed box line up
  const target = viewAt(zooms, 5).box;
  const pivotX = target.left / (1 - target.width), pivotY = target.top / (1 - target.height);
  for (const time of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const box = viewAt(zooms, time).box;
    near(box.left + box.width * pivotX, pivotX, `x stays put at ${time}`);
    near(box.top + box.height * pivotY, pivotY, `y stays put at ${time}`);
    assert.ok(box.left >= 0 && box.left + box.width <= 1 + 1e-9, 'stays inside the picture');
  }
});

test('zooms inside or next to each other glide instead of jumping', () => {
  const outer = { level: 2, x: 50, y: 50, ease: 0.5, start: 0, end: 10 };
  const inner = { level: 3, x: 20, y: 20, ease: 0.5, start: 4, end: 6 };
  near(viewAt([outer, inner], 3.9).level, 2, 'outer zoom before');
  near(viewAt([outer, inner], 4).level, 2, 'inner zoom starts from the outer view');
  near(viewAt([outer, inner], 5).level, 3, 'then holds its own');
  near(viewAt([outer, inner], 6).level, 2, 'and returns to the outer view');
  assert.ok(viewAt([outer, inner], 4.25).level > 2 && viewAt([outer, inner], 4.25).level < 3);
  // back to back, with a small gap: no zooming out in between
  const a = { level: 2, x: 20, y: 50, ease: 0.5, start: 0, end: 3 }, b = { level: 2, x: 80, y: 50, ease: 0.5, start: 3.1, end: 6 };
  for (const time of [2.8, 3, 3.05, 3.3]) near(viewAt([a, b], time).level, 2, `stays zoomed at ${time}`);
  assert.ok(viewAt([a, b], 3.35).box.left > viewAt([a, b], 3.1).box.left, 'pans across');
  near(viewAt([a, b], 5.99).level, 2 ** (t => t * t * t * (t * (t * 6 - 15) + 10))(0.02), 'the last one still eases out');
  // far apart: each zooms out on its own
  near(viewAt([a, { ...b, start: 4 }], 3.5).level, 1);
});

test('zoom view keeps the picture filling the frame', () => {
  const centre = zoomView({ level: 2, x: 50, y: 50 });
  near(centre.tx, -0.5, 'centred x');
  assert.deepEqual(centre.box, { left: 0.25, top: 0.25, width: 0.5, height: 0.5 });
  // pointing at a corner stops at the edge instead of showing past the picture
  const corner = zoomView({ level: 2, x: 0, y: 100 });
  assert.deepEqual(corner.box, { left: 0, top: 0.5, width: 0.5, height: 0.5 });
  near(corner.tx, 0, 'left edge stays put');
  near(corner.ty, -1, 'bottom edge stays put');
  assert.deepEqual(zoomView({ level: 1, x: 10, y: 90 }), { level: 1, tx: 0, ty: 0, box: { left: 0, top: 0, width: 1, height: 1 } });
});

test('older projects become whole-clip edits, and bad values are cleaned', () => {
  const old = normalizeEdits({ zoomLevel: 1.5, cropEnabled: true, textItems: [{ text: 'Hi', x: 10, y: 20 }] });
  assert.equal(old.cropEnabled, true);
  assert.deepEqual(old.zooms, [{ level: 1.5, x: 50, y: 50, ease: 0.8, start: 0, end: MAX_SECONDS }]);
  assert.deepEqual(old.textItems, [{ text: 'Hi', x: 10, y: 20, start: 0, end: MAX_SECONDS, ...TEXT_STYLE }]);
  assert.deepEqual(normalizeEdits({ zoomLevel: 1 }).zooms, []);
  const messy = normalizeEdits({ zooms: [{ level: 9, x: -5, y: 'a', start: 5, end: 2 }, null], textItems: [{ text: 7 }, { text: 'x'.repeat(900), start: -3 }] });
  assert.deepEqual(messy.zooms, [{ level: 3, x: 0, y: 50, ease: 0.8, start: 5, end: 5.2 }]);
  assert.deepEqual(normalizeEdits({ zooms: [{ ease: 9 }, { ease: 0 }, { ease: 1.26 }] }).zooms.map(zoom => zoom.ease), [2, 0.2, 1.3]);
  assert.equal(messy.textItems.length, 1);
  assert.equal(messy.textItems[0].text.length, 500);
  assert.equal(messy.textItems[0].start, 0);
  assert.deepEqual(normalizeEdits(), { cropEnabled: false, textItems: [], zooms: [] });
});

test('items are fitted to the clip, and new ones are placed at the playhead', () => {
  const items = [{ start: 0, end: MAX_SECONDS }, { start: 9, end: 12 }];
  fitToDuration(items, 10);
  assert.deepEqual(items, [{ start: 0, end: 10 }, { start: 9, end: 10 }]);
  assert.deepEqual(placeAt(2, 10), { start: 2, end: 5 });
  assert.deepEqual(placeAt(9, 10), { start: 7, end: 10 }, 'moved back to fit');
  assert.deepEqual(placeAt(1, 2), { start: 0, end: 2 }, 'a short clip gets the whole clip');
});

test('overlapping items stack into rows', () => {
  const a = { start: 0, end: 4 }, b = { start: 2, end: 6 }, c = { start: 4, end: 8 };
  const { rows, count } = stackRows([c, b, a]);
  assert.equal(count, 2);
  assert.equal(rows.get(a), 0);
  assert.equal(rows.get(b), 1);
  assert.equal(rows.get(c), 0, 'reuses a row once it is free');
  assert.equal(stackRows([]).count, 1);
});

test('text style is cleaned, and turned into a font and colours', () => {
  assert.deepEqual(textStyle({}), TEXT_STYLE);
  assert.deepEqual(textStyle({ font: 'georgia', size: 500, bold: false, italic: true, color: '#FF0000', background: 'red', backgroundOpacity: -4 }),
    { font: 'georgia', size: 200, bold: false, italic: true, color: '#ff0000', background: '#000000', backgroundOpacity: 0 });
  assert.equal(textStyle({ font: 'url(evil)' }).font, 'manrope', 'only known fonts');
  assert.equal(fontCss({ font: 'impact', bold: true, italic: true }, 30), "italic 700 30px Impact, 'Arial Black', sans-serif");
  assert.equal(fontCss({ font: 'dm-mono', bold: false }, 12.5), "400 12.5px 'DM Mono', monospace");
  assert.equal(rgba('#ff8000', 55), 'rgba(255, 128, 0, 0.55)');
});
