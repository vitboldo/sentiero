import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoute } from '../src/core/route.js';
import { matchPosition } from '../src/core/matcher.js';
import { enu, mkTrack, dense, rng, gauss, planar } from './util.test.js';

const T0 = 1_700_000_000_000;

/** Percorso in metri -> Route. */
function routeOf(vertices, step = 10) {
  return buildRoute([mkTrack('t', dense(vertices, step))]);
}

/** Posizione (metri) a lunghezza d'arco s lungo una spezzata densa. */
function makeWalker(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return {
    total: cum[cum.length - 1],
    at(s) {
      const c = Math.min(cum[cum.length - 1], Math.max(0, s));
      let i = 1;
      while (i < cum.length - 1 && cum[i] < c) i++;
      const t = (c - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    },
  };
}

/**
 * Simula un escursionista che segue la spezzata con rumore GPS gaussiano.
 * Il prev passato al matcher si comporta come quello del tracker: il timestamp avanza
 * solo quando il progresso e' confermato.
 */
function simulate(route, pts, { speed = 1.4, sigma = 4, acc = 10, seed = 1, step = 1 } = {}) {
  const w = makeWalker(pts);
  const rnd = rng(seed);
  const out = [];
  let prev = null;
  for (let k = 0; k * speed * step <= w.total; k++) {
    const s = k * speed * step;
    const [e, n] = w.at(s);
    const ts = T0 + k * step * 1000;
    const fix = { ...enu(e + gauss(rnd) * sigma, n + gauss(rnd) * sigma), accuracy: acc, timestamp: ts };
    const r = matchPosition(route, fix, prev);
    out.push({ s, r });
    prev = {
      distAlong: r.distAlong,
      timestamp: !r.offTrack && !r.pendingJump ? ts : (prev ? prev.timestamp : ts),
      pendingJump: r.pendingJump,
    };
  }
  return out;
}

function assertMonotonic(out, label) {
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].r.distAlong >= out[i - 1].r.distAlong - 1e-9,
      `${label}: progresso sceso al fix ${i}: ${out[i - 1].r.distAlong} -> ${out[i].r.distAlong}`);
  }
}

function assertTracks(out, tol, label) {
  let worst = 0;
  for (let i = 0; i < out.length; i++) {
    const err = Math.abs(out[i].r.distAlong - out[i].s);
    worst = Math.max(worst, err);
    assert.ok(err <= tol, `${label}: fix ${i}, atteso ${out[i].s.toFixed(0)} m, ottenuto ${out[i].r.distAlong.toFixed(0)} m`);
  }
  return worst;
}

test('matcher: prima posizione = punto piu\' vicino, distanza e offTrackM corretti', () => {
  const route = routeOf([[0, 0], [1000, 0]]);
  const r = matchPosition(route, { ...enu(400, 25), accuracy: 8, timestamp: T0 }, null);
  assert.ok(Math.abs(r.distAlong - 400) < 1.5, String(r.distAlong));
  assert.ok(Math.abs(r.offTrackM - 25) < 0.5);
  assert.equal(r.offTrack, false);
  assert.equal(r.ambiguous, false);
  assert.ok(planar(r, enu(400, 0)) < 1.5);
  assert.equal(r.pendingJump, null);
  const far = matchPosition(route, { ...enu(400, 80), accuracy: 8, timestamp: T0 }, null);
  assert.equal(far.offTrack, true);
  assert.ok(Math.abs(far.offTrackM - 80) < 0.5);
});

test('matcher: soglia fuori traccia = max(50, 1.5*accuracy)', () => {
  const route = routeOf([[0, 0], [1000, 0]]);
  const at = (d, acc) => matchPosition(route, { ...enu(500, d), accuracy: acc, timestamp: T0 }, { distAlong: 500, timestamp: T0 - 1000 });
  assert.equal(at(45, 8).offTrack, false);
  assert.equal(at(55, 8).offTrack, true);
  assert.equal(at(70, 60).offTrack, false, 'con accuracy 60 la soglia sale a 90 m');
  assert.equal(at(95, 60).offTrack, true);
});

test('matcher: andata e ritorno a 10 m, mai sul ramo sbagliato, progresso monotono', () => {
  const verts = [[0, 0], [0, 2000], [10, 2000], [10, 0]];
  const route = routeOf(verts);
  const pts = dense(verts, 10);
  for (const seed of [1, 2, 3, 4, 5]) {
    const out = simulate(route, pts, { sigma: 3.5, acc: 8, seed });
    assertMonotonic(out, `seed ${seed}`);
    const worst = assertTracks(out, 40, `seed ${seed}`);
    assert.ok(worst < 40);
    assert.equal(out.some((o) => o.r.offTrack), false, 'rimane sempre in traccia');
  }
});

