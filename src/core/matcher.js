// Aggancio di un fix GPS alla route. Puro, nessun DOM.
//
// Idea: ogni passaggio vicino della traccia e' un candidato (minimo locale della distanza
// laterale). La scelta pesa la distanza laterale con la coerenza rispetto al progresso
// precedente, cosi' andata/ritorno sovrapposti e anelli non vengono scambiati. Un candidato
// "non plausibile" (troppo lontano lungo la traccia per il tempo trascorso) puo' diventare
// la posizione solo dopo 3 fix consecutivi coerenti.

import { M_PER_DEG } from './geo.js';

/**
 * @typedef {import('./route.js').Route} Route
 * @typedef {{lat:number, lon:number, accuracy?:number, timestamp?:number}} Fix
 * @typedef {{distAlong:number, count:number}} PendingJump
 * @typedef {{distAlong:number, timestamp?:number, pendingJump?:PendingJump|null}} Prev
 * @typedef {{distAlong:number, lat:number, lon:number, offTrackM:number, offTrack:boolean,
 *   segIdx:number, ambiguous:boolean, pendingJump:PendingJump|null}} MatchResult
 */

export const WALK_SPEED_MS = 3;
export const JUMP_CONFIRMATIONS = 3;
const JUMP_CONSISTENCY_M = 100;
const RAD = Math.PI / 180;

/** @type {WeakMap<object, any>} */
const cache = new WeakMap();

/** @param {Route} route */
function getCache(route) {
  let c = cache.get(route);
  const n = route.points.length;
  if (c && c.n === n) return c;
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  const cum = new Float64Array(n);
  const ok = new Uint8Array(Math.max(0, n - 1));
  for (let i = 0; i < n; i++) {
    lat[i] = route.points[i].lat;
    lon[i] = route.points[i].lon;
    cum[i] = route.cumDist[i];
    // i segmenti tra due tracce diverse sono salti, non tratti camminabili
    if (i < n - 1) ok[i] = route.points[i].trackId === route.points[i + 1].trackId ? 1 : 0;
  }
  c = { n, lat, lon, cum, ok, d: new Float64Array(Math.max(1, n - 1)), t: new Float64Array(Math.max(1, n - 1)) };
  cache.set(route, c);
  return c;
}

/**
 * Indice del segmento che contiene la distanza `dist`.
 * @param {any} c
 * @param {number} dist
 */
function segAt(c, dist) {
  let lo = 0;
  let hi = c.n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c.cum[mid] <= dist) lo = mid; else hi = mid - 1;
  }
  return Math.max(0, Math.min(c.n - 2, lo));
}

/**
 * @param {any} c
 * @param {number} dist
 */
function pointAtDist(c, dist) {
  const i = segAt(c, dist);
  const span = c.cum[i + 1] - c.cum[i];
  const t = span > 0 ? Math.min(1, Math.max(0, (dist - c.cum[i]) / span)) : 0;
  return { i, lat: c.lat[i] + t * (c.lat[i + 1] - c.lat[i]), lon: c.lon[i] + t * (c.lon[i + 1] - c.lon[i]) };
}

/**
 * Aggancia un fix alla route.
 * @param {Route} route
 * @param {Fix} fix
 * @param {Prev|null} [prev]
 * @returns {MatchResult}
 */
