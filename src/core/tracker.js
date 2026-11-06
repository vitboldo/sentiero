// Stato del tracciamento: qualita' del GPS, ultimo punto sicuro, stima, ritmo.
// Il tempo e' sempre esplicito (nowMs), mai letto da orologi globali nelle funzioni di calcolo.

import { haversineM, bearingDeg } from './geo.js';
import { matchPosition } from './matcher.js';
import { statsAt, remainingFrom, munterSeconds, routeTimeSeconds } from './route.js';

/**
 * @typedef {import('./route.js').Route} Route
 * @typedef {{lat:number, lon:number, accuracy:number, timestamp:number, speed?:number|null}} Fix
 */

export const FRESH_S = 15;
export const GOOD_ACCURACY_M = 30;
export const MAX_ACCURACY_M = 100;
export const LOST_AFTER_S = 45;
export const MAX_SPEED_MS = 4;
export const PACE_WINDOW_S = 30 * 60;
export const PACE_MIN_SAMPLE_M = 500;
export const PACE_MIN = 0.5;
export const PACE_MAX = 2.0;
export const FAST_FACTOR = 1.4;
export const RECOVERED_S = 30;
export const MAX_ESTIMATE_S = 2 * 3600;
// Fix precisi e coerenti tra loro ma lontani dall'ultimo punto sicuro: e' un mezzo (auto, funivia),
// non un errore del GPS. Senza questo l'app resterebbe "debole" con segnale perfetto.
const REANCHOR_FIXES = 4;
const REANCHOR_SPAN_S = 15;
const REANCHOR_MAX_SPEED_MS = 60;
const SAMPLE_EVERY_S = 5;
const SAMPLE_MAX_GAP_S = 90;
const STOP_SPEED_MS = 0.3;

/**
 * @param {Route} route
 * @param {{restored?:any}} [opts]
 */
