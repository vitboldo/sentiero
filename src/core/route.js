// Costruzione del percorso seguito, dislivelli e tempi. Puro, nessun DOM.
import { haversineM, interpolate } from './geo.js';

/**
 * @typedef {{lat:number, lon:number, ele:number|null}} Pt
 * @typedef {{id:string, name:string, color:string, visible:boolean, reversed:boolean,
 *   points:Pt[], waypoints:Array<Pt&{name:string}>, original:any}} Track
 * @typedef {{trackId:string, name:string, startIdx:number, endIdx:number,
 *   startDist:number, endDist:number, gapBeforeM:number}} TrackRange
 * @typedef {{points:Array<Pt&{trackId:string}>, cumDist:number[], cumUp:number[], cumDown:number[],
 *   trackRanges:TrackRange[], totalDist:number, totalUp:number, totalDown:number,
 *   hasElevation:boolean}} Route
 */

/** Soglia di isteresi (m) per D+/D-. */
export const HYSTERESIS_M = 5;
/** Finestra della media mobile (m). */
export const SMOOTH_WINDOW_M = 50;

/**
 * Punti nella direzione di marcia.
 * @param {Track} track
 * @returns {Pt[]}
 */
export function effectivePoints(track) {
  return track.reversed ? track.points.slice().reverse() : track.points;
}

/**
 * Dislivelli cumulativi per punto di UNA traccia. Quote mancanti interpolate, media mobile
 * su 50 m, poi filtro a zig-zag con soglia 5 m (simmetrico rispetto all'inversione).
 * @param {Array<number|null>} eles
 * @param {number[]} dist distanza cumulata nella traccia
 * @returns {{up:Float64Array, down:Float64Array}}
 */
function elevationCumulative(eles, dist) {
  const n = eles.length;
  const up = new Float64Array(n);
  const down = new Float64Array(n);
  const known = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(eles[i])) known.push(i);
  if (known.length === 0 || n < 2) return { up, down };

  // 1. riempimento delle quote mancanti (interpolazione sulla distanza)
  const v = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(eles[i])) {
      v[i] = /** @type {number} */ (eles[i]);
      continue;
    }
    while (k < known.length && known[k] < i) k++;
    const next = k < known.length ? known[k] : -1;
    const prev = k > 0 ? known[k - 1] : -1;
    if (prev < 0) v[i] = /** @type {number} */ (eles[next]);
    else if (next < 0) v[i] = /** @type {number} */ (eles[prev]);
    else {
      const span = dist[next] - dist[prev];
      const t = span > 0 ? (dist[i] - dist[prev]) / span : 0;
      v[i] = /** @type {number} */ (eles[prev]) + t * (/** @type {number} */ (eles[next]) - /** @type {number} */ (eles[prev]));
    }
  }

  // 2. media mobile su finestra SMOOTH_WINDOW_M centrata
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + v[i];
  const s = new Float64Array(n);
  let lo = 0;
  let hi = 0;
  const half = SMOOTH_WINDOW_M / 2;
  for (let i = 0; i < n; i++) {
    while (dist[lo] < dist[i] - half) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < n && dist[hi + 1] <= dist[i] + half) hi++;
    s[i] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
  }

  // 3. filtro a zig-zag: estremi confermati da un'escursione >= soglia
  const pivots = [];
  let dir = 0;
  let hiI = 0;
  let loI = 0;
  for (let i = 1; i < n; i++) {
    if (dir === 0) {
      if (s[i] > s[hiI]) hiI = i;
      if (s[i] < s[loI]) loI = i;
      if (s[i] - s[loI] >= HYSTERESIS_M && loI < i) {
        pivots.push(loI);
        dir = 1;
        hiI = i;
      } else if (s[hiI] - s[i] >= HYSTERESIS_M && hiI < i) {
        pivots.push(hiI);
        dir = -1;
        loI = i;
      }
    } else if (dir === 1) {
      if (s[i] > s[hiI]) hiI = i;
      else if (s[hiI] - s[i] >= HYSTERESIS_M) {
        pivots.push(hiI);
        dir = -1;
        loI = i;
      }
    } else {
      if (s[i] < s[loI]) loI = i;
      else if (s[i] - s[loI] >= HYSTERESIS_M) {
        pivots.push(loI);
        dir = 1;
        hiI = i;
      }
    }
  }
  if (dir === 1) pivots.push(hiI);
  else if (dir === -1) pivots.push(loI);
  if (pivots.length < 2) return { up, down };

  // 4. cumulati per punto: dentro una tratta monotona si usa il massimo parziale
  let U = 0;
  let D = 0;
  for (let j = 0; j + 1 < pivots.length; j++) {
    const a = pivots[j];
    const b = pivots[j + 1];
    const rising = s[b] > s[a];
    let run = 0;
    for (let i = a + 1; i <= b; i++) {
      run = Math.max(run, rising ? s[i] - s[a] : s[a] - s[i]);
      if (rising) { up[i] = U + run; down[i] = D; } else { up[i] = U; down[i] = D + run; }
    }
    if (rising) U += run; else D += run;
  }
  const last = pivots[pivots.length - 1];
  for (let i = last + 1; i < n; i++) { up[i] = U; down[i] = D; }
  return { up, down };
}

/**
 * Costruisce la Route dalle tracce visibili, nell'ordine dato. I salti tra tracce non
 * contano nella distanza (gapBeforeM li riporta).
 * @param {Track[]} tracks
 * @returns {Route}
 */
