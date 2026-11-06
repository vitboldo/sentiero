// Infrastruttura E2E: framework di asserzioni, apertura pagina iPhone 15 con tile stubbate, fixture GPX, camminata simulata.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';
import { DOMParser } from '@xmldom/xmldom';
import { startServer, makePng, samplePath, gpxText, offset } from './lib.mjs';
import { parseGpx } from '../src/core/gpx.js';
import { statsAt } from '../src/core/route.js';
import { haversineM } from '../src/core/geo.js';

export { samplePath, gpxText, offset };

export const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const [k, v] = a.slice(2).split('=');
  return [k, v ?? true];
}));
export const ONLY = args.only ? String(args.only).split(',').map(Number) : null;
export const SHOTS = fileURLToPath(new URL('../test-results/shots', import.meta.url));
fs.mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------- framework
export const results = [];
let cur = null;
export const session = { realTiles: 0, REAL_TILE_CAP: 30, srv: null };

export function ck(desc, cond, detail = '') {
  cur.assertions++;
  if (!cond) {
    const d = detail === '' ? '' : ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    cur.failures.push(`${desc}${d}`);
    console.log(`    FAIL ${desc}${d}`);
  }
}
export const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;
export const ckNear = (desc, a, b, tol) => ck(`${desc} (atteso ${typeof b === 'number' ? +b.toFixed(2) : b} ±${tol})`, near(a, b, tol), a);
export const note = (s) => { cur.note += (cur.note ? ' | ' : '') + s; console.log(`    nota: ${s}`); };

