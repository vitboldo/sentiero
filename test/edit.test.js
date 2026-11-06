import test from 'node:test';
import assert from 'node:assert/strict';
import { renameTrack, toggleReverse, trimTrack, mergeTracks, removeWaypoint, restoreOriginal } from '../src/core/edit.js';
import { effectivePoints, buildRoute, reverseSession } from '../src/core/route.js';
import { mkTrack, planar, enu } from './util.test.js';

const line = (id, n, extra = {}) =>
  mkTrack(id, Array.from({ length: n }, (_, i) => [0, i * 100, i]), extra);

test('renameTrack: immutabile, salva original alla prima modifica e non lo sovrascrive', () => {
  const t = line('a', 5);
  const r1 = renameTrack(t, 'Nuovo');
  assert.equal(t.name, 'a');
  assert.equal(t.original, null);
  assert.equal(r1.name, 'Nuovo');
  assert.equal(r1.original.name, 'a');
  assert.strictEqual(r1.original.points, t.points);
  const r2 = renameTrack(r1, 'Ancora');
  assert.equal(r2.original.name, 'a');
});

test('toggleReverse inverte solo il flag', () => {
  const t = line('a', 4);
  const r = toggleReverse(t);
  assert.equal(r.reversed, true);
  assert.strictEqual(r.points, t.points);
  assert.equal(toggleReverse(r).reversed, false);
  assert.equal(t.reversed, false);
});

test('trimTrack su traccia normale: indici su effectivePoints, inclusi', () => {
  const t = line('a', 10);
  const r = trimTrack(t, 2, 6);
  assert.deepEqual(r.points.map((p) => p.ele), [2, 3, 4, 5, 6]);
  assert.equal(r.original.points.length, 10);
  assert.equal(t.points.length, 10);
});

test('trimTrack su traccia invertita tiene la parte giusta e resta coerente', () => {
  const t = line('a', 10, { reversed: true }); // direzione effettiva: ele 9,8,...,0
  const r = trimTrack(t, 1, 3); // effettivi: 8,7,6
  assert.equal(r.reversed, true);
  assert.deepEqual(effectivePoints(r).map((p) => p.ele), [8, 7, 6]);
  assert.deepEqual(r.points.map((p) => p.ele), [6, 7, 8], 'points resta nell\'ordine del file');
  // il resto della traccia (inizio in marcia) e' stato davvero tagliato
  const full = trimTrack(t, 0, 9);
  assert.deepEqual(effectivePoints(full).map((p) => p.ele), [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
});

test('trimTrack: indici non validi lanciano', () => {
  const t = line('a', 5);
  for (const [s, e] of [[-1, 3], [0, 5], [3, 3], [4, 2], [0.5, 2]]) {
    assert.throws(() => trimTrack(t, s, e), RangeError, `${s},${e}`);
  }
});

test('mergeTracks usa le direzioni effettive, risultato non invertito', () => {
  const a = mkTrack('a', [[0, 0, 0], [0, 100, 1], [0, 200, 2]]);
  const b = mkTrack('b', [[0, 300, 3], [0, 400, 4], [0, 500, 5]], { reversed: true }); // effettivi 5,4,3
  const m = mergeTracks(a, b, 'm');
  assert.equal(m.id, 'm');
  assert.equal(m.reversed, false);
  assert.deepEqual(m.points.map((p) => p.ele), [0, 1, 2, 5, 4, 3]);
  assert.equal(m.visible, true);
  assert.equal(m.original, null);
  assert.equal(a.points.length, 3);
});

test('merge di tracce invertite (reverseSession) mantiene continuita\' di marcia', () => {
  const a = mkTrack('a', [[0, 0, 0], [0, 100, 1]]);
  const b = mkTrack('b', [[0, 100, 1], [0, 200, 2]]);
  const [b2, a2] = reverseSession([a, b]); // percorso: b invertito poi a invertita
  const m = mergeTracks(b2, a2, 'm');
  assert.deepEqual(m.points.map((p) => p.ele), [2, 1, 0],'il punto di giunzione coincidente non e\' duplicato');
  const r = buildRoute([m]);
  assert.ok(Math.abs(r.totalDist - 200) < 0.5);
});

test('merge: waypoint concatenati', () => {
  const w = (name) => ({ ...enu(0, 0), name });
  const a = line('a', 3, { waypoints: [w('x')] });
  const b = line('b', 3, { waypoints: [w('y')] });
  assert.deepEqual(mergeTracks(a, b, 'm').waypoints.map((x) => x.name), ['x', 'y']);
});

test('removeWaypoint e restoreOriginal', () => {
  const w = (name) => ({ ...enu(0, 0), name });
  const t = line('a', 6, { waypoints: [w('uno'), w('due'), w('tre')] });
  const r = removeWaypoint(t, 1);
  assert.deepEqual(r.waypoints.map((x) => x.name), ['uno', 'tre']);
  assert.equal(t.waypoints.length, 3);
  assert.throws(() => removeWaypoint(t, 3), RangeError);
  const edited = trimTrack(renameTrack(r, 'Corta'), 1, 3);
  assert.equal(edited.points.length, 3);
  const back = restoreOriginal(edited);
  assert.equal(back.name, 'a');
  assert.equal(back.points.length, 6);
  assert.deepEqual(back.waypoints.map((x) => x.name), ['uno', 'due', 'tre']);
  assert.equal(back.original, null);
  assert.strictEqual(restoreOriginal(t), t, 'senza original non cambia nulla');
  assert.ok(planar(back.points[5], t.points[5]) === 0);
});