export function buildRoute(tracks) {
  /** @type {Route} */
  const route = {
    points: [], cumDist: [], cumUp: [], cumDown: [], trackRanges: [],
    totalDist: 0, totalUp: 0, totalDown: 0, hasElevation: false,
  };
  let withEle = 0;
  let dist = 0;
  let up = 0;
  let down = 0;
  /** @type {Pt|null} */
  let lastPt = null;
  for (const t of tracks) {
    if (!t.visible) continue;
    const pts = effectivePoints(t);
    if (pts.length === 0) continue;
    const startIdx = route.points.length;
    const gap = lastPt ? haversineM(lastPt, pts[0]) : 0;
    const local = new Array(pts.length);
    const eles = new Array(pts.length);
    local[0] = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) local[i] = local[i - 1] + haversineM(pts[i - 1], pts[i]);
      eles[i] = Number.isFinite(pts[i].ele) ? pts[i].ele : null;
      if (eles[i] !== null) withEle++;
    }
    const el = elevationCumulative(eles, local);
    for (let i = 0; i < pts.length; i++) {
      route.points.push({ lat: pts[i].lat, lon: pts[i].lon, ele: eles[i], trackId: t.id });
      route.cumDist.push(dist + local[i]);
      route.cumUp.push(up + el.up[i]);
      route.cumDown.push(down + el.down[i]);
    }
    route.trackRanges.push({
      trackId: t.id, name: t.name, startIdx, endIdx: route.points.length - 1,
      startDist: dist, endDist: dist + local[pts.length - 1], gapBeforeM: gap,
    });
    dist += local[pts.length - 1];
    up += el.up[pts.length - 1];
    down += el.down[pts.length - 1];
    lastPt = pts[pts.length - 1];
  }
  route.totalDist = dist;
  route.totalUp = up;
  route.totalDown = down;
  const total = route.points.length;
  route.hasElevation = total > 0 && withEle / total >= 0.5;
  if (!route.hasElevation) {
    route.cumUp = route.cumUp.map(() => 0);
    route.cumDown = route.cumDown.map(() => 0);
    route.totalUp = 0;
    route.totalDown = 0;
  }
  return route;
}

/**
 * Indice i dell'ultimo punto con cumDist[i] <= d (d gia' limitato a [0,totalDist]).
 * @param {number[]} cum
 * @param {number} d
 */
function lastIndexAtOrBelow(cum, d) {
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * Posizione e dislivelli cumulati a una distanza lungo il percorso.
 * @param {Route} route
 * @param {number} dist
 * @returns {{lat:number, lon:number, ele:number|null, up:number, down:number}}
 */
export function statsAt(route, dist) {
  const n = route.points.length;
  if (n === 0) return { lat: NaN, lon: NaN, ele: null, up: 0, down: 0 };
  const d = Math.min(route.totalDist, Math.max(0, Number.isFinite(dist) ? dist : 0));
  const i = lastIndexAtOrBelow(route.cumDist, d);
  const p = route.points[i];
  if (i >= n - 1 || route.cumDist[i + 1] <= route.cumDist[i]) {
    return { lat: p.lat, lon: p.lon, ele: p.ele, up: route.cumUp[i], down: route.cumDown[i] };
  }
  const span = route.cumDist[i + 1] - route.cumDist[i];
  const t = (d - route.cumDist[i]) / span;
  const q = interpolate(p, route.points[i + 1], t);
  return {
    lat: q.lat, lon: q.lon, ele: q.ele,
    up: route.cumUp[i] + t * (route.cumUp[i + 1] - route.cumUp[i]),
    down: route.cumDown[i] + t * (route.cumDown[i + 1] - route.cumDown[i]),
  };
}

/**
 * Distanza e dislivelli tra due distanze del percorso.
 * @param {Route} route
 * @param {number} dist
 * @param {number} [toDist]
 * @returns {{dist:number, up:number, down:number}}
 */
export function remainingFrom(route, dist, toDist = route.totalDist) {
  const a = Math.min(route.totalDist, Math.max(0, dist));
  const b = Math.min(route.totalDist, Math.max(a, toDist));
  const sa = statsAt(route, a);
  const sb = statsAt(route, b);
  return { dist: b - a, up: Math.max(0, sb.up - sa.up), down: Math.max(0, sb.down - sa.down) };
}

/**
 * Nuovo array in ordine inverso con `reversed` invertito per ogni traccia.
 * @param {Track[]} tracks
 * @returns {Track[]}
 */
export function reverseSession(tracks) {
  return tracks.slice().reverse().map((t) => ({ ...t, reversed: !t.reversed }));
}

/**
 * Tempo secondo la formula del progetto: ore = dist/4000 + max(up/400, down/800).
 * @param {number} dist metri
 * @param {number} up metri
 * @param {number} down metri
 * @returns {number} secondi
 */
export function munterSeconds(dist, up, down) {
  const hours = dist / 4000 + Math.max(up / 400, down / 800);
  return hours * 3600;
}

/**
 * Tempo Munter per il tratto [fromDist,toDist] del percorso.
 * @param {Route} route
 * @param {number} fromDist
 * @param {number} [toDist]
 * @returns {number} secondi
 */
export function routeTimeSeconds(route, fromDist, toDist = route.totalDist) {
  const r = remainingFrom(route, fromDist, toDist);
  return munterSeconds(r.dist, r.up, r.down);
}
