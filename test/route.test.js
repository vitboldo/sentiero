import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoute, effectivePoints, statsAt, remainingFrom, reverseSession, munterSeconds, routeTimeSeconds,
} from '../src/core/route.js';
import { haversineM, bearingDeg, projectToSegment, interpolate, formatKm, formatDuration } from '../src/core/geo.js';
import { enu, mkTrack, dense, rng, planar } from './util.test.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} atteso ${b} ±${tol}, ottenuto ${a}`);

/** Salita lineare 0->h su L metri, poi discesa a 0 su L metri, passo 10 m. */
function hill(h, L, extra = {}) {
  const pts = dense([[0, 0], [0, L], [0, 2 * L]], 10).map(([e, n]) => [e, n, n <= L ? (h * n) / L : (h * (2 * L - n)) / L]);
  return mkTrack('hill', pts, extra);
}

test('geo: haversine, bearing, proiezione, interpolazione', () => {
  // un grado di latitudine = pi/180 * 6371008.8 m
  near(haversineM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 111195.08, 0.5);
  near(haversineM({ lat: 46, lon: 10 }, { lat: 46, lon: 10 }), 0, 1e-9);
  near(bearingDeg({ lat: 46, lon: 10 }, { lat: 47, lon: 10 }), 0, 1e-6);
  near(bearingDeg({ lat: 0, lon: 10 }, { lat: 0, lon: 11 }), 90, 1e-6);
  near(bearingDeg({ lat: 46, lon: 10 }, { lat: 45, lon: 10 }), 180, 1e-6);
  near(bearingDeg({ lat: 0, lon: 10 }, { lat: 0, lon: 9 }), 270, 1e-6);
  const a = enu(0, 0);
  const b = enu(100, 0);
  const pr = projectToSegment(enu(40, 30), a, b);
  near(pr.t, 0.4, 1e-3);
  near(pr.distM, 30, 0.05);
  assert.equal(projectToSegment(enu(-50, 0), a, b).t, 0);
  assert.equal(projectToSegment(enu(500, 0), a, b).t, 1);
  assert.equal(projectToSegment(enu(5, 5), a, a).t, 0);
  const mid = interpolate({ lat: 0, lon: 0, ele: 10 }, { lat: 2, lon: 4, ele: 20 }, 0.5);
  assert.deepEqual(mid, { lat: 1, lon: 2, ele: 15 });
  assert.equal(interpolate({ lat: 0, lon: 0, ele: 10 }, { lat: 2, lon: 4, ele: null }, 0.5).ele, null);
  assert.equal(formatKm(850), '850 m');
  assert.equal(formatKm(12340), '12,3 km');
  assert.equal(formatDuration(45 * 60), '45 min');
  assert.equal(formatDuration(3600 * 2 + 300), '2 h 05 min');
});

test('route: distanza, D+ e D- di una collina nota', () => {
  const r = buildRoute([hill(200, 2000)]);
  near(r.totalDist, 4000, 4);
  near(r.totalUp, 200, 6, 'D+');
  near(r.totalDown, 200, 6, 'D-');
  assert.equal(r.hasElevation, true);
  assert.equal(r.cumDist.length, r.points.length);
  assert.equal(r.trackRanges.length, 1);
  assert.equal(r.trackRanges[0].startIdx, 0);
  assert.equal(r.trackRanges[0].endIdx, r.points.length - 1);
});

test('route: il rumore sotto la soglia di isteresi non genera dislivello', () => {
  // pianura con rumore +-1.5 m
  const rnd = rng(7);
  const pts = dense([[0, 0], [0, 3000]], 10).map(([e, n]) => [e, n, 500 + (rnd() - 0.5) * 3]);
  const r = buildRoute([mkTrack('flat', pts)]);
  assert.ok(r.totalUp < 3, `D+ ${r.totalUp}`);
  assert.ok(r.totalDown < 3, `D- ${r.totalDown}`);
});

test('route: quote mancanti non rompono i totali; meno del 50% => hasElevation false', () => {
  const full = hill(200, 2000);
  const holes = { ...full, points: full.points.map((p, i) => (i % 5 === 2 ? { ...p, ele: null } : p)) };
  const r = buildRoute([holes]);
  near(r.totalUp, 200, 8);
  assert.equal(r.hasElevation, true);
  const mostlyMissing = { ...full, points: full.points.map((p, i) => (i % 3 === 0 ? p : { ...p, ele: null })) };
  const r2 = buildRoute([mostlyMissing]);
  assert.equal(r2.hasElevation, false);
  assert.equal(r2.totalUp, 0);
  assert.equal(r2.totalDown, 0);
});

test('route: tracce nascoste escluse; salti tra tracce non contano ma gapBeforeM si', () => {
  const a = mkTrack('a', dense([[0, 0], [0, 1000]], 10).map(([e, n]) => [e, n, 100]));
  const hidden = mkTrack('h', [[5000, 0], [5000, 100]], { visible: false });
  const b = mkTrack('b', dense([[0, 1500], [0, 2500]], 10).map(([e, n]) => [e, n, 100]));
  const r = buildRoute([a, hidden, b]);
  assert.equal(r.trackRanges.length, 2);
  near(r.totalDist, 2000, 3);
  near(r.trackRanges[1].gapBeforeM, 500, 1);
  assert.equal(r.trackRanges[0].gapBeforeM, 0);
  near(r.trackRanges[1].startDist, r.trackRanges[0].endDist, 1e-9);
  near(r.trackRanges[1].endDist - r.trackRanges[1].startDist, 1000, 2);
  assert.deepEqual(new Set(r.points.map((p) => p.trackId)), new Set(['a', 'b']));
});