export function createTracker(route, { restored = null } = {}) {
  /** @type {Fix|null} */ let lastFix = null;
  let lastFixPlausible = true;
  /** @type {number|null} */ let lastUsableTs = null;
  /** @type {{lat:number,lon:number,distAlong:number,timestamp:number,accuracy:number,onTrack:boolean}|null} */
  let lastSure = null;
  /** @type {{distAlong:number, timestamp:number, pendingJump:any}|null} */
  let progress = null;
  /** @type {any} */ let lastMatch = null;
  /** @type {Array<{t:number,d:number}>} */ let samples = [];
  /** @type {{at:number, deltaM:number}|null} */ let recovered = null;
  /** @type {{count:number, first:number, last:Fix}|null} */ let implausibleRun = null;

  const sig = { n: route.points.length, total: Math.round(route.totalDist) };
  if (restored && restored.v === 1 && restored.sig && restored.sig.n === sig.n &&
      Math.abs(restored.sig.total - sig.total) <= 1) {
    lastFix = restored.lastFix ?? null;
    lastFixPlausible = restored.lastFixPlausible !== false;
    lastUsableTs = restored.lastUsableTs ?? null;
    lastSure = restored.lastSure ?? null;
    progress = restored.progress ?? null;
    lastMatch = restored.lastMatch ?? null;
    samples = Array.isArray(restored.samples) ? restored.samples : [];
    recovered = restored.recovered ?? null;
  }

  /** @param {number} nowMs */
  function paceInfo(nowMs) {
    let real = 0;
    let dist = 0;
    let up = 0;
    let down = 0;
    const from = nowMs / 1000 - PACE_WINDOW_S;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      if (b.t < from) continue;
      const dt = b.t - a.t;
      const dd = b.d - a.d;
      if (dt <= 0 || dt > SAMPLE_MAX_GAP_S || dd <= 0) continue;
      const v = dd / dt;
      if (v < STOP_SPEED_MS || v > MAX_SPEED_MS) continue;
      const r = remainingFrom(route, a.d, b.d);
      real += dt;
      dist += dd;
      up += r.up;
      down += r.down;
    }
    if (dist < PACE_MIN_SAMPLE_M) return { pace: 1, source: /** @type {const} */ ('predefinito') };
    const m = munterSeconds(dist, up, down);
    if (!(m > 0)) return { pace: 1, source: /** @type {const} */ ('predefinito') };
    return { pace: Math.min(PACE_MAX, Math.max(PACE_MIN, real / m)), source: /** @type {const} */ ('osservato') };
  }

  /** @param {number} nowMs */
  function qualityAt(nowMs) {
    if (!lastFix) return lastSure || progress ? 'lost' : 'none';
    const age = Math.max(0, (nowMs - lastFix.timestamp) / 1000);
    if (age <= FRESH_S) {
      if (lastFix.accuracy > MAX_ACCURACY_M) return 'lost';
      if (lastFix.accuracy > GOOD_ACCURACY_M || !lastFixPlausible) return 'weak';
      return 'good';
    }
    if (lastUsableTs !== null && (nowMs - lastUsableTs) / 1000 <= LOST_AFTER_S) return 'weak';
    return 'lost';
  }

  /**
   * Distanza lungo la route che si raggiunge in `seconds` partendo da d0.
   * @param {number} d0
   * @param {number} seconds
   * @param {number} pace
   */
  function advance(d0, seconds, pace) {
    const total = route.totalDist;
    if (routeTimeSeconds(route, d0, total) * pace <= seconds) return total;
    let lo = d0;
    let hi = total;
    for (let k = 0; k < 50; k++) {
      const mid = (lo + hi) / 2;
      if (routeTimeSeconds(route, d0, mid) * pace <= seconds) lo = mid; else hi = mid;
    }
    return lo;
  }

  /** @param {number} nowMs */
  function estimateAt(nowMs) {
    if (!lastSure) return { estimate: null, reason: 'nessun punto sicuro' };
    if (!lastSure.onTrack) return { estimate: null, reason: 'fuori traccia' };
    const elapsed = Math.max(0, (nowMs - lastSure.timestamp) / 1000);
    if (elapsed > MAX_ESTIMATE_S) return { estimate: null, reason: 'troppo tempo senza GPS' };
    const { pace, source } = paceInfo(nowMs);
    const d0 = Math.min(route.totalDist, Math.max(0, lastSure.distAlong));
    const dist = advance(d0, elapsed, pace);
    const maxDist = advance(d0, elapsed, pace / FAST_FACTOR);
    const at = statsAt(route, dist);
    return {
      estimate: {
        distAlong: dist, lat: at.lat, lon: at.lon, minDist: lastSure.distAlong,
        maxDist: Math.max(dist, maxDist), ageSec: elapsed, pace, paceSource: source,
      },
      reason: null,
    };
  }

  /**
   * Registra un fix. `nowMs` e' l'istante di ricezione (default: orologio di sistema).
   * @param {Fix} fix
   * @param {number} [nowMs]
   */
  function ingestFix(fix, nowMs = Date.now()) {
    if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon) || !Number.isFinite(fix.timestamp)) return;
    const accuracy = Number.isFinite(fix.accuracy) ? fix.accuracy : 9999;
    const f = { lat: fix.lat, lon: fix.lon, accuracy, timestamp: fix.timestamp, speed: fix.speed ?? null };
    const prevQ = qualityAt(nowMs);
    const prevEst = prevQ === 'lost' ? estimateAt(nowMs).estimate : null;
    const fresh = (nowMs - f.timestamp) / 1000 <= FRESH_S;

    // un fix piu' vecchio di quello gia' noto non deve far arretrare lo stato
    if (lastFix && f.timestamp < lastFix.timestamp) return;

    // plausibilita' rispetto all'ultimo punto sicuro (si sottraggono le incertezze)
    let plausible = true;
    if (lastSure) {
      const dt = Math.max(1, (f.timestamp - lastSure.timestamp) / 1000);
      const dd = Math.max(0, haversineM(lastSure, f) - Math.min(f.accuracy, 100) - Math.min(lastSure.accuracy, 100));
      plausible = dd / dt <= MAX_SPEED_MS;
    }
    if (plausible || !fresh || f.accuracy > GOOD_ACCURACY_M) {
      implausibleRun = null;
    } else {
      const prev = implausibleRun?.last;
      const gapS = prev ? Math.max(1, (f.timestamp - prev.timestamp) / 1000) : 0;
      const coherent = prev && haversineM(prev, f) / gapS <= REANCHOR_MAX_SPEED_MS;
      implausibleRun = coherent
        ? { count: implausibleRun.count + 1, first: implausibleRun.first, last: f }
        : { count: 1, first: f.timestamp, last: f };
      if (implausibleRun.count >= REANCHOR_FIXES &&
          (f.timestamp - implausibleRun.first) / 1000 >= REANCHOR_SPAN_S) {
        plausible = true;
        implausibleRun = null;
      }
    }
    lastFix = f;
    lastFixPlausible = plausible;
    if (!fresh || f.accuracy > MAX_ACCURACY_M) return;
    lastUsableTs = f.timestamp;
    if (!plausible) return; // fresco ma implausibile: non avanza ne' aggiorna lastSure

    const prevForMatch = progress
      ? { distAlong: progress.distAlong, timestamp: progress.timestamp, pendingJump: progress.pendingJump }
      : null;
    const r = matchPosition(route, f, prevForMatch);
    lastMatch = r;
    const onTrackFresh = !r.offTrack && !r.pendingJump;
    progress = {
      distAlong: r.distAlong,
      timestamp: onTrackFresh || !progress ? f.timestamp : progress.timestamp,
      pendingJump: r.pendingJump,
    };
    if (prevQ === 'lost' && prevEst) {
      recovered = { at: nowMs, deltaM: r.distAlong - prevEst.distAlong };
    }
    if (f.accuracy <= GOOD_ACCURACY_M) {
      lastSure = {
        lat: f.lat, lon: f.lon, distAlong: r.distAlong, timestamp: f.timestamp,
        accuracy: f.accuracy, onTrack: !r.offTrack,
      };
      if (onTrackFresh) {
        const last = samples[samples.length - 1];
        if (!last || f.timestamp / 1000 - last.t >= SAMPLE_EVERY_S) {
          samples.push({ t: f.timestamp / 1000, d: r.distAlong });
          const cutoff = f.timestamp / 1000 - PACE_WINDOW_S;
          while (samples.length > 2 && samples[0].t < cutoff) samples.shift();
        }
      }
    }
  }

  /** @param {number} dist @param {number} pace */
  function remainingBlock(dist, pace) {
    const r = remainingFrom(route, dist);
    return { dist: r.dist, up: r.up, down: r.down, etaSec: routeTimeSeconds(route, dist) * pace };
  }

  /** @param {number} nowMs */
  function snapshot(nowMs) {
    const quality = qualityAt(nowMs);
    const { pace } = paceInfo(nowMs);
    const ageSec = lastFix ? Math.max(0, (nowMs - lastFix.timestamp) / 1000) : null;
    let estimate = null;
    let reason = null;
    if (quality === 'lost') ({ estimate, reason } = estimateAt(nowMs));

    /** @type {'gps'|'approssimata'|'stima'|'nessuna'} */
    let source = 'nessuna';
    let dist = progress ? progress.distAlong : 0;
    if (quality === 'good') source = 'gps';
    else if (quality === 'weak') source = 'approssimata';
    else if (quality === 'lost' && estimate) { source = 'stima'; dist = estimate.distAlong; }
    dist = Math.min(route.totalDist, Math.max(0, dist));

    const showMatch = quality === 'good' || quality === 'weak' || (quality === 'lost' && !estimate && lastMatch);
    const m = showMatch ? lastMatch : null;
    const gps = lastFix
      ? { lat: lastFix.lat, lon: lastFix.lon, accuracy: lastFix.accuracy, timestamp: lastFix.timestamp }
      : null;
    const offTrack = !!(m && m.offTrack);
    const nearest = m && Number.isFinite(m.offTrackM) ? { lat: m.lat, lon: m.lon } : null;
    const bearingToTrackDeg = offTrack && gps && nearest ? bearingDeg(gps, nearest) : null;

    const done = remainingFrom(route, 0, dist);
    const rem = remainingBlock(dist, pace);

    let currentTrack = null;
    const ranges = route.trackRanges;
    if (ranges.length) {
      let idx = ranges.findIndex((r) => dist < r.endDist);
      if (idx < 0) idx = ranges.length - 1;
      const tr = ranges[idx];
      const rr = remainingFrom(route, dist, tr.endDist);
      currentTrack = {
        trackId: tr.trackId, name: tr.name, index: idx,
        remaining: { dist: rr.dist, up: rr.up, down: rr.down, etaSec: routeTimeSeconds(route, dist, tr.endDist) * pace },
      };
    }

    const justRecovered = recovered && nowMs - recovered.at <= RECOVERED_S * 1000 && nowMs >= recovered.at
      ? { deltaM: recovered.deltaM } : null;

    return {
      quality,
      accuracy: lastFix ? lastFix.accuracy : null,
      ageSec,
      gps,
      lastSure: lastSure ? { ...lastSure } : null,
      estimate,
      estimateUnavailableReason: reason,
      distAlong: dist,
      source,
      offTrack,
      offTrackM: m && Number.isFinite(m.offTrackM) ? m.offTrackM : null,
      nearest,
      bearingToTrackDeg,
      ambiguous: !!(m && m.ambiguous),
      done,
      remaining: rem,
      currentTrack,
      justRecovered,
    };
  }

  /** JSON persistibile. */
  function serialize() {
    return JSON.parse(JSON.stringify({
      v: 1, sig, lastFix, lastFixPlausible, lastUsableTs, lastSure, progress, lastMatch, samples, recovered,
    }));
  }

  return { ingestFix, snapshot, serialize };
}
