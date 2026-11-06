// Lettura e scrittura GPX. L'unico accesso al DOM e' il DOMParser iniettabile.
import { effectivePoints } from './route.js';

/** Errore di lettura GPX, con messaggio in italiano. */
export class GpxError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'GpxError';
  }
}

/** @param {any} n */
function lname(n) {
  return n.localName || String(n.nodeName).split(':').pop();
}

/**
 * Figli elemento con dato nome locale (ignora namespace e prefissi).
 * @param {any} node
 * @param {string} name
 * @returns {any[]}
 */
function kids(node, name) {
  const out = [];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && lname(c) === name) out.push(c);
  }
  return out;
}

/** @param {any} node @param {string} name @returns {string|null} */
function childText(node, name) {
  const k = kids(node, name)[0];
  return k ? String(k.textContent ?? '').trim() : null;
}

/** @param {string|null|undefined} s @returns {number|null} */
function num(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/**
 * Punto valido da <trkpt>/<rtept>/<wpt>, o null.
 * @param {any} el
 */
function readPoint(el) {
  const lat = num(el.getAttribute('lat'));
  const lon = num(el.getAttribute('lon'));
  if (lat === null || lon === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const ele = num(childText(el, 'ele'));
  return { lat, lon, ele };
}

/**
 * Legge un file GPX (1.0, 1.1, con o senza prefisso). Una traccia per ogni <trk> o <rte>.
 * @param {string} xmlText
 * @param {typeof DOMParser} [DOMParserImpl]
 * @returns {{tracks:Array<{name:string, points:Array<{lat:number,lon:number,ele:number|null}>,
 *   waypoints:Array<{lat:number,lon:number,ele:number|null,name:string}>}>}}
 */
export function parseGpx(xmlText, DOMParserImpl = globalThis.DOMParser) {
  if (typeof xmlText !== 'string') throw new GpxError('File GPX non valido: contenuto non testuale.');
  if (!DOMParserImpl) throw new GpxError('Lettura XML non disponibile su questo dispositivo.');
  const text = xmlText.replace(/^﻿/, '').replace(/^\s+/, '');
  if (text === '') throw new GpxError('Il file è vuoto.');

  /** @type {string[]} */
  const errors = [];
  let doc;
  try {
    // xmldom (0.8 e 0.9) accetta una funzione (livello, messaggio); i browser ignorano le opzioni
    const sink = (/** @type {string} */ level, /** @type {string} */ msg) => { if (level !== 'warning') errors.push(msg); };
    const parser = new DOMParserImpl(/** @type {any} */ ({ onError: sink, errorHandler: sink }));
    doc = parser.parseFromString(text, 'application/xml');
  } catch {
    throw new GpxError('File GPX non valido: XML malformato.');
  }
  if (errors.length > 0 || !doc || !doc.documentElement) {
    throw new GpxError('File GPX non valido: XML malformato.');
  }
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new GpxError('File GPX non valido: XML malformato.');
  }
  const root = doc.documentElement;
  if (lname(root).toLowerCase() !== 'gpx') {
    throw new GpxError('Il file non è un GPX (elemento radice mancante).');
  }

  /** @type {Array<{name:string, points:any[], waypoints:any[]}>} */
  const tracks = [];
  let ordinal = 0;
  for (let c = root.firstChild; c; c = c.nextSibling) {
    if (c.nodeType !== 1) continue;
    const kind = lname(c);
    if (kind !== 'trk' && kind !== 'rte') continue;
    ordinal++;
    const points = [];
    const collect = (/** @type {any} */ el) => {
      const p = readPoint(el);
      if (!p) return;
      const last = points[points.length - 1];
      if (last && last.lat === p.lat && last.lon === p.lon) return;
      points.push(p);
    };
    if (kind === 'trk') {
      for (const seg of kids(c, 'trkseg')) for (const pt of kids(seg, 'trkpt')) collect(pt);
    } else {
      for (const pt of kids(c, 'rtept')) collect(pt);
    }
    if (points.length === 0) continue;
    tracks.push({ name: childText(c, 'name') || `Traccia ${ordinal}`, points, waypoints: [] });
  }

  const waypoints = [];
  for (const w of kids(root, 'wpt')) {
    const p = readPoint(w);
    if (p) waypoints.push({ ...p, name: childText(w, 'name') || '' });
  }

  if (tracks.length === 0) {
    throw new GpxError('Il file GPX non contiene punti di traccia validi.');
  }
  tracks[0].waypoints = waypoints;
  return { tracks };
}

/** @param {string} s */
function esc(s) {
  return String(s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Serializza una traccia in GPX 1.1.
 * @param {{name:string, points:any[], waypoints?:any[], reversed?:boolean}} track
 * @param {{applyReverse?:boolean}} [opts]
 * @returns {string}
 */
export function serializeGpx(track, { applyReverse = true } = {}) {
  const pts = applyReverse ? effectivePoints(/** @type {any} */ (track)) : track.points;
  const eleTag = (/** @type {any} */ e) => (Number.isFinite(e) ? `<ele>${e}</ele>` : '');
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<gpx version="1.1" creator="Sentiero" xmlns="http://www.topografix.com/GPX/1/1">');
  for (const w of track.waypoints || []) {
    out.push(`<wpt lat="${w.lat}" lon="${w.lon}">${eleTag(w.ele)}<name>${esc(w.name || '')}</name></wpt>`);
  }
  out.push(`<trk><name>${esc(track.name)}</name><trkseg>`);
  for (const p of pts) out.push(`<trkpt lat="${p.lat}" lon="${p.lon}">${eleTag(p.ele)}</trkpt>`);
  out.push('</trkseg></trk>');
  out.push('</gpx>');
  return out.join('\n') + '\n';
}