test('route: statsAt e remainingFrom interpolano', () => {
  const r = buildRoute([hill(200, 2000)]);
  const s = statsAt(r, 1000);
  near(s.ele, 100, 0.5);
  near(s.lat, enu(0, 1000).lat, 2e-6);
  near(s.up, 100, 6);
  near(s.down, 0, 1);
  const rem = remainingFrom(r, 1000);
  near(rem.dist, r.totalDist - 1000, 1e-6);
  near(rem.up, r.totalUp - s.up, 1e-9);
  near(rem.down, r.totalDown, 1e-6);
  near(remainingFrom(r, 500, 1500).dist, 1000, 1e-9);
  // limiti
  assert.equal(statsAt(r, -5).up, 0);
  near(statsAt(r, 1e9).up, r.totalUp, 1e-9);
  assert.equal(remainingFrom(r, 1e9).dist, 0);
});

test('munter: formula di progetto', () => {
  assert.equal(munterSeconds(4000, 400, 0), 7200);
  assert.equal(munterSeconds(4000, 0, 800), 7200);
  assert.equal(munterSeconds(2000, 400, 400), 5400);
  assert.equal(munterSeconds(0, 0, 0), 0);
  const r = buildRoute([hill(200, 2000)]);
  const expected = munterSeconds(r.totalDist, r.totalUp, r.totalDown);
  near(routeTimeSeconds(r, 0), expected, 1e-6);
  // 4000 m piani + 200 m D+ e 200 m D-: 1h + max(0.5h, 0.25h) = 1.5 h circa
  near(routeTimeSeconds(r, 0), 5400, 150);
});

/** Profilo ondulato riproducibile. */
function rolling(seed) {
  const rnd = rng(seed);
  const pts = dense([[0, 0], [1500, 800], [2500, 2500], [4200, 3000], [6000, 6000]], 10).map(([e, n], i) => [
    e, n, 1000 + 300 * Math.sin(i / 70) + 80 * Math.sin(i / 13) + (rnd() - 0.5) * 2,
  ]);
  return mkTrack('rolling', pts);
}

test('inversione: distanza identica, D+ e D- si scambiano entro il 3%', () => {
  const t = rolling(11);
  const fwd = buildRoute([t]);
  const rev = buildRoute(reverseSession([t]));
  near(rev.totalDist, fwd.totalDist, 1e-6);
  assert.ok(fwd.totalUp > 500, 'profilo di prova abbastanza mosso');
  assert.ok(Math.abs(rev.totalDown - fwd.totalUp) / fwd.totalUp < 0.03, `D- inv ${rev.totalDown} vs D+ ${fwd.totalUp}`);
  assert.ok(Math.abs(rev.totalUp - fwd.totalDown) / fwd.totalDown < 0.03, `D+ inv ${rev.totalUp} vs D- ${fwd.totalDown}`);
  // il percorso invertito parte dove finiva l'originale
  near(planar(rev.points[0], fwd.points[fwd.points.length - 1]), 0, 1e-6);
});

test('inversione: collina semplice, D+ originale = D- invertito', () => {
  const t = hill(300, 1500);
  const rev = buildRoute(reverseSession([t]));
  const fwd = buildRoute([t]);
  near(rev.totalUp, fwd.totalDown, 6);
  near(rev.totalDown, fwd.totalUp, 6);
});

test('reverseSession: ordine invertito, flag invertiti, input intatto', () => {
  const a = mkTrack('a', [[0, 0], [0, 100]]);
  const b = mkTrack('b', [[0, 200], [0, 300]], { reversed: true });
  const c = mkTrack('c', [[0, 400], [0, 500]]);
  const input = [a, b, c];
  const out = reverseSession(input);
  assert.deepEqual(out.map((t) => t.id), ['c', 'b', 'a']);
  assert.deepEqual(out.map((t) => t.reversed), [true, false, true]);
  assert.deepEqual(input.map((t) => t.id), ['a', 'b', 'c']);
  assert.equal(b.reversed, true);
  // doppia inversione = identita'
  assert.deepEqual(reverseSession(out).map((t) => [t.id, t.reversed]), [['a', false], ['b', true], ['c', false]]);
  // il percorso e' percorso al contrario
  const r1 = buildRoute(input);
  const r2 = buildRoute(out);
  near(planar(r2.points[0], r1.points[r1.points.length - 1]), 0, 1e-6);
  near(planar(r2.points[r2.points.length - 1], r1.points[0]), 0, 1e-6);
});

test('effectivePoints rispetta reversed senza mutare', () => {
  const t = mkTrack('t', [[0, 0, 1], [0, 10, 2], [0, 20, 3]], { reversed: true });
  assert.deepEqual(effectivePoints(t).map((p) => p.ele), [3, 2, 1]);
  assert.deepEqual(t.points.map((p) => p.ele), [1, 2, 3]);
});
