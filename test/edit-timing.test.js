const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEdits, fitToDuration, placeAt, textsAt, zoomAt, zoomView, stackRows, MAX_SECONDS } = require('../edit-timing');

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} is not ${expected}`);

test('text shows only between its start and end', () => {
  const items = [{ text: 'a', start: 1, end: 3 }, { text: 'b', start: 2, end: 5 }];
  assert.deepEqual(textsAt(items, 0.5).map(item => item.text), []);
  assert.deepEqual(textsAt(items, 1).map(item => item.text), ['a']);
  assert.deepEqual(textsAt(items, 2.5).map(item => item.text), ['a', 'b']);
  assert.deepEqual(textsAt(items, 3).map(item => item.text), ['b'], 'the end is exclusive');
});

test('zoom eases in, holds, eases out, and is off outside its time', () => {
  const zooms = [{ level: 2, x: 30, y: 70, start: 2, end: 6 }];
  assert.deepEqual(zoomAt(zooms, 1), { level: 1, x: 50, y: 50 });
  near(zoomAt(zooms, 2).level, 1, 'starts unzoomed');
  near(zoomAt(zooms, 2.2).level, 1.5, 'halfway through the ramp');
  near(zoomAt(zooms, 4).level, 2, 'holds');
  assert.equal(zoomAt(zooms, 4).x, 30);
  near(zoomAt(zooms, 5.8).level, 1.5, 'eases out');
  assert.deepEqual(zoomAt(zooms, 6), { level: 1, x: 50, y: 50 });
  // short zooms ease over a third of their length each way
  near(zoomAt([{ level: 3, x: 50, y: 50, start: 0, end: 0.6 }], 0.3).level, 3, 'short zoom still reaches its level');
  // the later one wins where two overlap
  assert.equal(zoomAt([...zooms, { level: 3, x: 10, y: 10, start: 3, end: 5 }], 4).level, 3);
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
  assert.deepEqual(old.zooms, [{ level: 1.5, x: 50, y: 50, start: 0, end: MAX_SECONDS }]);
  assert.deepEqual(old.textItems, [{ text: 'Hi', x: 10, y: 20, start: 0, end: MAX_SECONDS }]);
  assert.deepEqual(normalizeEdits({ zoomLevel: 1 }).zooms, []);
  const messy = normalizeEdits({ zooms: [{ level: 9, x: -5, y: 'a', start: 5, end: 2 }, null], textItems: [{ text: 7 }, { text: 'x'.repeat(900), start: -3 }] });
  assert.deepEqual(messy.zooms, [{ level: 3, x: 0, y: 50, start: 5, end: 5.2 }]);
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