/** @param {(use:(app:any)=>any, cur:any)=>Promise<void>} fn  `use(app)` registra l'app per il controllo errori finale. */
export async function scenario(id, name, engine, fn) {
  if (ONLY && !ONLY.includes(id)) return;
  if (args.engine && args.engine !== engine) return;
  cur = { id, name, engine, status: 'pass', assertions: 0, failures: [], note: '' };
  results.push(cur);
  console.log(`\n[${id}] ${name} (${engine})`);
  const t0 = Date.now();
  let app = null;
  try {
    await fn((a) => { app = a; return a; });
  } catch (err) {
    cur.failures.push(`ECCEZIONE: ${err.stack?.split('\n').slice(0, 4).join(' | ')}`);
    console.log(`    EXCEPTION ${err.stack?.split('\n').slice(0, 3).join(' | ')}`);
  }
  if (app?.errors) {
    const rej = await app.page.evaluate(() => window.__rej ?? []).catch(() => []);
    app.errors.push(...rej.map((r) => `unhandledrejection: ${r}`));
    ck('nessun errore di console / pageerror / unhandledrejection', app.errors.length === 0, app.errors.slice(0, 5));
    if (app.warnings.length) console.log(`    avvisi console: ${JSON.stringify(app.warnings.slice(0, 3))}`);
  }
  if (app?.close) await app.close().catch(() => {});
  if (cur.failures.length) cur.status = 'fail';
  console.log(`  -> ${cur.status.toUpperCase()} (${cur.assertions} controlli, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

export function skipScenario(id, name, engine, reason) {
  if (ONLY && !ONLY.includes(id)) return;
  results.push({ id, name, engine, status: 'not-run', assertions: 0, failures: [], note: reason });
  console.log(`\n[${id}] ${name} (${engine}) NON ESEGUITO: ${reason}`);
}

// ---------------------------------------------------------------- browser e pagina
const browsers = {};
export async function browserFor(engine) {
  browsers[engine] ??= await (engine === 'webkit' ? webkit : chromium).launch();
  return browsers[engine];
}
export async function closeBrowsers() {
  for (const b of Object.values(browsers)) await b.close();
}
export const PNG = makePng();
export async function startStatic(port = 0) {
  session.srv = await startServer(port);
  return session.srv;
}

/**
 * Pagina iPhone 15 con tile stubbate (PNG valido). Raccoglie errori, richieste e richieste fallite.
 * @param {string} engine
 * @param {{clock?:boolean, geo?:object|null, perms?:string[], init?:string, welcome?:boolean, viewport?:object}} o
 */
export async function openApp(engine, o = {}) {
  const { clock = true, geo = null, perms = ['geolocation'], welcome = true, sw = false } = o;
  const browser = await browserFor(engine);
  const ctx = await browser.newContext({
    ...devices['iPhone 15'],
    ...(geo ? { geolocation: geo } : {}),
    permissions: perms,
    acceptDownloads: true,
    // Per default niente service worker (le richieste del SW non passano da context.route in WebKit).
    serviceWorkers: sw ? 'allow' : 'block',
    // Rete di sicurezza: qualsiasi richiesta non locale che sfugge agli stub fallisce invece di andare a opentopomap.org.
    proxy: { server: 'http://127.0.0.1:9', bypass: 'localhost,127.0.0.1' },
  });
  const app = { engine, ctx, errors: [], warnings: [], tileReqs: [], failed: [], reqs: [], allowReal: false, realUrls: [], tileFail: false, tileAborted: [], tileTimes: [], expectedErrors: [], expectedSeen: 0 };
  await ctx.route(/^https:\/\/[a-c]\.tile\.opentopomap\.org\//, async (route) => {
    const url = route.request().url();
    if (app.tileFail) {
      app.tileAborted.push(url);
      return route.abort('internetdisconnected');
    }
    app.tileTimes.push({ url, t: Date.now() });
    if (app.allowReal && session.realTiles < session.REAL_TILE_CAP) {
      session.realTiles++;
      app.realUrls.push(url);
      return route.continue();
    }
    app.tileReqs.push(url);
    return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: PNG });
  });
  const page = await ctx.newPage();
  app.page = page;
  page.on('console', (m) => {
    if (m.type() === 'error') {
      if (app.expectedErrors.some((re) => re.test(m.text()))) app.expectedSeen++;
      else app.errors.push(`console.error: ${m.text()}`);
    }
    else if (m.type() === 'warning') app.warnings.push(m.text());
  });
  page.on('pageerror', (e) => app.errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => app.failed.push(`${r.url()} ${r.failure()?.errorText}`));
  page.on('request', (r) => app.reqs.push(r.url()));
  await page.addInitScript(() => {
    window.__rej = [];
    window.addEventListener('unhandledrejection', (e) => window.__rej.push(String(e.reason?.stack ?? e.reason)));
  });
  // Playwright non emula le safe-area di iOS: si impongono i valori di un iPhone 15 (notch 47 px, home indicator 34 px).
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = ':root{--safe-t:47px;--safe-b:34px}';
      document.head.append(style);
    });
  });
  if (o.init) await page.addInitScript(o.init);
  if (clock) await page.clock.install({ time: new Date() });
  app.close = () => ctx.close();
  app.boot = async () => {
    await page.goto(session.srv.origin + '/');
    await page.waitForFunction(() => !!window.__sentiero);
    if (welcome) await dismissWelcome(app);
  };
  return app;
}

export async function dismissWelcome(app) {
  await app.page.waitForSelector('.modal', { timeout: 8000 });
  await app.page.click('.modal button');
  await app.page.waitForSelector('.modal', { state: 'detached' });
}

// ---------------------------------------------------------------- lettura stato
export const snap = (p) => p.evaluate(() => window.__sentiero.snapshot());
export const txt = (p, sel) => p.locator(sel).first().textContent();
export const tracksOf = (p) => p.evaluate(() => window.__sentiero.tracks().map((t) => ({
  id: t.id, name: t.name, reversed: t.reversed, visible: t.visible, n: t.points.length, wp: t.waypoints.length, hasOriginal: !!t.original,
  first: t.points[0], last: t.points[t.points.length - 1],
})));
export const parseIt = (s) => Number(String(s).replace(/[^\d,.-]/g, '').replace(',', '.'));
const fmt1 = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const fmtKmT = (m) => fmt1.format(m / 1000);
export function fmtTimeT(sec) {
  const total = Math.max(0, Math.round(sec / 60));
  const h = Math.floor(total / 60);
  return h > 0 ? `${h}h${String(total % 60).padStart(2, '0')}` : `${total}min`;
}
export const minutesOf = (s) => {
  const m = /^~?(?:(\d+)h)?(\d+)(?:min)?$/.exec(s.trim());
  return m ? (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]) : NaN;
};
export const panel = async (p) => ({
  dist: await txt(p, '#st-dist'), up: await txt(p, '#st-up'), down: await txt(p, '#st-down'), time: await txt(p, '#st-time'),
  caption: await txt(p, '#caption'), label: await txt(p, '#profile-label'),
});

// ---------------------------------------------------------------- azioni UI
export async function importFiles(app, files) {
  const p = app.page;
  if (!(await p.locator('.sheet').count())) await p.click('#btn-tracks');
  await p.setInputFiles('#file-input', files.map((f) => ({ name: f.name, mimeType: 'application/octet-stream', buffer: Buffer.from(f.text) })));
  await p.waitForSelector('.notice[role=status]');
}
export const closeSheet = async (p) => {
  if (await p.locator('.sheet').count()) await p.click('.sheet-head button');
  await p.waitForSelector('.sheet', { state: 'detached' });
};
export const sleepRT = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fixture
export const O = { lat: 46.0, lon: 11.0 };
const alpha = samplePath(O, [[0, 0], [0, 1500], [600, 2400], [1400, 2400]], (d) => (d < 2200 ? 1800 + 300 * (d / 2200) : 2100 - 100 * ((d - 2200) / 1000)));
const bravo = samplePath(O, [[1750, 2400], [1750, 3400], [2600, 3900], [3400, 3900]], (d) => (d < 1900 ? 2000 - 300 * (d / 1900) : 1700 + 150 * ((d - 1900) / 1100)));
const charlie = samplePath(O, [[3460, 3900], [3460, 5200], [4400, 5900]], (d) => 1850 + 400 * (d / 2000));
const wps = (arr) => arr.map(([dx, dy, name]) => ({ ...offset(O.lat, O.lon, dx, dy), ele: 1900, name }));
export const FILES3 = [
  { name: 'alpha.gpx', text: gpxText({ name: 'Alpha', points: alpha, waypoints: wps([[0, 1500, 'Rifugio Uno'], [600, 2400, 'Passo Due']]) }) },
  { name: 'bravo.gpx', text: gpxText({ name: 'Bravo', points: bravo }) },
  { name: 'charlie.gpx', text: gpxText({ name: 'Charlie', points: charlie }) },
];
export const BAD = { name: 'rotto.gpx', text: 'questo non è un file GPX <<<' };

export function nodeTracks(files) {
  return files.flatMap((f, i) => parseGpx(f.text, DOMParser).tracks.map((t, j) => ({
    id: `n${i}_${j}`, name: t.name, points: t.points, waypoints: t.waypoints, visible: true, reversed: false, original: null,
  })));
}
const straight = samplePath(O, [[0, 0], [0, 3000]], (d) => (d < 2400 ? 1800 + 400 * (d / 2400) : 2200 - 100 * ((d - 2400) / 600)));
export const FILE_STRAIGHT = { name: 'dritta.gpx', text: gpxText({ name: 'Dritta', points: straight }) };
const out = samplePath(O, [[0, 0], [0, 1500], [700, 2100]], (d) => 1700 + 0.2 * d);
const outAndBack = [...out, ...out.slice(0, -1).reverse().map((p) => ({ ...p }))];
export const FILE_OAB = { name: 'andata-ritorno.gpx', text: gpxText({ name: 'Andata e ritorno', points: outAndBack }) };

// ---------------------------------------------------------------- camminata simulata (orologio finto)
const physCache = new WeakMap();
/** Percorso fisico: i salti tra tracce vengono percorsi in linea retta (a piedi), con rd = distanza di route costante. */
function physical(route) {
  if (physCache.has(route)) return physCache.get(route);
  const pts = [];
  let pd = 0;
  const push = (lat, lon, rd) => {
    if (pts.length) pd += haversine(pts[pts.length - 1], { lat, lon });
    pts.push({ lat, lon, rd, pd });
  };
  route.points.forEach((q, i) => {
    if (i > 0 && q.trackId !== route.points[i - 1].trackId) {
      const a = route.points[i - 1];
      const n = Math.max(1, Math.ceil(haversine(a, q) / 10));
      for (let k = 1; k < n; k++) push(a.lat + ((q.lat - a.lat) * k) / n, a.lon + ((q.lon - a.lon) * k) / n, route.cumDist[i]);
    }
    push(q.lat, q.lon, route.cumDist[i]);
  });
  physCache.set(route, pts);
  return pts;
}
const haversine = (a, b) => haversineM(a, b);
function atPhys(pts, pd) {
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid].pd < pd) lo = mid + 1; else hi = mid; }
  const j = Math.max(1, lo);
  const a = pts[j - 1];
  const b = pts[j];
  const t = b.pd > a.pd ? Math.min(1, Math.max(0, (pd - a.pd) / (b.pd - a.pd))) : 0;
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, rd: a.rd + (b.rd - a.rd) * t };
}
/** Distanza fisica (m) a cui si raggiunge la distanza di route `rd`. */
export function physOf(route, rd) {
  const pts = physical(route);
  const i = pts.findIndex((q) => q.rd >= rd);
  return pts[i < 0 ? pts.length - 1 : i].pd;
}
/**
 * Cammina dalla distanza di route `from` a `to`, un fix ogni `step` m a `speed` m/s (orologio finto).
 * Restituisce la distanza di route dell'ultimo fix inviato.
 */
export async function walk(app, route, from, to, { step = 30, speed = 1.6, accuracy = 8, lateral = null } = {}) {
  const pts = physical(route);
  const p0 = physOf(route, from);
  const p1 = physOf(route, to);
  const dir = Math.sign(p1 - p0) || 1;
  let rd = from;
  for (let pd = p0; dir > 0 ? pd <= p1 + 1e-6 : pd >= p1 - 1e-6; pd += dir * step) {
    const pos = atPhys(pts, pd);
    rd = pos.rd;
    await app.page.clock.fastForward(Math.round((step / speed) * 1000));
    const at = lateral ? offset(pos.lat, pos.lon, lateral[0], lateral[1]) : pos;
    await app.page.evaluate((f) => window.__sentiero.injectFix(f), { lat: at.lat, lon: at.lon, accuracy });
  }
  return rd;
}
export const injectAt = (app, route, dist, extra = {}) => {
  const pos = statsAt(route, dist);
  return app.page.evaluate((f) => window.__sentiero.injectFix(f), { lat: pos.lat, lon: pos.lon, accuracy: 8, ...extra });
};
/** Avanza l'orologio finto facendo scattare i timer (tick da 1 s compreso). */
export const advance = (app, ms) => app.page.clock.runFor(ms);
export const jump = async (app, ms) => { await app.page.clock.fastForward(ms); await app.page.clock.runFor(1100); };

/** Pixel del canvas (in coordinate canvas) il cui colore è vicino a rgb; restituisce la x media normalizzata o null. */
export function canvasColorX(page, selector, rgb, tol = 28) {
  return page.evaluate(({ selector, rgb, tol }) => {
    const c = document.querySelector(selector);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    let n = 0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i + 3] > 200 && Math.abs(d[i] - rgb[0]) <= tol && Math.abs(d[i + 1] - rgb[1]) <= tol && Math.abs(d[i + 2] - rgb[2]) <= tol) { sum += x; n++; }
      }
    }
    return n > 20 ? { x: sum / n / c.width, n } : null;
  }, { selector, rgb, tol });
}