test('matcher: andata e ritorno, ritorno da meta\' percorso (3 m di scarto laterale sistematico)', () => {
  // il ritorno e' percorso 4 m verso il ramo dell'andata: ancora vicino al proprio ramo (6 m) piu' che all'altro (4 m
  // dalla parte sbagliata); la continuita' di progresso deve vincere
  const verts = [[0, 0], [0, 1500], [10, 1500], [10, 0]];
  const route = routeOf(verts);
  const walk = dense([[0, 0], [0, 1500], [6, 1500], [6, 0]], 10);
  const out = simulate(route, walk, { sigma: 1.5, acc: 6, seed: 9 });
  assertMonotonic(out, 'bias');
  // lunghezza del percorso camminato != route: confronto sul ramo (ritorno => dist > 1500)
  const ret = out.filter((o) => o.s > 1560);
  assert.ok(ret.length > 100);
  for (const o of ret) assert.ok(o.r.distAlong > 1500, `fix di ritorno agganciato al ramo di andata: ${o.r.distAlong}`);
  const outward = out.filter((o) => o.s < 1440);
  for (const o of outward) assert.ok(o.r.distAlong < 1520, `fix di andata agganciato al ritorno: ${o.r.distAlong}`);
});

test('matcher: andata e ritorno a 10 m con rumore forte (sigma 5 m), 20 percorsi', () => {
  const verts = [[0, 0], [0, 1200], [10, 1200], [10, 0]];
  const route = routeOf(verts);
  const pts = dense(verts, 10);
  for (let seed = 100; seed < 120; seed++) {
    const out = simulate(route, pts, { sigma: 5, acc: 10, seed, speed: 1.2 });
    assertMonotonic(out, `seed ${seed}`);
    assertTracks(out, 60, `seed ${seed}`);
  }
});

test('matcher: primo fix su andata/ritorno sovrapposti -> primo passaggio, ambiguous', () => {
  const verts = [[0, 0], [0, 1000], [10, 1000], [10, 0]];
  const route = routeOf(verts);
  const r = matchPosition(route, { ...enu(5, 400), accuracy: 8, timestamp: T0 }, null);
  assert.equal(r.ambiguous, true);
  assert.ok(r.distAlong < 450 && r.distAlong > 350, `primo passaggio: ${r.distAlong}`);
});

test('matcher: anello con partenza e arrivo sovrapposti', () => {
  const verts = [[0, 0], [400, 0], [400, 400], [0, 400], [0, 0]];
  const route = routeOf(verts);
  for (const seed of [1, 2, 3]) {
    const out = simulate(route, dense(verts, 10), { sigma: 4, acc: 10, seed });
    assertMonotonic(out, 'anello');
    assertTracks(out, 40, 'anello');
    assert.equal(out[0].r.ambiguous, true, 'partenza = arrivo: ambiguo');
    assert.ok(out[0].r.distAlong < 40, 'si parte dal primo passaggio');
    assert.ok(out[out.length - 1].r.distAlong > route.totalDist - 40, 'a fine anello non torna a 0');
  }
});

test('matcher: anello percorso con un fix al ritorno a casa dopo lunga pausa non resta a 0', () => {
  const verts = [[0, 0], [400, 0], [400, 400], [0, 400], [0, 0]];
  const route = routeOf(verts);
  const r = matchPosition(route, { ...enu(5, 3), accuracy: 8, timestamp: T0 + 1000_000 }, { distAlong: 1500, timestamp: T0 });
  assert.ok(r.distAlong > 1590, String(r.distAlong));
});

test('matcher: otto con autoincrocio, nessuno scambio ai due passaggi', () => {
  const verts = [[-300, -300], [300, 300], [-300, 300], [300, -300], [-300, -300]];
  const route = routeOf(verts);
  for (const seed of [1, 2, 3, 4]) {
    const out = simulate(route, dense(verts, 10), { sigma: 4, acc: 10, seed });
    assertMonotonic(out, 'otto');
    assertTracks(out, 40, 'otto');
  }
  // dopo un passaggio dall'incrocio il secondo passaggio e' riconosciuto come tale
  const cross1 = route.cumDist.findIndex((_, i) => Math.abs(route.points[i].lat - enu(0, 0).lat) < 5e-5 && Math.abs(route.points[i].lon - enu(0, 0).lon) < 6e-5);
  assert.ok(cross1 > 0);
});

