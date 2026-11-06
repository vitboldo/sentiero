// Scenario 8 (offline) in tre varianti e scenario 10 (50.000 punti).
import fs from 'node:fs';
import {
  PNG, SHOTS, snap, ck, closeSheet, gpxText, importFiles, nodeTracks, note, openApp, samplePath, scenario, session, startStatic, O, offset, parseIt,
} from './harness.mjs';
import { effectivePoints } from '../src/core/route.js';
import { tilesForCorridor, tileUrl } from '../src/core/tiles.js';

const SHORT = samplePath(O, [[0, 0], [0, 600], [300, 1000]], (d) => 1800 + d / 10);
const SHORT_FILE = { name: 'breve.gpx', text: gpxText({ name: 'Breve', points: SHORT }) };
const SHORT_TILES = (maxZoom, bufferM) => tilesForCorridor(effectivePoints({ points: nodeTracks([SHORT_FILE])[0].points, reversed: false }), { minZoom: 10, maxZoom, bufferM });

const openOffline = async (p) => {
  if (!(await p.locator('.sheet').count())) await p.click('#btn-offline');
  await p.waitForSelector('.sheet .estimate');
};
const selectPlan = async (p, preset, buffer, name) => {
  await p.locator('.sheet select').nth(0).selectOption(preset);
  await p.locator('.sheet select').nth(1).selectOption(String(buffer));
  if (name) await p.locator('.sheet input[type=text]').fill(name);
  await p.waitForFunction(() => /tile · circa/.test(document.querySelector('.sheet .estimate').textContent), null, { timeout: 5000 });
  await p.waitForTimeout(400);
  return p.evaluate(() => {
    const m = /^(\d+) tile · circa ([\d,]+) MB$/.exec(document.querySelector('.sheet .estimate').textContent);
    return m && { count: Number(m[1]), mb: m[2] };
  });
};
const download = async (p) => {
  await p.getByRole('button', { name: 'Scarica' }).click();
  await p.waitForFunction(() => /Download completato|non riuscite|annullato|interrotto/.test(document.querySelector('.sheet')?.textContent ?? ''), null, { timeout: 60000 });
  await p.waitForFunction(() => document.querySelectorAll('.pkg').length > 0);
  return p.evaluate(() => document.querySelector('.sheet').textContent);
};
const cacheKeys = (p, name) => p.evaluate(async (n) => (await (await caches.open(n)).keys()).map((r) => r.url), name);
const pkgRows = (p) => p.locator('.pkg').evaluateAll((els) => els.map((e) => ({ name: e.querySelector('strong').textContent, meta: e.querySelector('.meta').textContent })));
const deletePkg = async (p, name) => {
  await p.locator('.pkg', { hasText: name }).getByRole('button', { name: 'Elimina' }).click();
  await p.click('.modal button:last-child');
  await p.waitForSelector('.modal', { state: 'detached' });
  await p.waitForTimeout(500);
};

/** Stato di dipintura delle tile visibili: nessuna deve essere vuota. */
const tilePaint = (p) => p.evaluate(() => {
  const canvases = [...document.querySelectorAll('#map .leaflet-tile-pane canvas')];
  const vis = canvases.filter((c) => {
    const r = c.getBoundingClientRect();
    return r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight;
  });
  const info = vis.map((c) => {
    const g = c.getContext('2d');
    const px = [[100, 200], [200, 100], [30, 230], [128, 128]].map(([x, y]) => g.getImageData(x, y, 1, 1).data);
    return { opaque: px.every((d) => d[3] === 255), color: [...px[0]] };
  });
  return { n: vis.length, blank: info.filter((i) => !i.opaque).length, colors: [...new Set(info.map((i) => i.color.join(',')))] };
});

