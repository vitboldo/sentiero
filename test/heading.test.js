import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDeg,
  angleDiffDeg,
  screenHeading,
  bearingForHeading,
  screenBearing,
  rotateOffset,
  createHeadingFilter,
} from '../src/core/heading.js';

/** Confronto tra angoli circolari. */
function near(a, b, tol = 1e-6) {
  assert.ok(Math.abs(angleDiffDeg(a, b)) <= tol, `angoli diversi: ${a} vs ${b}`);
}

test('normalizeDeg: porta in [0,360)', () => {
  assert.equal(normalizeDeg(0), 0);
  assert.equal(normalizeDeg(360), 0);
  assert.equal(normalizeDeg(-90), 270);
  assert.equal(normalizeDeg(725), 5);
  assert.equal(normalizeDeg(-360), 0);
  const r = normalizeDeg(-1e-15);
  assert.ok(r >= 0 && r < 360, `fuori intervallo: ${r}`);
});

test('angleDiffDeg: differenza più breve con segno in (-180,180]', () => {
  assert.equal(angleDiffDeg(359, 1), 2);
  assert.equal(angleDiffDeg(1, 359), -2);
  assert.equal(angleDiffDeg(350, 10), 20);
  assert.equal(angleDiffDeg(10, 350), -20);
  assert.equal(angleDiffDeg(90, 90), 0);
  // uguaglianze a ±180: sempre +180
  assert.equal(angleDiffDeg(0, 180), 180);
  assert.equal(angleDiffDeg(180, 0), 180);
  assert.equal(angleDiffDeg(0, -180), 180);
  assert.equal(angleDiffDeg(90, 270), 180);
  assert.equal(angleDiffDeg(270, 90), 180);
});

test('screenHeading: compass + rotazione schermo, normalizzata', () => {
  assert.equal(screenHeading(350, 20), 10);
  assert.equal(screenHeading(10, 0), 10);
  assert.equal(screenHeading(10, -90), 280);
});

test('bearingForHeading: 360 - h, con h=0 e h=360 uguali a 0', () => {
  assert.equal(bearingForHeading(0), 0);
  assert.equal(bearingForHeading(360), 0);
  assert.equal(bearingForHeading(90), 270);
  assert.equal(bearingForHeading(270), 90);
  assert.equal(bearingForHeading(1), 359);
});

test('screenBearing: direzione geografica + rotazione mappa', () => {
  assert.equal(screenBearing(10, 350), 0);
  assert.equal(screenBearing(0, 0), 0);
  assert.equal(screenBearing(90, 45), 135);
  assert.equal(screenBearing(270, 180), 90);
});

test('rotateOffset: rotazione oraria sullo schermo (y verso il basso)', () => {
  const eps = 1e-9;
  const a = rotateOffset(1, 0, 90); // destra -> giù
  assert.ok(Math.abs(a.x) < eps && Math.abs(a.y - 1) < eps);
  const b = rotateOffset(0, 1, 90); // giù -> sinistra
  assert.ok(Math.abs(b.x + 1) < eps && Math.abs(b.y) < eps);
  const c = rotateOffset(3, 4, 0);
  assert.deepEqual(c, { x: 3, y: 4 });
  const d = rotateOffset(0, -2, 180);
  assert.ok(Math.abs(d.x) < eps && Math.abs(d.y - 2) < eps);
  const e = rotateOffset(1, 0, 45);
  assert.ok(Math.abs(e.x - Math.SQRT1_2) < eps && Math.abs(e.y - Math.SQRT1_2) < eps);
});

test('filtro: primo campione restituisce la direzione, affidabile', () => {
  const f = createHeadingFilter();
  f.push({ heading: 123, accuracy: 5, timestamp: 1000 });
  const r = f.read(1000);
  assert.equal(r.reliable, true);
  near(r.deg, 123, 1e-9);
});