test('matcher: rumore GPS forte ma in traccia', () => {
  const verts = [[0, 0], [800, 200], [1500, 900], [2500, 900]];
  const route = routeOf(verts);
  const out = simulate(route, dense(verts, 10), { sigma: 6, acc: 15, seed: 21 });
  assertMonotonic(out, 'rumore');
  const worst = assertTracks(out, 30, 'rumore');
  assert.ok(worst < 30);
  assert.equal(out.filter((o) => o.r.offTrack).length, 0);
});

/** Serpentina con tratti paralleli a 200 m. */
const ZIG = [[0, 0], [1000, 0], [1000, 200], [0, 200], [0, 400], [1000, 400]];

test('matcher: scorciatoia deliberata -> salto solo dopo 3 fix consecutivi coerenti', () => {
  const route = routeOf(ZIG);
  let prev = { distAlong: 500, timestamp: T0, pendingJump: null };
  // cammina dritto a nord da (500,0) verso il terzo tratto (y=400)
  const results = [];
  for (let k = 1; k <= 400; k += 1) {
    const y = k * 1.4;
    const ts = T0 + k * 1000;
    const r = matchPosition(route, { ...enu(500, y), accuracy: 8, timestamp: ts }, prev);
    results.push({ y, r });
    prev = {
      distAlong: r.distAlong,
      timestamp: !r.offTrack && !r.pendingJump ? ts : prev.timestamp,
      pendingJump: r.pendingJump,
    };
    if (r.pendingJump === null && r.distAlong > 1000) break;
  }
  // il primo fix che torna in traccia sul secondo tratto (y=200) e' alla distanza ~ 1000+200+500 = 1700
  const firstPending = results.findIndex((x) => x.r.pendingJump);
  assert.ok(firstPending > 0, 'deve esserci uno stato di attesa');
  const { r: r1 } = results[firstPending];
  const { r: r2 } = results[firstPending + 1];
  const { r: r3 } = results[firstPending + 2];
  assert.equal(r1.pendingJump.count, 1);
  assert.equal(r2.pendingJump.count, 2);
  assert.ok(Math.abs(r1.pendingJump.distAlong - 1700) < 15, String(r1.pendingJump.distAlong));
  assert.ok(r1.distAlong < 520 && r2.distAlong < 520, 'progresso fermo mentre si attende la conferma');
  assert.equal(r3.pendingJump, null);
  assert.ok(Math.abs(r3.distAlong - 1700) < 15, `salto confermato: ${r3.distAlong}`);
  assert.equal(r3.offTrack, false);
  // prima della conferma non c'e' mai stato un salto
  for (const { r } of results.slice(0, firstPending + 2)) assert.ok(r.distAlong < 520);
});

test('matcher: 2 fix sul tratto lontano poi ritorno sul sentiero -> nessun salto, attesa azzerata', () => {
  const route = routeOf(ZIG);
  const mk = (e, n, k) => ({ ...enu(e, n), accuracy: 8, timestamp: T0 + k * 1000 });
  let prev = { distAlong: 500, timestamp: T0, pendingJump: null };
  const a = matchPosition(route, mk(500, 195, 1), prev);
  assert.equal(a.pendingJump.count, 1);
  const b = matchPosition(route, mk(500, 196, 2), { distAlong: a.distAlong, timestamp: T0, pendingJump: a.pendingJump });
  assert.equal(b.pendingJump.count, 2);
  const c = matchPosition(route, mk(505, 3, 3), { distAlong: b.distAlong, timestamp: T0, pendingJump: b.pendingJump });
  assert.equal(c.pendingJump, null);
  assert.ok(Math.abs(c.distAlong - 505) < 5, String(c.distAlong));
  // un nuovo fix lontano riparte da 1
  const d = matchPosition(route, mk(500, 195, 4), { distAlong: c.distAlong, timestamp: T0 + 3000, pendingJump: c.pendingJump });
  assert.equal(d.pendingJump.count, 1);
});

test('matcher: fix lontani ma non coerenti tra loro non confermano il salto', () => {
  const route = routeOf(ZIG);
  const mk = (e, n, k) => ({ ...enu(e, n), accuracy: 8, timestamp: T0 + k * 1000 });
  let prev = { distAlong: 500, timestamp: T0, pendingJump: null };
  const r1 = matchPosition(route, mk(500, 200, 1), prev);                // tratto 2 a ~1700
  prev = { distAlong: r1.distAlong, timestamp: T0, pendingJump: r1.pendingJump };
  const r2 = matchPosition(route, mk(100, 400, 2), prev);                // tratto 3 a ~2300 (lontano da 1700)
  assert.equal(r2.pendingJump.count, 1);
  assert.ok(r2.distAlong < 520);
});

