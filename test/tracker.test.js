import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoute } from '../src/core/route.js';
import { createTracker } from '../src/core/tracker.js';
import { enu, mkTrack, dense } from './util.test.js';

const T0 = 1_700_000_000_000;
const S = 1000;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} atteso ${b} ±${tol}, ottenuto ${a}`);

/** 5 km dritti a nord, pianura: tempo Munter = 0,9 s per metro. */
function flatRoute(len = 5000) {
  return buildRoute([mkTrack('a', dense([[0, 0], [0, len]], 10).map(([e, n]) => [e, n, 100]))]);
}
/** Fix sul sentiero a quota n (m) al tempo now. */
const fixAt = (n, ts, accuracy = 8, e = 0) => ({ ...enu(e, n), accuracy, timestamp: ts });
/** Cammina da n0 a n1 a v m/s con un fix ogni `dt` s, a partire da t0. Restituisce l'ultimo istante. */
function walk(tr, n0, n1, v, t0, dt = 2, accuracy = 8) {
  const secs = (n1 - n0) / v;
  let t = t0;
  for (let k = 0; k * dt <= secs; k++) {
    t = t0 + k * dt * S;
    tr.ingestFix(fixAt(n0 + k * dt * v, t, accuracy), t);
  }
  return t;
}

test('tracker: nessun fix', () => {
  const route = flatRoute();
  const s = createTracker(route).snapshot(T0);
  assert.equal(s.quality, 'none');
  assert.equal(s.source, 'nessuna');
  assert.equal(s.gps, null);
  assert.equal(s.lastSure, null);
  assert.equal(s.estimate, null);
  assert.equal(s.distAlong, 0);
  near(s.remaining.dist, route.totalDist, 1e-6);
  assert.equal(s.done.dist, 0);
  assert.equal(s.justRecovered, null);
  assert.equal(s.currentTrack.index, 0);
});

test('tracker: sequenza good -> weak -> lost -> recuperato', () => {
  const route = flatRoute();
  const tr = createTracker(route);
  tr.ingestFix(fixAt(1000, T0, 8), T0);
  let s = tr.snapshot(T0);
  assert.equal(s.quality, 'good');
  assert.equal(s.source, 'gps');
  near(s.distAlong, 1000, 1.5);
  assert.equal(s.lastSure.onTrack, true);
  near(s.lastSure.distAlong, 1000, 1.5);
  assert.equal(s.lastSure.timestamp, T0);
  assert.equal(s.estimate, null);
  near(s.done.dist, 1000, 1.5);
  near(s.remaining.dist, 4000, 1.5);
  near(s.remaining.etaSec, 3600, 3);

  // fix debole (60 m): posizione approssimata, lastSure invariato
  tr.ingestFix(fixAt(1010, T0 + 10 * S, 60), T0 + 10 * S);
  s = tr.snapshot(T0 + 10 * S);
  assert.equal(s.quality, 'weak');
  assert.equal(s.source, 'approssimata');
  assert.equal(s.lastSure.timestamp, T0);
  assert.equal(s.estimate, null);
  near(s.distAlong, 1010, 1.5);

  // fix vecchio di 20 s, ultimo utile 20 s fa: ancora debole
  assert.equal(tr.snapshot(T0 + 30 * S).quality, 'weak');
  // 45 s dall'ultimo fix utilizzabile: non ancora perso
  assert.equal(tr.snapshot(T0 + 10 * S + 45 * S).quality, 'weak');

  // 46 s dopo: perso, con stima. Trascorsi 56 s dall'ultimo punto sicuro a 0,9 s/m = 62,2 m.
  const tLost = T0 + 10 * S + 46 * S;
  s = tr.snapshot(tLost);
  assert.equal(s.quality, 'lost');
  assert.equal(s.source, 'stima');
  assert.equal(s.estimateUnavailableReason, null);
  near(s.estimate.ageSec, 56, 1e-9);
  near(s.estimate.distAlong, s.lastSure.distAlong + 56 / 0.9, 0.5);
  near(s.estimate.maxDist, s.lastSure.distAlong + (56 * 1.4) / 0.9, 0.5);
  assert.equal(s.estimate.minDist, s.lastSure.distAlong);
  assert.equal(s.estimate.pace, 1);
  assert.equal(s.estimate.paceSource, 'predefinito');
  assert.equal(s.distAlong, s.estimate.distAlong);
  near(s.estimate.lat, enu(0, s.estimate.distAlong).lat, 2e-6);
  assert.equal(s.justRecovered, null);
  // il fix grezzo e' sempre l'ultimo ricevuto
  assert.equal(s.gps.timestamp, T0 + 10 * S);

  // rientro: fix buono a 1100 m, 70 s dopo l'ultimo punto sicuro (stima 1000 + 70/0.9 = 1077,8)
  const tBack = T0 + 70 * S;
  tr.ingestFix(fixAt(1100, tBack, 8), tBack);
  s = tr.snapshot(tBack + 5 * S);
  assert.equal(s.quality, 'good');
  assert.equal(s.source, 'gps');
  assert.ok(s.justRecovered, 'rientro segnalato');
  near(s.justRecovered.deltaM, 1100 - (1000 + 70 / 0.9), 2);
  assert.equal(s.lastSure.timestamp, tBack);
  near(s.lastSure.distAlong, 1100, 1.5);
  assert.equal(s.estimate, null);
  // la segnalazione dura 30 s
  assert.ok(tr.snapshot(tBack + 29 * S).justRecovered);
  assert.equal(tr.snapshot(tBack + 31 * S).justRecovered, null);
});

test('tracker: accuracy > 100 m e perso subito; 30..100 debole', () => {
  const route = flatRoute();
  const tr = createTracker(route);
  tr.ingestFix(fixAt(500, T0, 8), T0);
  tr.ingestFix(fixAt(502, T0 + 2 * S, 150), T0 + 2 * S);
  assert.equal(tr.snapshot(T0 + 2 * S).quality, 'lost');
  assert.equal(tr.snapshot(T0 + 2 * S).source, 'stima');
  tr.ingestFix(fixAt(504, T0 + 4 * S, 31), T0 + 4 * S);
  assert.equal(tr.snapshot(T0 + 4 * S).quality, 'weak');
  tr.ingestFix(fixAt(506, T0 + 6 * S, 30), T0 + 6 * S);
  assert.equal(tr.snapshot(T0 + 6 * S).quality, 'good');
});

test('tracker: timestamp vecchi non sono freschi (iOS al risveglio)', () => {
  const route = flatRoute();
  // nessun fix buono prima: un fix vecchio di 20 s non e' ne' good ne' lastSure
  const a = createTracker(route);
  a.ingestFix(fixAt(1000, T0 - 20 * S, 5), T0);
  let s = a.snapshot(T0);
  assert.notEqual(s.quality, 'good');
  assert.equal(s.quality, 'lost');
  assert.equal(s.lastSure, null);
  assert.equal(s.estimate, null);
  assert.equal(s.estimateUnavailableReason, 'nessun punto sicuro');
  assert.equal(s.source, 'nessuna');
  near(s.ageSec, 20, 1e-9);

  // 14 s e' fresco, 16 s no
  const b = createTracker(route);
  b.ingestFix(fixAt(1000, T0 - 14 * S, 5), T0);
  assert.equal(b.snapshot(T0).quality, 'good');
  const c = createTracker(route);
  c.ingestFix(fixAt(1000, T0 - 16 * S, 5), T0);
  assert.equal(c.snapshot(T0).quality, 'lost');

  // dopo un punto sicuro, un fix vecchio arrivato al risveglio non lo sovrascrive
  const d = createTracker(route);
  d.ingestFix(fixAt(1000, T0, 5), T0);
  const tWake = T0 + 120 * S;
  d.ingestFix(fixAt(1300, T0 + 60 * S, 5), tWake); // calcolato 60 s fa, consegnato ora
  s = d.snapshot(tWake);
  assert.equal(s.lastSure.timestamp, T0);
  near(s.lastSure.distAlong, 1000, 1.5);
  assert.equal(s.quality, 'lost');
  assert.equal(s.source, 'stima');
  // lo stesso istante con la stessa freschezza: la stima parte dall'ultimo punto sicuro
  near(s.estimate.ageSec, 120, 1e-9);
  near(s.estimate.distAlong, 1000 + 120 / 0.9, 0.5);

  // un fix piu' vecchio di quello gia' noto non fa arretrare lo stato
  const e = createTracker(route);
  e.ingestFix(fixAt(1000, T0, 5), T0);
  e.ingestFix(fixAt(100, T0 - 5 * S, 5), T0);
  assert.equal(e.snapshot(T0).gps.timestamp, T0);
  near(e.snapshot(T0).distAlong, 1000, 1.5);
});

test('tracker: stima limitata a fine route', () => {
  const route = flatRoute(5000);
  const tr = createTracker(route);
  tr.ingestFix(fixAt(4900, T0, 8), T0);
  const s = tr.snapshot(T0 + 3600 * S);
  assert.equal(s.quality, 'lost');
  assert.equal(s.estimate.distAlong, route.totalDist);
  assert.ok(s.estimate.maxDist <= route.totalDist);
  assert.equal(s.estimate.maxDist, route.totalDist);
  near(s.estimate.minDist, 4900, 1.5);
  near(s.estimate.lat, route.points[route.points.length - 1].lat, 1e-9);
  assert.equal(s.distAlong, route.totalDist);
  assert.equal(s.remaining.dist, 0);
  assert.equal(s.remaining.etaSec, 0);
  // il rapporto minDist <= distAlong <= maxDist vale a ogni istante
  for (const dt of [1, 50, 100, 300, 3000]) {
    const e = tr.snapshot(T0 + dt * S).estimate;
    if (!e) continue;
    assert.ok(e.minDist <= e.distAlong && e.distAlong <= e.maxDist, `dt ${dt}`);
  }
});

test('tracker: minDist e\' esattamente lastSure.distAlong', () => {
  const route = flatRoute();
  const tr = createTracker(route);
  tr.ingestFix(fixAt(2345, T0, 12), T0);
  const s = tr.snapshot(T0 + 200 * S);
  assert.equal(s.estimate.minDist, s.lastSure.distAlong);
  assert.ok(s.estimate.distAlong > s.estimate.minDist);
});

test('tracker: ultimo punto sicuro fuori traccia => nessuna stima, con motivo', () => {
  const route = flatRoute();
  const tr = createTracker(route);
  tr.ingestFix(fixAt(1000, T0, 8, 100), T0); // 100 m a est della traccia
  let s = tr.snapshot(T0);
  assert.equal(s.quality, 'good');
  assert.equal(s.lastSure.onTrack, false);
  assert.equal(s.offTrack, true);
  near(s.offTrackM, 100, 1);
  near(s.bearingToTrackDeg, 270, 2);
  near(s.nearest.lat, enu(0, 1000).lat, 2e-5);
  s = tr.snapshot(T0 + 200 * S);
  assert.equal(s.quality, 'lost');
  assert.equal(s.estimate, null);
  assert.equal(s.estimateUnavailableReason, 'fuori traccia');
  assert.equal(s.source, 'nessuna');
});

test('tracker: fix implausibile non sovrascrive lastSure e non fa avanzare il progresso', () => {
  const route = flatRoute();
  const tr = createTracker(route);
  tr.ingestFix(fixAt(1000, T0, 8), T0);
  // 500 m in 2 s = 250 m/s
  tr.ingestFix(fixAt(1500, T0 + 2 * S, 8), T0 + 2 * S);
  let s = tr.snapshot(T0 + 2 * S);
  assert.equal(s.quality, 'weak');
  assert.equal(s.source, 'approssimata');
  assert.equal(s.lastSure.timestamp, T0);
  near(s.lastSure.distAlong, 1000, 1.5);
  near(s.distAlong, 1000, 1.5);
  assert.equal(s.gps.timestamp, T0 + 2 * S);
  near(s.gps.lat, enu(0, 1500).lat, 1e-9);
  // un fix coerente torna buono e aggiorna lastSure
  tr.ingestFix(fixAt(1005, T0 + 4 * S, 8), T0 + 4 * S);
  s = tr.snapshot(T0 + 4 * S);
  assert.equal(s.quality, 'good');
  assert.equal(s.lastSure.timestamp, T0 + 4 * S);
  near(s.lastSure.distAlong, 1005, 1.5);
});

test('tracker: velocita\' plausibile con rumore GPS tra fix ravvicinati resta good', () => {
  const route = flatRoute();
  const tr = createTracker(route);
  tr.ingestFix(fixAt(1000, T0, 10), T0);
  tr.ingestFix(fixAt(1011, T0 + 1 * S, 10), T0 + 1 * S); // 11 m in 1 s con accuracy 10+10
  assert.equal(tr.snapshot(T0 + 1 * S).quality, 'good');
});

test('tracker: serialize/restore, il buco di tempo porta in lost con stima', () => {
  const route = flatRoute();
  const t1 = createTracker(route);
  t1.ingestFix(fixAt(1000, T0, 8), T0);
  const saved = JSON.parse(JSON.stringify(t1.serialize()));
  const t2 = createTracker(route, { restored: saved });
  assert.deepEqual(t2.snapshot(T0 + 5 * S), t1.snapshot(T0 + 5 * S));
  assert.equal(t2.snapshot(T0 + 5 * S).quality, 'good');
  assert.equal(t2.snapshot(T0 + 30 * S).quality, 'weak');
  const later = t2.snapshot(T0 + 600 * S);
  assert.equal(later.quality, 'lost');
  assert.equal(later.source, 'stima');
  near(later.estimate.distAlong, 1000 + 600 / 0.9, 0.5);
  assert.equal(later.estimate.ageSec, 600);
  // dopo il ripristino il tracker continua a funzionare
  t2.ingestFix(fixAt(1800, T0 + 700 * S, 8), T0 + 700 * S);
  assert.equal(t2.snapshot(T0 + 700 * S).quality, 'good');
  assert.ok(t2.snapshot(T0 + 700 * S).justRecovered);
  // stato salvato per un'altra route: ignorato
  const other = createTracker(flatRoute(3000), { restored: saved });
  assert.equal(other.snapshot(T0).quality, 'none');
  // serialize e' JSON puro
  assert.deepEqual(JSON.parse(JSON.stringify(t2.serialize())), t2.serialize());
});

test('tracker: ritmo predefinito sotto i 500 m di campione', () => {
  const route = flatRoute();
  const tr = createTracker(route);
  const tEnd = walk(tr, 500, 880, 1.0, T0); // 380 m
  const s = tr.snapshot(tEnd + 100 * S);
  assert.equal(s.quality, 'lost');
  assert.equal(s.estimate.paceSource, 'predefinito');
  assert.equal(s.estimate.pace, 1);
  near(s.estimate.distAlong, s.lastSure.distAlong + 100 / 0.9, 0.5);
});

test('tracker: ritmo osservato con 1000 m a 1 m/s (pace = 1/(0,9) = 1,111)', () => {
  const route = flatRoute();
  const tr = createTracker(route);
  const tEnd = walk(tr, 500, 1500, 1.0, T0);
  const s = tr.snapshot(tEnd + 100 * S);
  assert.equal(s.estimate.paceSource, 'osservato');
  near(s.estimate.pace, 1 / 0.9, 0.02);
  const d0 = s.lastSure.distAlong;
  near(s.estimate.minDist, d0, 0);
  near(s.estimate.distAlong, d0 + 100, 4); // cammina ancora a 1 m/s
  near(s.estimate.maxDist, d0 + 140, 6); // pace/1,4
  assert.ok(s.estimate.maxDist > s.estimate.distAlong);
  // anche l'ETA usa il ritmo osservato: 3500 m restanti a 1 m/s = 3500 s al momento dell'ultimo fix
  const live = tr.snapshot(tEnd);
  near(live.remaining.etaSec, (5000 - live.distAlong) / 1.0, 60);
});

test('tracker: ritmo limitato a [0,5; 2,0]', () => {
  const route = flatRoute();
  const slow = createTracker(route);
  const tS = walk(slow, 500, 1100, 0.4, T0, 5);
  assert.equal(slow.snapshot(tS + 60 * S).estimate.pace, 2);
  const fast = createTracker(route);
  const tF = walk(fast, 500, 2500, 3.5, T0, 2);
  assert.equal(fast.snapshot(tF + 60 * S).estimate.pace, 0.5);
});

test('tracker: le soste non diluiscono il ritmo', () => {
  const route = flatRoute();
  const tr = createTracker(route);
  let t = walk(tr, 500, 1100, 1.0, T0);
  // sosta di 10 minuti (fix buoni nello stesso punto)
  for (let k = 1; k <= 300; k++) {
    t += 2 * S;
    tr.ingestFix(fixAt(1100, t, 8), t);
  }
  t = walk(tr, 1100, 1700, 1.0, t + 2 * S);
  const e = tr.snapshot(t + 60 * S).estimate;
  assert.equal(e.paceSource, 'osservato');
  near(e.pace, 1 / 0.9, 0.03);
});

test('tracker: piu\' tracce, currentTrack e valori rimanenti', () => {
  const a = mkTrack('a', dense([[0, 0], [0, 1000]], 10).map(([e, n]) => [e, n, 100]));
  const b = mkTrack('b', dense([[500, 2000], [500, 3000]], 10).map(([e, n]) => [e, n, 100 + (n - 2000) / 10]), { name: 'Seconda' });
  const route = buildRoute([a, b]);
  near(route.totalDist, 2000, 3);
  const tr = createTracker(route);

  tr.ingestFix(fixAt(400, T0, 8), T0);
  let s = tr.snapshot(T0);
  assert.equal(s.currentTrack.trackId, 'a');
  assert.equal(s.currentTrack.index, 0);
  assert.equal(s.currentTrack.name, 'a');
  near(s.currentTrack.remaining.dist, 600, 2);
  near(s.currentTrack.remaining.up, 0, 0.5);
  near(s.remaining.dist, 1600, 3);
  near(s.remaining.up, route.totalUp, 1e-6); // tutto il dislivello e' ancora davanti
  near(route.totalUp, 100, 6);
  near(s.done.dist, 400, 2);
  near(s.done.up, 0, 0.5);
  // ETA del tratto: 600 m piani a 4 km/h = 540 s
  near(s.currentTrack.remaining.etaSec, 540, 3);

  // 10 minuti dopo nella seconda traccia, a 300 m dall'inizio
  const t2 = T0 + 600 * S;
  tr.ingestFix({ ...enu(500, 2300), accuracy: 8, timestamp: t2 }, t2);
  s = tr.snapshot(t2);
  assert.equal(s.currentTrack.trackId, 'b');
  assert.equal(s.currentTrack.index, 1);
  assert.equal(s.currentTrack.name, 'Seconda');
  near(s.currentTrack.remaining.dist, 700, 2);
  near(s.currentTrack.remaining.up, 70, 5); // 1 m ogni 10 m
  assert.equal(s.currentTrack.remaining.down, 0);
  near(s.done.dist, 1300, 3);
  // il rimanente totale coincide con quello del tratto nell'ultima traccia
  near(s.remaining.dist, s.currentTrack.remaining.dist, 1e-6);
  near(s.remaining.up, s.currentTrack.remaining.up, 1e-6);
  // ETA indipendente: dist/4000 + max(up/400, down/800), in secondi, ritmo 1
  near(s.remaining.etaSec, (s.remaining.dist / 4000 + s.remaining.up / 400) * 3600, 1);
  assert.equal(s.source, 'gps');
  assert.equal(s.offTrack, false);
});

test('tracker: fix fuori traccia mantiene il progresso e indica il rientro', () => {
  const route = flatRoute();
  const tr = createTracker(route);
  tr.ingestFix(fixAt(1000, T0, 8), T0);
  tr.ingestFix(fixAt(1100, T0 + 60 * S, 8, -120), T0 + 60 * S); // 120 m a ovest
  const s = tr.snapshot(T0 + 60 * S);
  assert.equal(s.offTrack, true);
  near(s.offTrackM, 120, 1);
  near(s.distAlong, 1000, 1.5, 'progresso fermo al migliore noto');
  near(s.bearingToTrackDeg, 90, 2);
  assert.equal(s.lastSure.onTrack, false);
});