test('filtro: nessun campione -> deg null, non affidabile', () => {
  const f = createHeadingFilter();
  assert.deepEqual(f.read(0), { deg: null, reliable: false });
});

test('filtro: giro 359 -> 1 passa per 0, non per 180', () => {
  const f = createHeadingFilter({ tauMs: 300 });
  f.push({ heading: 359, accuracy: 5, timestamp: 0 });
  let t = 0;
  for (let i = 0; i < 20; i++) {
    t += 100;
    f.push({ heading: 1, accuracy: 5, timestamp: t });
    const r = f.read(t);
    // ad ogni passo il valore sta fra 359 e 1 (attraverso 0), mai attorno a 180
    assert.ok(r.deg !== null);
    assert.ok(Math.abs(angleDiffDeg(0, r.deg)) <= 2, `passo ${i}: ${r.deg}`);
  }
  near(f.read(t).deg, 1, 0.01);
});

test('filtro: oscillazione attorno a 0 resta vicino a 0', () => {
  const f = createHeadingFilter({ tauMs: 300 });
  let t = 0;
  for (let i = 0; i < 40; i++) {
    t += 100;
    f.push({ heading: i % 2 ? 5 : 355, accuracy: 5, timestamp: t });
    const d = angleDiffDeg(0, f.read(t).deg);
    // la media resta dentro l'arco dei campioni (±5°), e dopo il riscaldamento si stringe
    assert.ok(Math.abs(d) <= 5 + 1e-9, `passo ${i}: ${d}`);
    if (i >= 4) assert.ok(Math.abs(d) < 2, `passo ${i}: ${d}`);
  }
});

test('filtro: convergenza verso la direzione costante', () => {
  const f = createHeadingFilter({ tauMs: 300 });
  f.push({ heading: 0, accuracy: 5, timestamp: 0 });
  for (let t = 100; t <= 5000; t += 100) f.push({ heading: 90, accuracy: 5, timestamp: t });
  near(f.read(5000).deg, 90, 0.01);
});

test('filtro: formula dt-dipendente (dopo dt=tau il peso del nuovo è 1-exp(-1))', () => {
  const f = createHeadingFilter({ tauMs: 300 });
  f.push({ heading: 0, accuracy: 5, timestamp: 0 });
  f.push({ heading: 90, accuracy: 5, timestamp: 300 });
  const a = 1 - Math.exp(-1);
  const expected = (Math.atan2(a, 1 - a) * 180) / Math.PI;
  near(f.read(300).deg, expected, 1e-9);
});

test('filtro: campione inaffidabile (accuracy > maxAccuracy) non entra nella media', () => {
  const f = createHeadingFilter({ maxAccuracy: 30 });
  f.push({ heading: 90, accuracy: 5, timestamp: 0 });
  f.push({ heading: 270, accuracy: 50, timestamp: 100 });
  near(f.read(100).deg, 90, 1e-9);
  assert.equal(f.read(100).reliable, true);
});

test('filtro: accuracy < 0, NaN o non finita sono inaffidabili', () => {
  const f = createHeadingFilter();
  f.push({ heading: 90, accuracy: 5, timestamp: 0 });
  f.push({ heading: 270, accuracy: -1, timestamp: 100 });
  f.push({ heading: 270, accuracy: NaN, timestamp: 200 });
  f.push({ heading: 270, accuracy: Infinity, timestamp: 300 });
  near(f.read(300).deg, 90, 1e-9);
});

test('filtro: accuracy al limite maxAccuracy e pari a 0 sono affidabili', () => {
  const f = createHeadingFilter({ maxAccuracy: 30 });
  f.push({ heading: 10, accuracy: 0, timestamp: 0 });
  f.push({ heading: 90, accuracy: 30, timestamp: 1000 });
  assert.equal(f.read(1000).reliable, true);
  assert.notEqual(f.read(1000).deg, 10);
});

test('filtro: accuracy assente = affidabile', () => {
  const f = createHeadingFilter();
  f.push({ heading: 42, timestamp: 0 });
  assert.deepEqual(f.read(0), { deg: 42, reliable: true });
});

