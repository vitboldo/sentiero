// Utilita' condivise dai test (il nome .test.js la fa trattare come file di test dal runner).
import test from 'node:test';
import assert from 'node:assert/strict';

export const LAT0 = 46;
export const LON0 = 10;
const M_LAT = 111195; // m per grado di latitudine (costante indipendente dal codice testato)
const M_LON = M_LAT * Math.cos((LAT0 * Math.PI) / 180);

/** Metri est/nord -> lat/lon. */
export function enu(e, n, ele = null) {
  return { lat: LAT0 + n / M_LAT, lon: LON0 + e / M_LON, ele };
}

/** Distanza piana in metri tra due punti lat/lon vicini. */
export function planar(a, b) {
  return Math.hypot((a.lat - b.lat) * M_LAT, (a.lon - b.lon) * M_LON);
}

/** Generatore pseudo-casuale riproducibile. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gaussiana (Box-Muller). */
export function gauss(r) {
  const u = Math.max(1e-12, r());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** Spezzata in metri [[e,n],...] infittita ogni `step` m. */
export function dense(vertices, step = 10) {
  const out = [];
  for (let i = 0; i < vertices.length - 1; i++) {
    const [x0, y0] = vertices[i];
    const [x1, y1] = vertices[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const k = Math.max(1, Math.round(len / step));
    for (let j = 0; j < k; j++) out.push([x0 + ((x1 - x0) * j) / k, y0 + ((y1 - y0) * j) / k]);
  }
  out.push(vertices[vertices.length - 1]);
  return out;
}

/** Track del modello dati da punti [e,n,ele?]. */
export function mkTrack(id, pts, extra = {}) {
  return {
    id, name: id, color: '#f00', visible: true, reversed: false,
    points: pts.map(([e, n, ele]) => enu(e, n, ele ?? null)),
    waypoints: [], original: null, ...extra,
  };
}

export function mkFix(p, ts, accuracy = 8) {
  return { lat: p.lat, lon: p.lon, accuracy, timestamp: ts };
}

test('helper: enu/planar sono coerenti', () => {
  const d = planar(enu(0, 0), enu(300, 400));
  assert.ok(Math.abs(d - 500) < 1e-6);
});
