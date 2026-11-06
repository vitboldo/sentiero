// Funzioni geografiche pure. Nessuna dipendenza dal DOM.

/** Raggio terrestre medio (m). */
export const EARTH_R = 6371008.8;
const RAD = Math.PI / 180;
/** Metri per grado di latitudine. */
export const M_PER_DEG = EARTH_R * RAD;

/** @typedef {{lat:number, lon:number, ele?:number|null}} LatLon */

/**
 * Distanza ortodromica in metri.
 * @param {LatLon} a
 * @param {LatLon} b
 * @returns {number}
 */
export function haversineM(a, b) {
  const p1 = a.lat * RAD;
  const p2 = b.lat * RAD;
  const dp = p2 - p1;
  const dl = (b.lon - a.lon) * RAD;
  const s = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Direzione iniziale da a verso b, in gradi [0,360) dal nord.
 * @param {LatLon} a
 * @param {LatLon} b
 * @returns {number}
 */
export function bearingDeg(a, b) {
  const p1 = a.lat * RAD;
  const p2 = b.lat * RAD;
  const dl = (b.lon - a.lon) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / RAD) + 360) % 360;
}

/**
 * Proietta p sul segmento a-b (piano equirettangolare locale centrato in a).
 * @param {LatLon} p
 * @param {LatLon} a
 * @param {LatLon} b
 * @returns {{t:number, lat:number, lon:number, distM:number}}
 */
export function projectToSegment(p, a, b) {
  const ky = M_PER_DEG;
  const kx = M_PER_DEG * Math.cos(((a.lat + b.lat) / 2) * RAD);
  const bx = (b.lon - a.lon) * kx;
  const by = (b.lat - a.lat) * ky;
  const px = (p.lon - a.lon) * kx;
  const py = (p.lat - a.lat) * ky;
  const l2 = bx * bx + by * by;
  let t = l2 > 0 ? (px * bx + py * by) / l2 : 0;
  t = Math.min(1, Math.max(0, t));
  const cx = t * bx;
  const cy = t * by;
  return {
    t,
    lat: a.lat + t * (b.lat - a.lat),
    lon: a.lon + t * (b.lon - a.lon),
    distM: Math.hypot(px - cx, py - cy),
  };
}

/**
 * Interpolazione lineare tra due punti. La quota e' interpolata solo se presente in entrambi.
 * @param {LatLon} a
 * @param {LatLon} b
 * @param {number} t
 * @returns {{lat:number, lon:number, ele:number|null}}
 */
export function interpolate(a, b, t) {
  const ea = Number.isFinite(a.ele) ? /** @type {number} */ (a.ele) : null;
  const eb = Number.isFinite(b.ele) ? /** @type {number} */ (b.ele) : null;
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
    ele: ea !== null && eb !== null ? ea + (eb - ea) * t : null,
  };
}

/**
 * Distanza leggibile in italiano: "850 m", "2,3 km".
 * @param {number} m
 * @returns {string}
 */
export function formatKm(m) {
  if (!Number.isFinite(m)) return '—';
  const v = Math.max(0, m);
  if (v < 1000) return `${Math.round(v)} m`;
  return `${(v / 1000).toFixed(1).replace('.', ',')} km`;
}

/**
 * Durata leggibile: "45 min", "2 h 05 min".
 * @param {number} sec
 * @returns {string}
 */
export function formatDuration(sec) {
  if (!Number.isFinite(sec)) return '—';
  const totalMin = Math.round(Math.max(0, sec) / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return `${h} h ${String(m).padStart(2, '0')} min`;
}
