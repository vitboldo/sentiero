// Modifiche immutabili alle tracce. Ogni funzione restituisce una nuova Track.
import { effectivePoints } from './route.js';

/**
 * Snapshot "originale" salvato alla prima modifica. Include i waypoint (estensione del
 * modello: serve a ripristinarli dopo removeWaypoint).
 * @param {any} t
 */
function withOriginal(t) {
  return t.original || { name: t.name, points: t.points, waypoints: t.waypoints };
}

/**
 * @param {any} t
 * @param {string} name
 */
export function renameTrack(t, name) {
  if (name === t.name) return t;
  return { ...t, name, original: withOriginal(t) };
}

/**
 * Cambia la direzione di marcia (i punti restano nell'ordine del file).
 * @param {any} t
 */
export function toggleReverse(t) {
  return { ...t, reversed: !t.reversed };
}

/**
 * Taglia la traccia tenendo i punti [startIdx, endIdx] (inclusi) di effectivePoints.
 * @param {any} t
 * @param {number} startIdx
 * @param {number} endIdx
 */
export function trimTrack(t, startIdx, endIdx) {
  const eff = effectivePoints(t);
  if (!Number.isInteger(startIdx) || !Number.isInteger(endIdx) ||
      startIdx < 0 || endIdx > eff.length - 1 || startIdx >= endIdx) {
    throw new RangeError('Intervallo di taglio non valido: servono almeno due punti.');
  }
  const kept = eff.slice(startIdx, endIdx + 1);
  return {
    ...t,
    points: t.reversed ? kept.slice().reverse() : kept,
    original: withOriginal(t),
  };
}

/**
 * Unisce b dopo a nelle direzioni effettive. Risultato `reversed:false`, senza `original`
 * (il ripristino di una fusione non e' definito).
 * @param {any} a
 * @param {any} b
 * @param {string} newId
 */
export function mergeTracks(a, b, newId) {
  const pa = effectivePoints(a);
  const pb = effectivePoints(b);
  const joinDup = pa.length > 0 && pb.length > 0 &&
    pa[pa.length - 1].lat === pb[0].lat && pa[pa.length - 1].lon === pb[0].lon;
  return {
    id: newId,
    name: `${a.name} + ${b.name}`,
    color: a.color,
    visible: true,
    reversed: false,
    points: pa.concat(joinDup ? pb.slice(1) : pb),
    waypoints: [...(a.waypoints || []), ...(b.waypoints || [])],
    original: null,
  };
}

/**
 * @param {any} t
 * @param {number} i
 */
export function removeWaypoint(t, i) {
  const wps = t.waypoints || [];
  if (!Number.isInteger(i) || i < 0 || i >= wps.length) {
    throw new RangeError('Waypoint inesistente.');
  }
  return { ...t, waypoints: wps.filter((_, k) => k !== i), original: withOriginal(t) };
}

/**
 * Ripristina nome, punti e waypoint originali; la direzione scelta resta invariata.
 * @param {any} t
 */
export function restoreOriginal(t) {
  if (!t.original) return t;
  return {
    ...t,
    name: t.original.name,
    points: t.original.points,
    waypoints: t.original.waypoints ?? t.waypoints,
    original: null,
  };
}