test('filtro: maxAccuracy personalizzato', () => {
  const f = createHeadingFilter({ maxAccuracy: 10 });
  f.push({ heading: 42, accuracy: 15, timestamp: 0 });
  assert.deepEqual(f.read(0), { deg: null, reliable: false });
});

test('filtro: stale dopo staleMs, deg resta l\'ultimo valore noto', () => {
  const f = createHeadingFilter({ staleMs: 3000 });
  f.push({ heading: 77, accuracy: 5, timestamp: 0 });
  assert.equal(f.read(3000).reliable, true); // esattamente staleMs: non più vecchio
  const late = f.read(3001);
  assert.equal(late.reliable, false);
  near(late.deg, 77, 1e-9);
});

test('filtro: campioni inaffidabili non rinfrescano lo stale', () => {
  const f = createHeadingFilter({ staleMs: 3000 });
  f.push({ heading: 77, accuracy: 5, timestamp: 0 });
  f.push({ heading: 80, accuracy: 500, timestamp: 5000 });
  const r = f.read(4000);
  assert.equal(r.reliable, false);
  near(r.deg, 77, 1e-9);
});

test('filtro: tornato affidabile dopo un nuovo campione valido', () => {
  const f = createHeadingFilter({ staleMs: 3000 });
  f.push({ heading: 77, accuracy: 5, timestamp: 0 });
  assert.equal(f.read(10000).reliable, false);
  f.push({ heading: 80, accuracy: 5, timestamp: 10000 });
  assert.equal(f.read(10000).reliable, true);
});

test('filtro: solo campioni inaffidabili -> deg null', () => {
  const f = createHeadingFilter();
  f.push({ heading: 10, accuracy: 999, timestamp: 0 });
  assert.deepEqual(f.read(0), { deg: null, reliable: false });
});

test('filtro: heading non finito ignorato', () => {
  const f = createHeadingFilter();
  f.push({ heading: NaN, accuracy: 5, timestamp: 0 });
  f.push({ heading: Infinity, accuracy: 5, timestamp: 0 });
  assert.deepEqual(f.read(0), { deg: null, reliable: false });
  f.push({ heading: 30, accuracy: 5, timestamp: 100 });
  near(f.read(100).deg, 30, 1e-9);
});

test('filtro: timestamp non finito ignorato', () => {
  const f = createHeadingFilter();
  f.push({ heading: 30, accuracy: 5, timestamp: undefined });
  assert.deepEqual(f.read(0), { deg: null, reliable: false });
});

test('filtro: dt=0 non produce NaN e non sposta la media', () => {
  const f = createHeadingFilter();
  f.push({ heading: 10, accuracy: 5, timestamp: 1000 });
  f.push({ heading: 90, accuracy: 5, timestamp: 1000 });
  const r = f.read(1000);
  assert.ok(Number.isFinite(r.deg));
  near(r.deg, 10, 1e-9);
});

test('filtro: dt negativo non produce NaN e non sposta la media', () => {
  const f = createHeadingFilter();
  f.push({ heading: 10, accuracy: 5, timestamp: 1000 });
  f.push({ heading: 90, accuracy: 5, timestamp: 500 });
  const r = f.read(1000);
  assert.ok(Number.isFinite(r.deg));
  near(r.deg, 10, 1e-9);
  // lo stale resta misurato dal campione più recente (t=1000)
  assert.equal(f.read(3999).reliable, true);
  assert.equal(f.read(4001).reliable, false);
});

test('filtro: deg sempre in [0,360)', () => {
  const f = createHeadingFilter();
  f.push({ heading: 359.9, accuracy: 5, timestamp: 0 });
  f.push({ heading: 0.1, accuracy: 5, timestamp: 1000 });
  const { deg } = f.read(1000);
  assert.ok(deg >= 0 && deg < 360, `fuori intervallo: ${deg}`);
});