test('matcher: fuori traccia mantiene il progresso, lat/lon puntano al punto piu\' vicino', () => {
  const route = routeOf(ZIG);
  const prev = { distAlong: 500, timestamp: T0, pendingJump: null };
  const r = matchPosition(route, { ...enu(500, -120), accuracy: 8, timestamp: T0 + 5000 }, prev);
  assert.equal(r.offTrack, true);
  assert.ok(Math.abs(r.distAlong - 500) < 1e-6, String(r.distAlong));
  assert.ok(Math.abs(r.offTrackM - 120) < 1);
  assert.ok(planar(r, enu(500, 0)) < 1.5);
  assert.equal(r.pendingJump, null);
  // anche se il punto piu' vicino in assoluto sarebbe altrove, il progresso non cambia
  const r2 = matchPosition(route, { ...enu(1100, 100), accuracy: 8, timestamp: T0 + 6000 }, { distAlong: r.distAlong, timestamp: T0, pendingJump: null });
  assert.equal(r2.offTrack, true);
  assert.ok(Math.abs(r2.distAlong - 500) < 1e-6);
});

test('matcher: i salti tra tracce non sono segmenti percorribili', () => {
  const a = mkTrack('a', dense([[0, 0], [0, 500]], 10));
  const b = mkTrack('b', dense([[0, 1500], [0, 2000]], 10));
  const route = buildRoute([a, b]);
  const r = matchPosition(route, { ...enu(0, 1000), accuracy: 8, timestamp: T0 }, null);
  assert.equal(r.offTrack, true);
  assert.ok(r.offTrackM > 450, `offTrackM ${r.offTrackM}`);
  // nel punto di mezzo del "buco" non e' in traccia, e la distanza non e' quella del salto
  const inB = matchPosition(route, { ...enu(0, 1600), accuracy: 8, timestamp: T0 }, null);
  assert.ok(Math.abs(inB.distAlong - (route.trackRanges[1].startDist + 100)) < 3);
});

test('matcher: arretramento di rumore non fa scendere il progresso, vero ritorno si', () => {
  const route = routeOf([[0, 0], [1000, 0]]);
  const base = { distAlong: 600, timestamp: T0, pendingJump: null };
  const small = matchPosition(route, { ...enu(590, 2), accuracy: 8, timestamp: T0 + 1000 }, base);
  assert.equal(small.distAlong, 600);
  const back = matchPosition(route, { ...enu(450, 2), accuracy: 8, timestamp: T0 + 100_000 }, base);
  assert.ok(Math.abs(back.distAlong - 450) < 2, String(back.distAlong));
});

test('matcher: casi limite (route vuota, un punto)', () => {
  const empty = buildRoute([]);
  const r = matchPosition(empty, { ...enu(0, 0), accuracy: 5, timestamp: T0 }, null);
  assert.equal(r.offTrack, true);
  const one = buildRoute([mkTrack('p', [[0, 0, 1]])]);
  const r1 = matchPosition(one, { ...enu(10, 0), accuracy: 5, timestamp: T0 }, null);
  assert.equal(r1.distAlong, 0);
  assert.ok(Math.abs(r1.offTrackM - 10) < 0.5);
});

test('prestazioni: matchPosition su 50.000 punti, media < 20 ms', () => {
  // serpentine ampie, ~50.000 punti
  const verts = [];
  for (let i = 0; i < 100; i++) {
    verts.push([i % 2 === 0 ? 0 : 5000, i * 100]);
    verts.push([i % 2 === 0 ? 5000 : 0, i * 100]);
  }
  const pts = dense(verts, 10);
  assert.ok(pts.length >= 50_000 - 1500 && pts.length <= 50_000 + 1500, `punti: ${pts.length}`);
  const route = buildRoute([mkTrack('big', pts.slice(0, 50_000))]);
  assert.ok(route.points.length >= 48_000);
  const rnd = rng(5);
  let prev = null;
  const N = 300;
  for (let w = 0; w < 20; w++) matchPosition(route, { ...enu(100, 100), accuracy: 10, timestamp: T0 }, null); // riscaldamento
  const t0 = performance.now();
  for (let k = 0; k < N; k++) {
    const idx = Math.floor(rnd() * route.points.length);
    const p = route.points[idx];
    const r = matchPosition(route, { lat: p.lat + (rnd() - 0.5) * 1e-4, lon: p.lon, accuracy: 10, timestamp: T0 + k * 1000 }, prev);
    prev = { distAlong: r.distAlong, timestamp: T0 + k * 1000, pendingJump: r.pendingJump };
  }
  const avg = (performance.now() - t0) / N;
  console.log(`# matchPosition: ${avg.toFixed(2)} ms/chiamata su ${route.points.length} punti`);
  assert.ok(avg < 20, `media ${avg.toFixed(2)} ms`);
});
