import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoute } from '../src/core/route.js';
import { createTracker } from '../src/core/tracker.js';

const T0 = 1_700_000_000_000;
const route = () => buildRoute([{
  id: 'a', name: 'A', color: '#000', visible: true, reversed: false, waypoints: [], original: null,
  points: Array.from({ length: 111 }, (_, i) => ({ lat: 45 + i * 0.001, lon: 9, ele: null })),
}]);
const feed = (t, lat, sec, accuracy = 5) => {
  const now = T0 + sec * 1000;
  t.ingestFix({ lat, lon: 9, accuracy, timestamp: now }, now);
  return now;
};

test('dopo un mezzo di trasporto, fix precisi e coerenti ridiventano good', () => {
  const t = createTracker(route());
  feed(t, 45, 0);
  let now = feed(t, 45.09, 5);
  assert.equal(t.snapshot(now).quality, 'weak');
  for (const s of [10, 15]) now = feed(t, 45.09, s);
  assert.equal(t.snapshot(now).quality, 'weak');
  now = feed(t, 45.09, 20);
  const snap = t.snapshot(now);
  assert.equal(snap.quality, 'good');
  assert.equal(snap.lastSure.lat, 45.09);
});

test('un singolo punto aberrante non sposta l\'ultimo punto sicuro', () => {
  const t = createTracker(route());
  feed(t, 45, 0);
  feed(t, 45.09, 5);
  const now = feed(t, 45.0001, 10);
  const snap = t.snapshot(now);
  assert.equal(snap.quality, 'good');
  assert.equal(snap.lastSure.lat, 45.0001);
});

test('punti aberranti incoerenti tra loro non vengono mai accettati', () => {
  const t = createTracker(route());
  feed(t, 45, 0);
  let now;
  // 11 km avanti e indietro ogni 5 s: 2 km/s, impossibile anche per un mezzo.
  [5, 10, 15, 20, 25, 30].forEach((s, i) => { now = feed(t, i % 2 ? 45.1 : 45.0, s + 0); });
  // Il primo punto a 45.0 è plausibile e valido: conta che 45.1 non diventi mai lastSure.
  assert.notEqual(t.snapshot(now).lastSure.lat, 45.1);
});

test('la stima si ferma dopo 2 ore invece di portare a fine percorso', () => {
  const t = createTracker(route());
  feed(t, 45.01, 0);
  const oneHour = T0 + 3600 * 1000;
  assert.ok(t.snapshot(oneHour).estimate);
  assert.equal(t.snapshot(oneHour).source, 'stima');
  const threeHours = t.snapshot(T0 + 3 * 3600 * 1000);
  assert.equal(threeHours.estimate, null);
  assert.equal(threeHours.estimateUnavailableReason, 'troppo tempo senza GPS');
  assert.equal(threeHours.source, 'nessuna');
  assert.ok(Math.abs(threeHours.distAlong - t.snapshot(T0).distAlong) < 1);
  assert.equal(threeHours.lastSure.lat, 45.01);
});
