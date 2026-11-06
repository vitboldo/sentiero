import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tilesForCorridor, estimateBytes, tileUrl, PRECISION_PRESETS, MAX_TILES, TILE_URL,
} from '../src/core/tiles.js';
import { enu, planar } from './util.test.js';

/** Formula slippy-map riscritta nel test. */
function tileOf(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return { x, y };
}
const key = (t) => `${t.z}/${t.x}/${t.y}`;

test('tiles: costanti del contratto', () => {
  assert.deepEqual(PRECISION_PRESETS.map((p) => [p.id, p.maxZoom]), [['bassa', 13], ['media', 14], ['alta', 15], ['massima', 16]]);
  assert.equal(MAX_TILES, 10000);
  assert.equal(TILE_URL, 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png');
  assert.equal(tileUrl({ z: 12, x: 2144, y: 1443 }), 'https://a.tile.opentopomap.org/12/2144/1443.png');
  assert.equal(estimateBytes(new Array(100)), 100 * 40 * 1024);
  assert.equal(estimateBytes([]), 0);
});

test('tiles: numerazione corretta (riferimenti noti)', () => {
  // (0,0) a zoom 1 e' la tile 1/1; Greenwich a zoom 10 e' x=512
  const t = tilesForCorridor([{ lat: 0.0001, lon: 0.0001 }], { minZoom: 1, maxZoom: 1, bufferM: 1 });
  assert.ok(t.some((k) => k.z === 1 && k.x === 1 && k.y === 0), JSON.stringify(t));
  const p = { lat: 46.1, lon: 10.3 };
  const tiles = tilesForCorridor([p], { minZoom: 10, maxZoom: 14, bufferM: 100 });
  for (let z = 10; z <= 14; z++) {
    const exp = tileOf(p.lat, p.lon, z);
    assert.ok(tiles.some((k) => k.z === z && k.x === exp.x && k.y === exp.y), `la tile contenente il punto manca a z${z}`);
  }
});

test('tiles: corridoio su diagonale molto inferiore al bounding box, nessun duplicato', () => {
  const a = { lat: 46.0, lon: 10.0 };
  const b = { lat: 46.4, lon: 10.6 };
  const pts = Array.from({ length: 41 }, (_, i) => ({ lat: a.lat + ((b.lat - a.lat) * i) / 40, lon: a.lon + ((b.lon - a.lon) * i) / 40 }));
  const opts = { minZoom: 10, maxZoom: 14, bufferM: 1000 };
  const tiles = tilesForCorridor(pts, opts);
  assert.equal(new Set(tiles.map(key)).size, tiles.length, 'duplicati');
  let bbox = 0;
  for (let z = opts.minZoom; z <= opts.maxZoom; z++) {
    const ta = tileOf(a.lat, a.lon, z);
    const tb = tileOf(b.lat, b.lon, z);
    bbox += (Math.abs(tb.x - ta.x) + 1) * (Math.abs(tb.y - ta.y) + 1);
  }
  assert.ok(tiles.length > 50, `troppo poche: ${tiles.length}`);
  assert.ok(tiles.length < bbox * 0.25, `corridoio ${tiles.length} vs bbox ${bbox}`);
  // l'intervallo di zoom e' rispettato
  assert.ok(tiles.every((t) => t.z >= 10 && t.z <= 14));
  for (let z = 10; z <= 14; z++) assert.ok(tiles.some((t) => t.z === z));
  // ogni tile e' dentro il range valido
  assert.ok(tiles.every((t) => t.x >= 0 && t.y >= 0 && t.x < 2 ** t.z && t.y < 2 ** t.z));
});

test('tiles: copre ogni punto entro bufferM e non include tile molto piu\' lontane', () => {
  const pts = [enu(0, 0), enu(3000, 1500), enu(6000, 1500)];
  const bufferM = 1000;
  const z = 14;
  const tiles = tilesForCorridor(pts, { minZoom: z, maxZoom: z, bufferM });
  const set = new Set(tiles.map(key));
  // campiona punti reali a distanza <= bufferM dalla traccia: la loro tile deve esserci
  const probes = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    const x = t < 0.5 ? 6000 * t : 3000 + (t - 0.5) * 6000;
    const y = t < 0.5 ? 3000 * t : 1500;
    for (const [dx, dy] of [[0, 900], [0, -900], [650, 650], [-650, -650]]) probes.push(enu(x + dx, y + dy));
  }
  for (const p of probes) {
    const k = tileOf(p.lat, p.lon, z);
    assert.ok(set.has(`${z}/${k.x}/${k.y}`), `tile mancante per un punto entro ${bufferM} m`);
  }
  // una tile distante piu' di 3 km dal tracciato non c'e' (a z14 una tile e' ~1,2 km)
  const faraway = tileOf(enu(3000, 6000).lat, enu(3000, 6000).lon, z);
  assert.ok(!set.has(`${z}/${faraway.x}/${faraway.y}`));
  assert.ok(planar(enu(3000, 6000), enu(3000, 1500)) > 3000);
});

test('tiles: il buffer aumenta il numero di tile', () => {
  const pts = [enu(0, 0), enu(0, 5000)];
  const n = (b) => tilesForCorridor(pts, { minZoom: 15, maxZoom: 16, bufferM: b }).length;
  assert.ok(n(500) < n(1000));
  assert.ok(n(1000) < n(2000));
  assert.deepEqual(tilesForCorridor([], { minZoom: 10, maxZoom: 12, bufferM: 1000 }), []);
});

test('tiles: traccia lunga, conteggio ragionevole e tutto sotto MAX_TILES per un\'uscita normale', () => {
  // 25 km a nord-est, preset media (z14), 1 km
  const pts = Array.from({ length: 251 }, (_, i) => enu((i * 100) / Math.SQRT2, (i * 100) / Math.SQRT2));
  const tiles = tilesForCorridor(pts, { minZoom: 10, maxZoom: 14, bufferM: 1000 });
  assert.ok(tiles.length < MAX_TILES, String(tiles.length));
  assert.equal(new Set(tiles.map(key)).size, tiles.length);
});
