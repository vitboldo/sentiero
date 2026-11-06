// Scenari GPS reale (mock), 6 (modifica), 7 (ricarica), 9 (stati vuoti / senza quote / senza permesso).
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import {
  BAD, FILES3, FILE_STRAIGHT, O, SHOTS, advance, canvasColorX, ck, ckNear, closeSheet, fmtKmT, gpxText, importFiles, injectAt, jump, near,
  nodeTracks, note, offset, openApp, panel, parseIt, samplePath, scenario, session, sleepRT, snap, tracksOf, txt, walk,
} from './harness.mjs';
import { parseGpx } from '../src/core/gpx.js';
import { effectivePoints } from '../src/core/route.js';
import { buildRoute, statsAt } from '../src/core/route.js';

/** Pixel rosa dell'anteprima di taglio (#ff00aa) sul canvas della mappa. */
const previewPixels = (p) => p.evaluate(() => {
  let n = 0;
  for (const c of document.querySelectorAll('#map canvas.leaflet-zoom-animated, #map .leaflet-overlay-pane canvas')) {
    if (!c.getContext) continue;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] > 120 && d[i + 2] < 230 && d[i + 3] > 150) n++;
  }
  return n;
});
const setRange = (p, which, value) => p.evaluate(({ which, value }) => {
  const inputs = document.querySelectorAll('.sheet input[type=range]');
  const el = inputs[which === 'start' ? 0 : 1];
  el.value = String(value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, { which, value });
const confirm = async (p) => { await p.click('.modal button:last-child'); await p.waitForSelector('.modal', { state: 'detached' }); };

export async function scenariosB() {
  // ------------------------------------------------------------------ 3g
  await scenario(32, 'GPS reale (mock geolocation): watchPosition collegato', 'webkit', async (use) => {
    const app = use(await openApp('webkit', { clock: false, geo: { latitude: O.lat, longitude: O.lon, accuracy: 8 }, perms: ['geolocation'] }));
    await app.boot();
    const p = app.page;
    await importFiles(app, FILES3);
    await closeSheet(p);
    const route = buildRoute(nodeTracks(FILES3));
    await p.waitForFunction(() => /^GPS ok/.test(document.getElementById('status-text').textContent), null, { timeout: 8000 });
    const s0 = await snap(p);
    ckNear('fix #1: lat dal mock', s0.gps.lat, O.lat, 1e-5);
    ckNear('fix #1: lon dal mock', s0.gps.lon, O.lon, 1e-5);
    ckNear('fix #1: accuratezza dal mock', s0.accuracy, 8, 1);
    ckNear('fix #1: sull\'inizio della traccia', s0.distAlong, 0, 15);
    ck('pillola con ± accuratezza', /^GPS ok ±\d+ m$/.test(await txt(p, '#status-text')), await txt(p, '#status-text'));
    ck('marker GPS sulla mappa', (await p.locator('.mk-gps').count()) === 1);
    const target = statsAt(route, 1500);
    await app.ctx.setGeolocation({ latitude: target.lat, longitude: target.lon, accuracy: 12 });
    await p.waitForFunction((lat) => Math.abs(window.__sentiero.snapshot().gps.lat - lat) < 1e-6, target.lat, { timeout: 8000 });
    const s1 = await snap(p);
    ckNear('fix #2: progresso sulla route', s1.distAlong, 1500, 25);
    ck('fix #2: accuratezza 12', near(s1.accuracy, 12, 1) && /GPS ok ±12 m/.test(await txt(p, '#status-text')), [s1.accuracy, await txt(p, '#status-text')]);
    ckNear('fix #2: pannello km mancanti', parseIt((await panel(p)).dist), (route.totalDist - 1500) / 1000, 0.1);
    // tocco su "Centra su di me": segue la posizione
    await p.click('#btn-locate');
    ck('seguo la posizione', (await p.getAttribute('#btn-locate', 'aria-pressed')) === 'true' && /Seguo/.test(await txt(p, '#btn-locate')));
    const v = await p.evaluate(() => window.__sentiero.view());
    ck('mappa centrata (zoom ≥ 15)', v.zoom >= 15, v);
    note('geolocation mock Playwright su WebKit');
  });

  // ------------------------------------------------------------------ 6
  await scenario(6, 'Modifica: rinomina, taglio con anteprima, waypoint, esporta, ripristina, unisci', 'webkit', async (use) => {
    // su Windows navigator.share può esistere: si prova il percorso download come su desktop
    const app = use(await openApp('webkit', { clock: false }));
    await app.boot();
    const p = app.page;
    await importFiles(app, FILES3);
    const nt = nodeTracks(FILES3);
    const orig = (await tracksOf(p))[0];
    ck('Alpha ha 2 waypoint', orig.wp === 2 && orig.n === nt[0].points.length, orig);
    ck('2 marker waypoint sulla mappa', (await p.locator('.mk-wp').count()) === 2);

    await p.locator('.track', { hasText: 'Alpha' }).getByRole('button', { name: 'Modifica', exact: true }).click();
    await p.waitForSelector('.sheet.half');
    ck('foglio Modifica traccia', (await txt(p, '.sheet-head h2')) === 'Modifica traccia');

    // rinomina
    await p.fill('input[aria-label=Nome]', 'Alpha Nord');
    await p.getByRole('button', { name: 'Rinomina' }).click();
    await p.waitForFunction(() => window.__sentiero.tracks()[0].name === 'Alpha Nord');
    ck('rinominata, original salvato', (await tracksOf(p))[0].hasOriginal === true);
    ck('il campo Nome mostra il nuovo nome', (await p.inputValue('input[aria-label=Nome]')) === 'Alpha Nord');

    // taglio con anteprima
    const n = orig.n;
    const basePink = await previewPixels(p);
    ck('nessuna anteprima prima del taglio (solo antialiasing residuo)', basePink < 30, basePink);
    const startIdx = 40;
    const endIdx = n - 1 - 35;
    await setRange(p, 'start', startIdx);
    await setRange(p, 'end', endIdx);
    await p.waitForTimeout(300);
    await p.evaluate(() => { document.querySelector('.sheet-body').scrollTop = 0; });
    await p.waitForTimeout(200);
    await p.screenshot({ path: `${SHOTS}\\05-edit-sheet.png`, scale: 'css' });
    const mini = buildRoute([{ ...nt[0], visible: true }]);
    const labels = await p.locator('.sheet .field span').allTextContents();
    const lab = labels.find((l) => l.startsWith('Inizio')) ?? '';
    const labE = labels.find((l) => l.startsWith('Fine')) ?? '';
    ck('etichetta inizio con km corretti', lab.includes(`km ${fmtKmT(mini.cumDist[startIdx])}`), lab);
    ck('etichetta fine con km corretti', labE.includes(`km ${fmtKmT(mini.cumDist[endIdx])}`), labE);
    const pink = await previewPixels(p);
    ck('anteprima sulla mappa (pixel rosa)', pink > basePink + 150, [pink, basePink]);
    ck('anteprima nel profilo di modifica (linee di taglio)', (await canvasColorX(p, '.edit-profile', [214, 0, 127], 30)) !== null);
    ck('Applica taglio abilitato', await p.getByRole('button', { name: 'Applica taglio' }).isEnabled());
    await p.getByRole('button', { name: 'Applica taglio' }).click();
    await p.waitForFunction((k) => window.__sentiero.tracks()[0].points.length === k, endIdx - startIdx + 1);
    const t1 = (await tracksOf(p))[0];
    ck('punti dopo il taglio', t1.n === endIdx - startIdx + 1, t1.n);
    ckNear('primo punto = punto originale', t1.first.lat, nt[0].points[startIdx].lat, 1e-9);
    ckNear('ultimo punto = punto originale', t1.last.lat, nt[0].points[endIdx].lat, 1e-9);
    await p.waitForTimeout(200);
    ck("anteprima rimossa dopo l applicazione", (await previewPixels(p)) < basePink + 30, await previewPixels(p));

    // waypoint
    const wpRow = p.locator('.wp-row').first();
    ck('elenco waypoint', (await p.locator('.wp-row').count()) === 2 && (await wpRow.textContent()).includes('Rifugio Uno'));
    await wpRow.getByRole('button', { name: 'Elimina' }).click();
    await p.waitForFunction(() => window.__sentiero.tracks()[0].waypoints.length === 1);
    ck('waypoint rimosso (1 resta: Passo Due)', (await p.locator('.wp-row').count()) === 1 && (await p.locator('.wp-row').first().textContent()).includes('Passo Due'));
    ck('marker waypoint sulla mappa: 1', (await p.locator('.mk-wp').count()) === 1);

    // esporta GPX e rileggi il file scaricato
    await closeSheet(p);
    await p.click('#btn-tracks');
    const dl = p.waitForEvent('download', { timeout: 8000 });
    await p.locator('.track', { hasText: 'Alpha Nord' }).getByRole('button', { name: 'Esporta GPX' }).click();
    const download = await dl;
    ck('nome file .gpx', /^Alpha_Nord\.gpx$/.test(download.suggestedFilename()), download.suggestedFilename());
    const file = await download.path();
    const xml = fs.readFileSync(file, 'utf8');
    const back = parseGpx(xml, DOMParser).tracks;
    ck('GPX riletto: una traccia con nome corretto', back.length === 1 && back[0].name === 'Alpha Nord', back.map((t) => t.name));
    ck('GPX riletto: stessi punti', back[0].points.length === t1.n, [back[0].points.length, t1.n]);
    const cur = effectivePoints({ ...nt[0], points: nt[0].points.slice(startIdx, endIdx + 1), reversed: false });
    const maxDiff = Math.max(...back[0].points.map((q, i) => Math.max(Math.abs(q.lat - cur[i].lat), Math.abs(q.lon - cur[i].lon), Math.abs((q.ele ?? 0) - (cur[i].ele ?? 0)) / 1e5)));
    ck('GPX riletto: coordinate e quote uguali (<2e-6)', maxDiff < 2e-6, maxDiff);
    ck('GPX riletto: waypoint rimasto', back[0].waypoints.length === 1 && back[0].waypoints[0].name === 'Passo Due', back[0].waypoints);
    ck('GPX 1.1 con namespace', /<gpx[^>]*version="1\.1"[^>]*xmlns="http:\/\/www\.topografix\.com\/GPX\/1\/1"/.test(xml));

    // ripristina originale
    await p.locator('.track', { hasText: 'Alpha Nord' }).getByRole('button', { name: 'Modifica', exact: true }).click();
    await p.getByRole('button', { name: 'Ripristina originale' }).click();
    await confirm(p);
    await p.waitForFunction(() => window.__sentiero.tracks()[0].name === 'Alpha');
    const t2 = (await tracksOf(p))[0];
    ck('ripristinata: nome, punti e waypoint originali', t2.name === 'Alpha' && t2.n === orig.n && t2.wp === 2 && !t2.hasOriginal, t2);
    ck('2 marker waypoint di nuovo', (await p.locator('.mk-wp').count()) === 2);

    // unisci con la successiva
    await p.getByRole('button', { name: /^Unisci con «Bravo»/ }).click();
    await confirm(p);
    await p.waitForFunction(() => window.__sentiero.tracks().length === 2);
    const ts = await tracksOf(p);
    ck('unita: 2 tracce, la prima contiene tutti i punti di A e B', ts.length === 2 && ts[0].n >= nt[0].points.length + nt[1].points.length - 1 && ts[0].n <= nt[0].points.length + nt[1].points.length, ts.map((t) => [t.name, t.n]));
    ck('unita: la seconda è Charlie', ts[1].name === 'Charlie');
    await p.waitForTimeout(200);
    await closeSheet(p).catch(() => {});
    const merged = buildRoute(nodeTracks(FILES3).slice(0, 2));
    const chk = await panel(p);
    ck('totali aggiornati dopo l\'unione (3 tracce: A+B uniti + C)', parseIt(chk.dist) > 8.0, chk);
  });

  // ------------------------------------------------------------------ 7
  await scenario(7, 'Ricarica: tracce, ordine, modalità, vista, tracker; chiusura durante la perdita GPS', 'webkit', async (use) => {
    const app = use(await openApp('webkit'));
    await app.boot();
    const p = app.page;
    await importFiles(app, FILES3);
    await p.locator('.track', { hasText: 'Alpha' }).getByRole('button', { name: 'Giù', exact: true }).click();
    await p.waitForFunction(() => window.__sentiero.tracks()[0].name === 'Bravo');
    await p.locator('.track', { hasText: 'Charlie' }).locator('input[type=checkbox]').uncheck();
    await p.waitForFunction(() => window.__sentiero.tracks()[2].visible === false);
    await p.locator('.track', { hasText: 'Charlie' }).locator('input[type=checkbox]').check();
    await p.waitForFunction(() => window.__sentiero.tracks()[2].visible === true);
    await p.locator('.track', { hasText: 'Charlie' }).locator('input[type=checkbox]').uncheck();
    await p.waitForFunction(() => window.__sentiero.tracks()[2].visible === false);
    await closeSheet(p);
    await p.click('#scope button[data-mode=tappa]');
    await p.click('.leaflet-control-zoom-in');
    await p.click('.leaflet-control-zoom-in');
    await advance(app, 1500);
    const view = await p.evaluate(() => window.__sentiero.view());
    const route = buildRoute(nodeTracks(FILES3).slice(0, 2).reverse().map((t) => t));   // Bravo, Alpha
    const route2 = buildRoute([nodeTracks(FILES3)[1], nodeTracks(FILES3)[0]]);
    await walk(app, route2, 0, 2200, { step: 30 });
    await advance(app, 11_000);   // il tick salva lo stato del tracker ogni 10 s
    const before = await snap(p);

    await p.reload();
    await p.waitForFunction(() => !!window.__sentiero);
    await p.waitForFunction(() => window.__sentiero.tracks().length === 3);
    ck('nessun avviso di benvenuto alla seconda apertura', (await p.locator('.modal').count()) === 0);
    const ts = await tracksOf(p);
    ck('tracce e ordine ripristinati', JSON.stringify(ts.map((t) => t.name)) === JSON.stringify(['Bravo', 'Alpha', 'Charlie']), ts.map((t) => t.name));
    ck('visibilità ripristinata', JSON.stringify(ts.map((t) => t.visible)) === JSON.stringify([true, true, false]), ts.map((t) => t.visible));
    ck('modalità Tappa ripristinata', (await p.getAttribute('#scope button[data-mode=tappa]', 'aria-pressed')) === 'true');
    const v2 = await p.evaluate(() => window.__sentiero.view());
    ck('vista mappa ripristinata', near(v2.lat, view.lat, 1e-4) && near(v2.lon, view.lon, 1e-4) && v2.zoom === view.zoom, [view, v2]);
    const after = await snap(p);
    ck('tracker ripristinato: stesso ultimo punto sicuro', after && near(after.lastSure.distAlong, before.lastSure.distAlong, 1) && after.lastSure.timestamp === before.lastSure.timestamp, [after?.lastSure, before.lastSure]);
    ck('tracker ripristinato: posizione sulla route', after && near(after.distAlong, before.distAlong, 5), [after?.distAlong, before.distAlong]);
    ck('pannello popolato dopo la ricarica', parseIt((await panel(p)).dist) > 0 && !(await p.locator('#live').isHidden()));
    ck('Tappa: didascalia col nome della traccia', /· (Bravo|Alpha)$/.test((await panel(p)).caption), (await panel(p)).caption);

    // un fix arrivato un istante prima della chiusura (tra due salvataggi da 10 s) si salva comunque su pagehide
    await injectAt(app, route2, 2300);
    const lastTs = (await snap(p)).lastSure.timestamp;
    await p.reload();
    await p.waitForFunction(() => !!window.__sentiero && window.__sentiero.tracks().length === 3);
    ck('chiusura subito dopo un fix: stato salvato su pagehide', (await snap(p))?.lastSure?.timestamp === lastTs, [(await snap(p))?.lastSure?.timestamp, lastTs]);

    // chiusura durante una perdita GPS: alla riapertura è ancora in stima
    await advance(app, 100_000);   // senza fix: lost
    const lostBefore = await snap(p);
    ck('prima di chiudere: stima attiva', lostBefore.quality === 'lost' && lostBefore.source === 'stima', lostBefore.quality);
    await advance(app, 12_000);   // salvataggio
    await p.goto('about:blank');
    await p.clock.fastForward(5 * 60_000);
    await p.goto(session.srv.origin + '/');
    await p.waitForFunction(() => !!window.__sentiero && window.__sentiero.tracks().length === 3);
    await advance(app, 1200);
    const lostAfter = await snap(p);
    ck('riaperta: ancora in stato di stima', lostAfter.quality === 'lost' && lostAfter.source === 'stima' && !!lostAfter.estimate, lostAfter.quality);
    ck('riaperta: la stima è avanzata del tempo di chiusura', lostAfter.estimate.distAlong > lostBefore.estimate.distAlong + 200, [lostBefore.estimate.distAlong, lostAfter.estimate.distAlong]);
    ck('riaperta: stesso ultimo punto sicuro', lostAfter.lastSure.timestamp === before.lastSure.timestamp || lostAfter.lastSure.timestamp === lostBefore.lastSure.timestamp);
    ck('riaperta: pillola "Stima: ultimo punto sicuro … fa"', /^Stima: ultimo punto sicuro \d+ min fa$/.test(await txt(p, '#status-text')), await txt(p, '#status-text'));
    ck('riaperta: marker ultimo sicuro e stima', (await p.locator('.mk-sure').count()) === 1 && (await p.locator('.mk-est').count()) === 1);
    ck('riaperta: numeri con ~', (await panel(p)).dist.startsWith('~'));
  });

  // ------------------------------------------------------------------ 9
  await scenario(9, 'Stati: nessuna traccia, nessuna quota, GPS negato / assente', 'webkit', async (use) => {
    // a) nessuna traccia, nessun permesso
    const app = use(await openApp('webkit', { clock: false, perms: [], welcome: false }));
    await app.boot();
    const p = app.page;
    await p.waitForSelector('.modal');
    const welcome = await p.locator('.modal').textContent();
    ck('avviso di benvenuto alla prima apertura: GPS sospeso a schermo bloccato, Blocco automatico, Aggiungi alla schermata Home',
      /Prima di partire/.test(welcome) && /sospende il GPS/.test(welcome) && /Blocco automatico su Mai/.test(welcome) && /Aggiungi alla schermata Home/.test(welcome), welcome);
    await p.click('.modal button');
    await p.waitForSelector('.modal', { state: 'detached' });
    // Il salvataggio è asincrono: si ricarica solo dopo averlo visto su IndexedDB.
    await p.waitForFunction(() => new Promise((resolve) => {
      const open = indexedDB.open('sentiero');
      open.onsuccess = () => {
        const get = open.result.transaction('meta').objectStore('meta').get('welcomed');
        get.onsuccess = () => { open.result.close(); resolve(get.result === true); };
      };
    }));
    await p.reload();
    await p.waitForFunction(() => !!window.__sentiero);
    await p.waitForTimeout(500);
    ck('avviso di benvenuto non ricompare alla seconda apertura', (await p.locator('.modal').count()) === 0);
    ck('pannello: messaggio chiaro per nessuna traccia', (await txt(p, '#empty-text')) === 'Nessuna traccia. Tocca Tracce per importare un file GPX.' && await p.locator('#empty').isVisible() && await p.locator('#live').isHidden());
    ck('pulsanti principali presenti e grandi (>= 48 px)', await p.evaluate(() => ['btn-locate', 'btn-tracks', 'btn-offline'].every((id) => document.getElementById(id).getBoundingClientRect().height >= 48)));
    await p.click('#btn-locate');
    ck('"Centra su di me" senza posizione: avviso chiaro', /Posizione GPS non ancora disponibile|negat/.test(await txt(p, '#toast')), await txt(p, '#toast'));
    await p.click('#btn-offline');
    ck('Mappe offline senza tracce: spiegazione e Scarica disabilitato', (await txt(p, '.estimate')).includes('Nessuna traccia visibile') && await p.getByRole('button', { name: 'Scarica' }).isDisabled());
    await closeSheet(p);
    await p.click('#btn-tracks');
    ck('foglio Tracce vuoto: invito all\'import, inversione disabilitata', (await txt(p, '.sheet .hint')).includes('Nessuna traccia') && await p.getByRole('button', { name: 'Inverti tutto il percorso' }).isDisabled());
    // un fix senza traccia non deve rompere nulla
    await closeSheet(p);
    await p.evaluate(() => window.__sentiero.injectFix({ lat: 46.0, lon: 11.0, accuracy: 9 }));
    ck('fix senza tracce: pillola verde e marker GPS', /^GPS ok ±9 m$/.test(await txt(p, '#status-text')) && (await p.locator('.mk-gps').count()) === 1);
    await p.screenshot({ path: `${SHOTS}\\_tmp-empty.png`, scale: 'css' });

    // b) traccia senza quote
    const flat = samplePath(O, [[0, 0], [0, 1200], [500, 1800]], null);
    await importFiles(app, [{ name: 'senza-quote.gpx', text: gpxText({ name: 'Senza quote', points: flat }) }]);
    await closeSheet(p);
    const fr = buildRoute(nodeTracks([{ name: 'x', text: gpxText({ name: 'Senza quote', points: flat }) }]));
    ck('senza quote: etichetta "Quote non disponibili"', await p.locator('#noele').isVisible() && (await txt(p, '#noele')) === 'Quote non disponibili');
    ck('senza quote: D+ e D- nascosti, km e tempo visibili', await p.locator('.stat-up').isHidden() && await p.locator('.stat-down').isHidden() && (await panel(p)).dist === fmtKmT(fr.totalDist) && /min|h/.test((await panel(p)).time), await panel(p));
    ck('senza quote: pannello non mostra NaN/undefined', !/NaN|undefined|Infinity/.test(await p.locator('#panel').textContent()));
    const box = await p.locator('#profile').boundingBox();
    await p.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
    await p.mouse.down();
    const scrubT = await txt(p, '#scrub');
    const crossDuring = await p.locator('.mk-cross').count();
    await p.mouse.up();
    await p.waitForTimeout(100);
    ck('senza quote: mirino sulla mappa durante lo scrub, rimosso dopo', crossDuring === 1 && (await p.locator('.mk-cross').count()) === 0 && await p.locator('#scrub').isHidden(), crossDuring);
    ck('senza quote: scrub mostra km e mancano (niente D+)', /^km [\d,]+ · mancano [\d,]+ km$/.test(scrubT), scrubT);

    // c) GPS: permesso negato (WebKit senza permesso concesso) e API assente
    await p.click('#status');
    await sleepRT(800);
    note(`senza permesso, pillola: «${await txt(p, '#status-text')}»`);

    const noGeo = await openApp('webkit', { clock: false, perms: [], init: 'Object.defineProperty(Navigator.prototype, "geolocation", { get() { return undefined; } });' });
    await noGeo.boot();
    ck('API geolocalizzazione assente: pillola chiara', (await txt(noGeo.page, '#status-text')) === 'GPS non disponibile su questo dispositivo', await txt(noGeo.page, '#status-text'));
    await noGeo.page.click('#status');
    await noGeo.page.click('#btn-locate');
    ck('API assente: nessun errore dopo i tocchi', noGeo.errors.length === 0, noGeo.errors);
    await noGeo.close();
    await p.click('#btn-tracks');
    await p.locator('.track').first().locator('input[type=checkbox]').uncheck();
    await closeSheet(p);
    ck('tutte le tracce nascoste: invito ad attivarne una', (await txt(p, '#empty-text')) === 'Nessuna traccia visibile. Attivane una da Tracce.', await txt(p, '#empty-text'));
  });

  // ------------------------------------------------------------------ 12
  await scenario(12, 'Wake Lock e riavvio di watchPosition al ritorno in primo piano', 'webkit', async (use) => {
    const init = `(() => {
      window.__wl = []; window.__wp = 0;
      if (navigator.wakeLock) {
        const proto = Object.getPrototypeOf(navigator.wakeLock);
        const orig = proto.request;
        proto.request = function (type) { window.__wl.push(type); return orig.call(this, type); };
      }
      const g = navigator.geolocation; const w = g.watchPosition.bind(g);
      g.watchPosition = (...a) => { window.__wp++; return w(...a); };
    })();`;
    const app = use(await openApp('webkit', { clock: false, init }));
    await app.boot();
    const p = app.page;
    const hasApi = await p.evaluate(() => 'wakeLock' in navigator);
    ck('WebKit espone Screen Wake Lock', hasApi);
    await p.waitForFunction(() => window.__wl.length >= 1, null, { timeout: 5000 });
    ck('wake lock richiesto di tipo screen all avvio', (await p.evaluate(() => window.__wl))[0] === 'screen');
    ck('watchPosition avviato', (await p.evaluate(() => window.__wp)) >= 1);
    const before = await p.evaluate(() => ({ wp: window.__wp, wl: window.__wl.length }));
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await p.waitForTimeout(300);
    const after = await p.evaluate(() => ({ wp: window.__wp, wl: window.__wl.length }));
    ck('ritorno in primo piano: watchPosition riavviato', after.wp === before.wp + 1, [before, after]);
    ck('ritorno in primo piano: wake lock richiesto di nuovo se rilasciato', after.wl >= before.wl);

    const noWl = use(await openApp('webkit', { clock: false, init: 'delete Navigator.prototype.wakeLock;' }));
    await noWl.boot();
    await noWl.page.waitForFunction(() => document.getElementById('toast').classList.contains('show'), null, { timeout: 5000 });
    const t = await noWl.page.evaluate(() => ({ text: document.getElementById('toast').textContent, error: document.getElementById('toast').classList.contains('error') }));
    ck('senza Wake Lock: indicazione di impostare il Blocco automatico su Mai', t.error && /Blocco automatico su Mai/.test(t.text) && /non disponibile/.test(t.text), t);
    await noWl.close();
  });
}