export function matchPosition(route, fix, prev = null) {
  const n = route.points.length;
  if (n === 0) {
    return { distAlong: 0, lat: fix.lat, lon: fix.lon, offTrackM: Infinity, offTrack: true, segIdx: 0, ambiguous: false, pendingJump: null };
  }
  if (n === 1) {
    const p = route.points[0];
    const dd = Math.hypot((fix.lat - p.lat) * M_PER_DEG, (fix.lon - p.lon) * M_PER_DEG * Math.cos(p.lat * RAD));
    return { distAlong: 0, lat: p.lat, lon: p.lon, offTrackM: dd, offTrack: dd > 50, segIdx: 0, ambiguous: false, pendingJump: null };
  }
  const c = getCache(route);
  const acc = Number.isFinite(fix.accuracy) ? Math.max(0, /** @type {number} */ (fix.accuracy)) : 10;
  const radius = Math.max(75, 3 * acc);
  const offThr = Math.max(50, 1.5 * acc);
  const m = n - 1;

  // 1. distanza laterale da ogni segmento (piano locale centrato sul fix)
  const ky = M_PER_DEG;
  const kx = M_PER_DEG * Math.cos(fix.lat * RAD);
  const d = c.d;
  const tt = c.t;
  let ax = (c.lon[0] - fix.lon) * kx;
  let ay = (c.lat[0] - fix.lat) * ky;
  let gMin = Infinity;
  let gIdx = 0;
  for (let i = 0; i < m; i++) {
    const bx = (c.lon[i + 1] - fix.lon) * kx;
    const by = (c.lat[i + 1] - fix.lat) * ky;
    if (c.ok[i]) {
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      let t = 0;
      if (l2 > 0) {
        t = -(ax * dx + ay * dy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
      }
      const px = ax + t * dx;
      const py = ay + t * dy;
      const dist = Math.sqrt(px * px + py * py);
      d[i] = dist;
      tt[i] = t;
      if (dist < gMin) { gMin = dist; gIdx = i; }
    } else {
      d[i] = Infinity;
      tt[i] = 0;
    }
    ax = bx;
    ay = by;
  }

  // 2. candidati: un minimo locale per passaggio entro il raggio
  /** @type {Array<{i:number, t:number, lat:number, lon:number, dist:number, lateral:number, x:number, y:number, cost:number, plausible:boolean}>} */
  const cands = [];
  const mk = (/** @type {number} */ i) => {
    const t = tt[i];
    const span = c.cum[i + 1] - c.cum[i];
    const lat = c.lat[i] + t * (c.lat[i + 1] - c.lat[i]);
    const lon = c.lon[i] + t * (c.lon[i + 1] - c.lon[i]);
    return {
      i, t, lat, lon, dist: c.cum[i] + t * span, lateral: d[i],
      x: (lon - fix.lon) * kx, y: (lat - fix.lat) * ky, cost: 0, plausible: true,
    };
  };
  for (let i = 0; i < m; i++) {
    const di = d[i];
    if (di > radius) continue;
    const before = i > 0 ? d[i - 1] : Infinity;
    const after = i < m - 1 ? d[i + 1] : Infinity;
    if (di <= before && di < after) cands.push(mk(i));
  }
  const nearest = mk(gIdx);

  // 3. prima posizione
  if (!prev || !Number.isFinite(prev.distAlong)) {
    const pool = cands.length ? cands : [nearest];
    let best = pool[0];
    for (const k of pool) if (k.lateral < best.lateral) best = k;
    const tie = pool.filter((k) =>
      Math.hypot(k.x - best.x, k.y - best.y) <= 30 && k.lateral <= best.lateral + Math.max(15, acc));
    let pick = best;
    for (const k of tie) if (k.dist < pick.dist) pick = k;
    const ambiguous = tie.some((k) => Math.abs(k.dist - pick.dist) > 50);
    return {
      distAlong: pick.dist, lat: pick.lat, lon: pick.lon, offTrackM: pick.lateral,
      offTrack: pick.lateral > offThr, segIdx: pick.i, ambiguous, pendingJump: null,
    };
  }

  // 4. costo con coerenza di progresso
  const p = Math.min(route.totalDist, Math.max(0, prev.distAlong));
  const dtRaw = Number.isFinite(prev.timestamp) && Number.isFinite(fix.timestamp)
    ? ((/** @type {number} */ (fix.timestamp) - /** @type {number} */ (prev.timestamp)) / 1000) : 1;
  const dt = Math.max(0, dtRaw);
  const reach = WALK_SPEED_MS * dt + Math.max(30, acc);
  /** @type {typeof cands} */ const plaus = [];
  /** @type {typeof cands} */ const implaus = [];
  for (const k of cands) {
    const delta = k.dist - p;
    let pen;
    if (delta >= 0) {
      const ex = Math.max(0, delta - reach);
      k.plausible = ex === 0;
      pen = 0.002 * delta + 0.05 * Math.max(0, delta - (2 * dt + acc / 2)) + 0.1 * ex;
    } else {
      const ex = Math.max(0, -delta - reach);
      k.plausible = ex === 0;
      pen = 0.1 * -delta + 0.25 * ex;
    }
    k.cost = k.lateral + pen;
    (k.plausible ? plaus : implaus).push(k);
  }
  const argmin = (/** @type {typeof cands} */ arr, /** @type {'cost'|'lateral'} */ key) => {
    let b = null;
    for (const k of arr) if (!b || k[key] < b[key]) b = k;
    return b;
  };

  let chosen = argmin(plaus, 'cost');
  /** @type {typeof chosen} */ let jump = null;
  if (!chosen || chosen.lateral > offThr) {
    jump = argmin(implaus.filter((k) => k.lateral <= offThr), 'lateral');
  }

  /** @type {PendingJump|null} */
  let pendingOut = null;
  let commit = false;
  if (jump) {
    const pj = prev.pendingJump;
    const count = pj && Math.abs(jump.dist - pj.distAlong) <= JUMP_CONSISTENCY_M ? pj.count + 1 : 1;
    if (count >= JUMP_CONFIRMATIONS) commit = true;
    else pendingOut = { distAlong: jump.dist, count };
  }

  // 5. risultato
  const ambiguousFor = (/** @type {NonNullable<typeof chosen>} */ sel) =>
    cands.some((k) => k !== sel && Math.abs(k.dist - sel.dist) > 100 && k.lateral <= sel.lateral + Math.max(15, acc));

  if (commit && jump) {
    return {
      distAlong: jump.dist, lat: jump.lat, lon: jump.lon, offTrackM: jump.lateral,
      offTrack: false, segIdx: jump.i, ambiguous: ambiguousFor(jump), pendingJump: null,
    };
  }
  const held = pointAtDist(c, p);
  if (chosen && chosen.lateral <= offThr) {
    const delta = chosen.dist - p;
    const tol = Math.max(40, 3 * acc);
    if (delta < 0 && -delta <= tol) {
      // piccolo arretramento: rumore GPS lungo la traccia, il progresso non scende
      return {
        distAlong: p, lat: held.lat, lon: held.lon, offTrackM: chosen.lateral, offTrack: false,
        segIdx: held.i, ambiguous: ambiguousFor(chosen), pendingJump: null,
      };
    }
    return {
      distAlong: chosen.dist, lat: chosen.lat, lon: chosen.lon, offTrackM: chosen.lateral,
      offTrack: false, segIdx: chosen.i, ambiguous: ambiguousFor(chosen), pendingJump: null,
    };
  }
  if (jump && pendingOut) {
    // in attesa di conferma del salto: progresso fermo
    if (chosen) {
      return { distAlong: p, lat: chosen.lat, lon: chosen.lon, offTrackM: chosen.lateral, offTrack: true, segIdx: held.i, ambiguous: false, pendingJump: pendingOut };
    }
    return { distAlong: p, lat: jump.lat, lon: jump.lon, offTrackM: jump.lateral, offTrack: false, segIdx: held.i, ambiguous: false, pendingJump: pendingOut };
  }
  // fuori traccia: progresso invariato, punto piu' vicino per la guida di rientro
  const near = chosen || nearest;
  return {
    distAlong: p, lat: near.lat, lon: near.lon, offTrackM: near.lateral,
    offTrack: near.lateral > offThr, segIdx: held.i, ambiguous: false, pendingJump: null,
  };
}