const sameOrigin = (url) => url.startsWith(session.srv.origin);
const mbFmt = (n) => new Intl.NumberFormat('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n / 1048576);

/** Import + due pacchetti (Bassa e Media) con download dalla UI. */
async function downloadFlow(app, p) {
  await importFiles(app, [SHORT_FILE]);
  await closeSheet(p);
  await openOffline(p);
  const exp1 = SHORT_TILES(13, 500);
  const plan1 = await selectPlan(p, 'bassa', 500, '');
  ck('stima tile = core', plan1?.count === exp1.length, [plan1, exp1.length]);
  ck('stima MB = tile x 40 KB', plan1?.mb === mbFmt(exp1.length * 40 * 1024), plan1);
  const t0 = Date.now();
  app.tileTimes.length = 0;
  const res1 = await download(p);
  ck('download completato con il conteggio giusto', res1.includes(`Download completato: ${exp1.length} tile.`), res1.slice(0, 300));
  const rows1 = await pkgRows(p);
  ck('lista pacchetti: numero tile e MB reali', rows1.length === 1 && rows1[0].name === 'Breve' && rows1[0].meta.startsWith(`${exp1.length} tile · ${mbFmt(exp1.length * PNG.length)}`), rows1);
  const keys1 = await cacheKeys(p, 'tiles-offline-v1');
  ck('Cache tiles-offline-v1: tutte e sole le tile del piano', keys1.length === exp1.length && exp1.every((t) => keys1.includes(tileUrl(t))), [keys1.length, exp1.length]);
  ck('"Spazio usato" mostrato', /^Spazio usato: [\d.,]+ MB di [\d.,]+ MB/.test(await p.locator('.sheet .hint').filter({ hasText: 'Spazio usato' }).textContent()));
  const times = app.tileTimes.map((r) => r.t).sort((a, b) => a - b);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  ck('cortesia: almeno 150 ms tra un avvio e l\'altro (mediana >= 140 ms)', gaps.length > 3 && [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] >= 140, gaps.slice(0, 10));
  ck('cortesia: durata >= ~150 ms a tile', times.length > 1 && times.at(-1) - times[0] >= (exp1.length - 1) * 140 - 200, times.at(-1) - times[0]);
  ck('download da un solo host (a.tile)', app.tileTimes.every((r) => r.url.startsWith('https://a.tile.opentopomap.org/')));
  note(`${exp1.length} tile in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await p.screenshot({ path: `${SHOTS}\\06-offline-sheet.png`, scale: 'css' });

  const exp2 = SHORT_TILES(14, 500);
  const plan2 = await selectPlan(p, 'media', 500, 'Breve media');
  ck('stima pacchetto 2 = core', plan2?.count === exp2.length && exp2.length > exp1.length, [plan2, exp2.length]);
  await download(p);
  const keys2 = await cacheKeys(p, 'tiles-offline-v1');
  ck('cache = unione dei due pacchetti', keys2.length === exp2.length, [keys2.length, exp2.length]);
  ck('2 pacchetti in lista', (await pkgRows(p)).length === 2);
  if (app.swOn) {
    const rt = await cacheKeys(p, 'tiles-runtime-v1');
    const dlSet = new Set(exp1.map(tileUrl)); // z10-13: la mappa mostra z14, quindi quelle non sono state viste
    ck('il download non duplica le tile nella cache runtime', rt.filter((u) => dlSet.has(u)).length === 0, rt.filter((u) => dlSet.has(u)));
  }
  return { exp1, exp2 };
}

async function deleteFlow(p, exp1) {
  await openOffline(p);
  await p.waitForSelector('.pkg');
  await deletePkg(p, 'Breve media');
  const afterMedia = await cacheKeys(p, 'tiles-offline-v1');
  ck('eliminato Media: restano le tile condivise con Bassa (e solo quelle)', afterMedia.length === exp1.length && exp1.every((t) => afterMedia.includes(tileUrl(t))), [afterMedia.length, exp1.length]);
  ck('una sola riga in lista', (await pkgRows(p)).length === 1 && (await pkgRows(p))[0].name === 'Breve');
  await deletePkg(p, 'Breve');
  ck('eliminato l\'ultimo pacchetto: cache vuota', (await cacheKeys(p, 'tiles-offline-v1')).length === 0);
  ck('lista vuota con messaggio', (await p.locator('.sheet').textContent()).includes('Nessun pacchetto scaricato.'));
}

/** SW, precache, avvio offline con server spento, tile dalla cache, ripiego antenato. */
async function serveFlow(app, p, { exp1, exp2 }) {
  ck('service worker attivo', await p.evaluate(async () => (await navigator.serviceWorker.ready).active?.state === 'activated'));
  await p.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 8000 }).catch(() => {});
  ck('il SW controlla la pagina', await p.evaluate(() => !!navigator.serviceWorker.controller));
  ck('nessun falso "Aggiornamento disponibile" alla prima installazione', (await p.locator('.modal').count()) === 0);

  // precache vs rete: tutto ciò che la pagina ha caricato deve essere nella cache della shell
  for (const sel of ['#btn-tracks', '#btn-offline']) {
    await p.click(sel);
    await p.waitForTimeout(150);
    await p.click('.sheet-head button');
  }
  await p.click('#btn-tracks');
  await p.locator('.track').first().getByRole('button', { name: 'Modifica', exact: true }).click();
  await p.waitForTimeout(200);
  await p.click('.sheet-head button');
  const shellKeys = await p.evaluate(async () => {
    const out = [];
    for (const k of await caches.keys()) if (k.startsWith('sentiero-shell-')) out.push(...(await (await caches.open(k)).keys()).map((r) => r.url));
    return out;
  });
  const norm = (u) => new URL(u).pathname.replace(/\/$/, '/index.html');
  const cachedPaths = new Set(shellKeys.map(norm));
  const loaded = [...new Set(app.reqs.filter(sameOrigin).map(norm))].filter((u) => u !== '/sw.js');
  const missing = loaded.filter((u) => !cachedPaths.has(u));
  ck('ogni file caricato dall\'app è nella precache del SW', missing.length === 0, { missing, loaded });
  const must = ['/index.html', '/styles.css', '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css',
    ...['main', 'store', 'map', 'profile', 'ui', 'offline'].map((m) => `/src/app/${m}.js`),
    ...['gpx', 'geo', 'route', 'edit', 'matcher', 'tracker', 'tiles'].map((m) => `/src/core/${m}.js`)];
  ck('la precache include moduli ES, CSS, Leaflet e index', must.every((f) => cachedPaths.has(f)), must.filter((f) => !cachedPaths.has(f)));
  const swSrc = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const listed = [...swSrc.matchAll(/'([^']+\.(?:js|css|html|png|webmanifest))'/g)].map((m) => m[1]);
  note(`precache: ${cachedPaths.size} file; caricati dall'app: ${loaded.length}; non caricati in questa sessione: ${listed.filter((f) => !loaded.includes(`/${f}`) && f !== 'index.html').join(', ') || 'nessuno'}`);

  // offline: server spento + rete del contesto spenta + tile non raggiungibili
  const port = session.srv.port;
  await session.srv.close();
  await app.ctx.setOffline(true);
  app.tileFail = true;
  app.failed.length = 0;
  // Un 504 su una tile mancante è voluto (così Leaflet usa l'antenata); il browser lo registra come "errore di caricamento risorsa".
  app.expectedErrors.push(/Failed to load resource.*(504|Tile non disponibile)/i);
  await p.evaluate(() => caches.delete('tiles-runtime-v1'));
  await p.reload();
  await p.waitForFunction(() => !!window.__sentiero, null, { timeout: 10000 });
  ck('offline: l\'app si avvia (ricarica con server spento)', await p.evaluate(() => document.title === 'Sentiero'));
  ck('offline: il SW controlla ancora la pagina', await p.evaluate(() => !!navigator.serviceWorker.controller));
  await p.waitForFunction(() => window.__sentiero.tracks().length === 1);
  ck('offline: tracce presenti', (await p.evaluate(() => window.__sentiero.tracks().map((t) => t.name))).join() === 'Breve');
  ck('offline: pannello popolato', parseIt(await p.locator('#st-dist').textContent()) > 0);
  const failedShell = app.failed.filter((f) => f.startsWith(session.srv.origin) && !f.includes('/sw.js'));
  ck('offline: nessuna richiesta fallita della shell', failedShell.length === 0, failedShell);

  const mid = nodeTracks([SHORT_FILE])[0].points[Math.floor(SHORT.length / 2)];
  const paintAt = async (zoom) => {
    await p.evaluate((v) => window.__sentiero.setView(v), { lat: mid.lat, lon: mid.lon, zoom });
    await p.waitForTimeout(2000);
    return tilePaint(p);
  };
  app.tileAborted.length = 0;
  const z13 = await paintAt(13);
  ck('z13 (scaricato) offline: tile dipinte dalla cache', z13.n >= 2 && z13.blank === 0 && z13.colors.includes('120,180,120,255'), z13);
  const downloaded = new Set([...exp1, ...exp2].map(tileUrl));
  const asked = app.tileAborted.filter((u) => downloaded.has(u));
  ck('z13 offline: nessuna tile scaricata è stata chiesta alla rete', asked.length === 0, asked.slice(0, 3));
  const z14 = await paintAt(14);
  ck('z14 (pacchetto Media) offline: dipinte dalla cache', z14.n >= 2 && z14.blank === 0 && z14.colors.includes('120,180,120,255'), z14);
  app.tileAborted.length = 0;
  const z16 = await paintAt(16);
  ck('z16 (oltre lo scaricato): ripiego sulla tile antenata, nessuna tile vuota', z16.n >= 4 && z16.blank === 0, z16);
  if (app.engine === 'chromium') ck('z16: le tile z16 mancano davvero (richieste e fallite, poi ripiego)', app.tileAborted.some((u) => u.includes('/16/')), app.tileAborted.slice(0, 3));
  const z17 = await paintAt(17);
  ck('z17: ripiego anche 3 livelli sopra (z14)', z17.n >= 4 && z17.blank === 0, z17);
  const att = await p.evaluate(() => {
    const a = document.querySelector('.leaflet-control-attribution');
    const r = a.getBoundingClientRect();
    return { text: a.textContent, bottom: r.bottom, panelTop: document.getElementById('panel').getBoundingClientRect().top, left: r.left, right: r.right, w: innerWidth };
  });
  ck('attribuzione completa, visibile e non coperta dal pannello', /Kartendaten: © OpenStreetMap-Mitwirkende, SRTM \| Kartendarstellung: © OpenTopoMap \(CC-BY-SA\)/.test(att.text) && att.bottom <= att.panelTop + 1 && att.left >= 0 && att.right <= att.w + 1, att);
  note(`errori 504 attesi per tile mancanti offline: ${app.expectedSeen}`);
  app.tileFail = false;
  app.expectedErrors.length = 0;
  await app.ctx.setOffline(false);
  await startStatic(port);
}

/** WebKit: le fetch del SW non passano da context.route, quindi le tile si mettono in cache direttamente. */
async function seedCache(p, tiles) {
  await p.evaluate(async ({ urls, b64 }) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const cache = await caches.open('tiles-offline-v1');
    for (const u of urls) await cache.put(u, new Response(new Blob([bin], { type: 'image/png' }), { status: 200, headers: { 'Content-Type': 'image/png' } }));
  }, { urls: tiles.map(tileUrl), b64: PNG.toString('base64') });
}

export async function scenariosC() {
  await scenario(8, 'Download pacchetti (UI), cache, eliminazione con tile condivise [senza SW]', 'webkit', async (use) => {
    const app = use(await openApp('webkit', { clock: false }));
    await app.boot();
    const p = app.page;
    const { exp1 } = await downloadFlow(app, p);
    await deleteFlow(p, exp1);
  });

  await scenario(81, 'SW + precache + offline + ripiego antenato [tile messe in cache a mano]', 'webkit', async (use) => {
    const app = use(await openApp('webkit', { clock: false, sw: true }));
    // Con SW attivo le tile non in cache passano dalla rete del SW (bloccata): 504 e ripiego, voluti.
    app.expectedErrors.push(/Failed to load resource.*(504|Tile non disponibile)/i);
    await app.boot();
    const p = app.page;
    await importFiles(app, [SHORT_FILE]);
    await closeSheet(p);
    const exp1 = SHORT_TILES(13, 500);
    const exp2 = SHORT_TILES(14, 500);
    await seedCache(p, exp2);
    await serveFlow(app, p, { exp1, exp2 });
    note('tile messe in Cache con cache.put: in WebKit le fetch del SW non passano da context.route');
  });

  await scenario(82, 'Flusso offline completo con SW attivo (download, precache, offline, ripiego, eliminazione)', 'chromium', async (use) => {
    const app = use(await openApp('chromium', { clock: false, sw: true }));
    app.swOn = true;
    await app.boot();
    const p = app.page;
    const flows = await downloadFlow(app, p);
    await p.click('.sheet-head button');
    await serveFlow(app, p, flows);
    await p.reload();
    await p.waitForFunction(() => !!window.__sentiero && window.__sentiero.tracks().length === 1);
    await deleteFlow(p, flows.exp1);
  });
}

// ---------------------------------------------------------------- scenario 10: 50.000 punti
function bigRoute() {
  const lanes = 12;
  const laneLen = 5000;
  const verts = [];
  for (let i = 0; i < lanes; i++) {
    const x = i * 150;
    verts.push(i % 2 === 0 ? [[x, 0], [x, laneLen]] : [[x, laneLen], [x, 0]]);
  }
  const flat = verts.flatMap((v, i) => (i === 0 ? v : v)).filter((_, i, a) => true);
  const pts = [];
  let distBase = 0;
  const total = lanes * laneLen + (lanes - 1) * 150;
  const step = total / 49_999;
  const path = [];
  for (const v of verts) path.push(...v);
  return { path, step, total };
}

async function perfScenario(engine, id, { cpu = 1 } = {}) {
  await scenario(id, `50.000 punti: import, tick, pan${cpu > 1 ? ` (CPU x${cpu})` : ''}`, engine, async (use) => {
    const app = use(await openApp(engine, { clock: true }));
    const { path, step } = bigRoute();
    const raw = samplePath(O, path, (d) => 1500 + 400 * Math.sin(d / 3000) + 60 * Math.sin(d / 170), step);
    // rumore GPS di ~±1 m, deterministico, come in una traccia reale a 1 punto/s
    const points = raw.map((q, i) => ({ ...q, ...offset(q.lat, q.lon, Math.sin(i * 12.9898) * 1.2, Math.cos(i * 78.233) * 1.2) }));
    note(`punti generati: ${points.length}`);
    const text = gpxText({ name: 'Grande', points });
    await app.boot();
    const p = app.page;
    let cdp = null;
    if (cpu > 1 && engine === 'chromium') {
      cdp = await app.ctx.newCDPSession(p);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    }
    await p.evaluate(() => {
      window.__frames = [];
      let last = performance.now();
      const loop = (t) => { window.__frames.push(t - last); last = t; requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    });
    const worstFrame = () => p.evaluate(() => { const f = window.__frames.splice(0); f.shift(); return { max: Math.max(0, ...f), over100: f.filter((x) => x > 100).length, n: f.length }; });

    // import
    await p.click('#btn-tracks');
    const t0 = Date.now();
    await p.setInputFiles('#file-input', [{ name: 'grande.gpx', mimeType: 'application/octet-stream', buffer: Buffer.from(text) }]);
    await p.waitForFunction(() => window.__sentiero.tracks().length === 1 && document.getElementById('st-dist').textContent !== '–', null, { timeout: 60000 });
    const importMs = Date.now() - t0;
    const fr = await worstFrame();
    await closeSheet(p);
    await p.waitForTimeout(500);
    note(`import ${importMs} ms (blocco massimo del main thread durante l'import ${Math.round(fr.max)} ms)`);
    ck('~50.000 punti importati (il rumore GPS elimina solo i doppioni consecutivi)', (await p.evaluate(() => window.__sentiero.tracks()[0].points.length)) >= 49_000);
    const budgetImport = 6000 * cpu;
    ck(`import < ${budgetImport} ms`, importMs < budgetImport, importMs);

    // tick: injectFix = tracker + render (pannello, mappa, profilo) lungo tutta la route
    const route = buildRouteOf(points);
    const total = route.totalDist;
    const timings = [];
    let worstErr = 0;
    for (const frac of [0.02, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 0.97]) {
      await p.clock.fastForward(3 * 3600_000);   // tempo trascorso: il salto è plausibile
      for (let k = 0; k < 20; k++) {
        const d = frac * total + k * 3;
        const c = statsAtRoute(route, d);
        await p.clock.fastForward(2000);
        timings.push(await p.evaluate((f) => { const t = performance.now(); window.__sentiero.injectFix(f); return performance.now() - t; }, { lat: c.lat, lon: c.lon, accuracy: 8 }));
        if (k === 19) {
          const s = await snap(p);
          worstErr = Math.max(worstErr, Math.abs(s.distAlong - d));
          ck(`frazione ${frac}: il tracker segue la route (errore ${s.distAlong - d | 0} m, qualità ${s.quality})`, Math.abs(s.distAlong - d) < 60 && s.quality === 'good', [s.distAlong, d, s.quality]);
        }
      }
    }
    const sorted = [...timings].sort((a, b) => a - b);
    const mean = timings.reduce((a, b) => a + b, 0) / timings.length;
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const late = timings.slice(-40);
    note(`tick: media ${mean.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${sorted.at(-1).toFixed(1)} ms; ultimi 40 (fine route) media ${(late.reduce((a, b) => a + b, 0) / 40).toFixed(1)} ms`);
    ck(`tick p95 < ${25 * cpu} ms`, p95 < 25 * cpu, p95);
    ck(`tick max < ${60 * cpu} ms`, sorted.at(-1) < 60 * cpu, sorted.at(-1));
    const matchMs = await p.evaluate(() => { const t = performance.now(); for (let i = 0; i < 20; i++) window.__sentiero.snapshot(); return (performance.now() - t) / 20; });
    note(`snapshot() ${matchMs.toFixed(2)} ms`);

    // pan e zoom
    await worstFrame();
    const box = await p.locator('#map').boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + 150;
    await p.mouse.move(cx, cy);
    await p.mouse.down();
    for (let i = 1; i <= 25; i++) await p.mouse.move(cx - i * 6, cy + i * 3);
    await p.mouse.up();
    await p.waitForTimeout(800);
    const pan = await worstFrame();
    note(`pan: frame più lungo ${Math.round(pan.max)} ms, frame > 100 ms: ${pan.over100}`);
    ck(`pan: nessun blocco > ${150 * cpu} ms`, pan.max < 150 * cpu, pan);
    await p.click('.leaflet-control-zoom-in');
    await p.waitForTimeout(1200);
    const zoom = await worstFrame();
    note(`zoom: frame più lungo ${Math.round(zoom.max)} ms`);
    ck(`zoom: nessun blocco > ${200 * cpu} ms`, zoom.max < 200 * cpu, zoom);
    if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  });
}

import { buildRoute } from '../src/core/route.js';
import { statsAt as statsAtRoute } from '../src/core/route.js';
function buildRouteOf(points) {
  return buildRoute([{ id: 'g', name: 'g', points, waypoints: [], visible: true, reversed: false }]);
}

export async function scenariosPerf() {
  await perfScenario('webkit', 10);
  await perfScenario('chromium', 10, { cpu: 4 });
}
