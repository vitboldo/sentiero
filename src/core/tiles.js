// Calcolo delle tile da scaricare lungo un corridoio attorno alla traccia (mai il bbox).

export const TILE_URL = 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png';
export const MAX_TILES = 10000;
export const MIN_ZOOM = 10;
export const BYTES_PER_TILE = 40 * 1024;
export const BUFFER_OPTIONS_M = [500, 1000, 2000];
export const DEFAULT_BUFFER_M = 1000;
export const PRECISION_PRESETS = [
  { id: 'bassa', label: 'Bassa', maxZoom: 13 },
  { id: 'media', label: 'Media', maxZoom: 14 },
  { id: 'alta', label: 'Alta', maxZoom: 15 },
  { id: 'massima', label: 'Massima', maxZoom: 16 },
];

const RAD = Math.PI / 180;
const EQUATOR_M = 40075016.686;
const MAX_LAT = 85.0511287798;

/**
 * Coordinate frazionarie di tile.
 * @param {number} lat
 * @param {number} lon
 * @param {number} z
 */
function tileCoord(lat, lon, z) {
  const n = 2 ** z;
  const la = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * RAD;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n;
  return { x, y };
}

/**
 * Tile entro bufferM metri dalla spezzata (distanza dal rettangolo della tile).
 * Il campionamento ogni ~bufferM/10 e' compensato allargando la soglia di mezzo passo,
 * cosi' nessuna tile del corridoio viene persa.
 * @param {Array<{lat:number, lon:number}>} points
 * @param {{minZoom?:number, maxZoom?:number, bufferM?:number}} [opts]
 * @returns {Array<{z:number, x:number, y:number}>}
 */
export function tilesForCorridor(points, { minZoom = MIN_ZOOM, maxZoom = 14, bufferM = DEFAULT_BUFFER_M } = {}) {
  if (!points || points.length === 0) return [];
  const step = Math.max(25, bufferM / 10);
  /** @type {Array<{lat:number, lon:number}>} */
  const samples = [];
  const cosAt = (/** @type {number} */ lat) => Math.cos(lat * RAD);
  samples.push(points[0]);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dy = (b.lat - a.lat) * 111195;
    const dx = (b.lon - a.lon) * 111195 * cosAt((a.lat + b.lat) / 2);
    const len = Math.hypot(dx, dy);
    const k = Math.ceil(len / step);
    for (let j = 1; j <= k; j++) {
      const t = j / k;
      samples.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
    }
  }
  const reach = bufferM + step / 2;
  /** @type {Array<{z:number, x:number, y:number}>} */
  const out = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const n = 2 ** z;
    const seen = new Set();
    for (const s of samples) {
      const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, s.lat));
      const c = tileCoord(lat, s.lon, z);
      const tileM = (EQUATOR_M / n) * cosAt(lat);
      const r = reach / tileM; // raggio in unita' tile
      const x0 = Math.max(0, Math.floor(c.x - r));
      const x1 = Math.min(n - 1, Math.floor(c.x + r));
      const y0 = Math.max(0, Math.floor(c.y - r));
      const y1 = Math.min(n - 1, Math.floor(c.y + r));
      for (let ty = y0; ty <= y1; ty++) {
        const dy = Math.max(ty - c.y, 0, c.y - (ty + 1));
        for (let tx = x0; tx <= x1; tx++) {
          const key = ty * n + tx;
          if (seen.has(key)) continue;
          const dx = Math.max(tx - c.x, 0, c.x - (tx + 1));
          if (Math.hypot(dx, dy) * tileM <= reach) {
            seen.add(key);
            out.push({ z, x: tx, y: ty });
          }
        }
      }
    }
  }
  return out;
}

/**
 * Stima del peso in byte (40 KB a tile).
 * @param {Array<unknown>} tiles
 */
export function estimateBytes(tiles) {
  return tiles.length * BYTES_PER_TILE;
}

/**
 * @param {{z:number, x:number, y:number}} t
 * @returns {string}
 */
export function tileUrl({ z, x, y }) {
  return TILE_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}
