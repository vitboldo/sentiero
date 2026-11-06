// Utilità per l'E2E: server statico, PNG minimo valido, generatori GPX.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.svg': 'image/svg+xml',
};

/** Server statico di ROOT. `log` raccoglie i path richiesti (per confrontarli con la lista di precache). */
export function startServer(port = 0) {
  const log = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      log.push({ path: rel, status: 404 });
      res.writeHead(404).end('not found');
      return;
    }
    log.push({ path: rel, status: 200 });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    resolve({ server, log, port: server.address().port, origin: `http://localhost:${server.address().port}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) });
  }));
}

// ---- PNG 256x256 valido (colore uniforme, più di 64 byte grazie a una griglia) ----
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** @param {[number,number,number]} rgb */
export function makePng(rgb = [120, 180, 120], size = 256) {
  const row = Buffer.alloc(1 + size * 3);
  const raw = Buffer.alloc(row.length * size);
  for (let y = 0; y < size; y++) {
    raw[y * row.length] = 0;
    for (let x = 0; x < size; x++) {
      const edge = x % 64 === 0 || y % 64 === 0;
      const o = y * row.length + 1 + x * 3;
      const noise = y < 40 ? (Math.imul(x * 73856093 ^ y * 19349663, 2654435761) >>> 24) : 0;
      raw[o] = edge ? 60 : noise || rgb[0]; raw[o + 1] = edge ? 60 : noise || rgb[1]; raw[o + 2] = edge ? 60 : noise || rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- Generatori GPX ----
const M_LAT = 111195;
export function offset(lat0, lon0, dx, dy) {
  return { lat: lat0 + dy / M_LAT, lon: lon0 + dx / (M_LAT * Math.cos((lat0 * Math.PI) / 180)) };
}

/**
 * Punti lungo una poligonale (in metri locali) con un punto ogni `step` m e quota da `eleFn(distanza)`.
 * @param {{lat:number,lon:number}} origin
 * @param {Array<[number,number]>} vertices  vertici in metri (dx, dy) rispetto all'origine
 */
export function samplePath(origin, vertices, eleFn, step = 25) {
  const pts = [];
  let dist = 0;
  for (let i = 1; i < vertices.length; i++) {
    const [x0, y0] = vertices[i - 1];
    const [x1, y1] = vertices[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(len / step));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const t = k / n;
      const p = offset(origin.lat, origin.lon, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
      const d = dist + len * t;
      pts.push({ ...p, ele: eleFn ? eleFn(d) : null });
    }
    dist += len;
  }
  return pts;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function gpxText({ name, points, waypoints = [] }) {
  const pt = (tag, p, extra = '') => `<${tag} lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${p.ele != null ? `<ele>${p.ele.toFixed(1)}</ele>` : ''}${extra}</${tag}>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="e2e" xmlns="http://www.topografix.com/GPX/1/1">
${waypoints.map((w) => '  ' + pt('wpt', w, `<name>${esc(w.name)}</name>`)).join('\n')}
  <trk><name>${esc(name)}</name><trkseg>
${points.map((p) => '    ' + pt('trkpt', p)).join('\n')}
  </trkseg></trk>
</gpx>
`;
}
