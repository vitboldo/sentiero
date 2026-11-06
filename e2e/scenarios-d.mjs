// Scenari 40-48: rotazione della mappa e navigazione con bussola simulata (pacchetto D).
// La bussola è uno script iniziale: permesso iOS (esito in window.__perm) ed eventi deviceorientation
// con webkitCompassHeading / webkitCompassAccuracy letti da window.__h / __acc. WebKit in verticale riporta
// screen.orientation.angle = 90: lo script lo forza a window.__ang (default 0).
import { FILES3, ck, closeSheet, importFiles, nodeTracks, note, offset, openApp, scenario, SHOTS, txt } from './harness.mjs';
import { buildRoute } from '../src/core/route.js';
import { haversineM } from '../src/core/geo.js';

const route = buildRoute(nodeTracks(FILES3));
const at = (q) => ({ lat: q.lat, lon: q.lon });
const start = route.points[0];

/** Script iniziale della bussola simulata. */
export function compassInit({ perm = 'granted', events = true, api = true } = {}) {
  return `
    window.__perm = ${JSON.stringify(perm)}; window.__permCalls = []; window.__h = 90; window.__acc = 5; window.__send = ${events};
    window.__ang = 0;
    try { Object.defineProperty(Object.getPrototypeOf(screen.orientation), 'angle', { get: () => window.__ang, configurable: true }); } catch (e) { window.__angErr = String(e); }
    window.__raf = 0; window.__animRaf = 0; const _raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (f) => { if (f.name === 'compassLoop') window.__raf++; if (f.name === 'mapAnimFrame') window.__animRaf++; return _raf(f); };
    // campiona fn() a ogni fotogramma per ms millisecondi (il primo campione è subito)
    window.__rec = (fn, ms) => new Promise((resolve) => { const out = []; const t0 = performance.now(); const loop = () => { out.push(fn()); if (performance.now() - t0 < ms) requestAnimationFrame(loop); else resolve(out); }; loop(); });
    window.__gpsRel = () => { const m = document.getElementById('map').getBoundingClientRect(); const r = document.querySelector('.mk-gps').getBoundingClientRect(); return { x: r.x + r.width / 2 - m.x, y: r.y + r.height / 2 - m.y }; };
    window.__doAdd = 0; window.__doRem = 0;
    const _add = window.addEventListener.bind(window), _rem = window.removeEventListener.bind(window);
    window.addEventListener = (t, ...r) => { if (t === 'deviceorientation') window.__doAdd++; return _add(t, ...r); };
    window.removeEventListener = (t, ...r) => { if (t === 'deviceorientation') window.__doRem++; return _rem(t, ...r); };
    window.__vis = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => window.__vis });
    ${api
      ? `DeviceOrientationEvent.requestPermission = () => { window.__permCalls.push(new Error().stack); return Promise.resolve(window.__perm); };`
      : 'delete DeviceOrientationEvent.requestPermission;'}
    setInterval(() => {
      if (!window.__send || window.__vis !== 'visible') return;
      const e = new Event('deviceorientation'); e.webkitCompassHeading = window.__h; e.webkitCompassAccuracy = window.__acc;
      window.dispatchEvent(e);
    }, 50);
  `;
}

const openCompass = async (o = {}, engine = 'webkit') => {
  const app = await openApp(engine, { clock: false, init: compassInit(o) });
  await app.boot();
  if (o.tracks !== false) {
    await importFiles(app, FILES3);
    await closeSheet(app.page);
  }
  return app;
};

// ---------------------------------------------------------------- helper
const W = (p, ms) => p.waitForTimeout(ms);
/** Differenza angolare con segno in (-180, 180]. */
const angDiff = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;
const ckAng = (desc, got, exp, tol) => ck(`${desc} (atteso ${+(((exp % 360) + 360) % 360).toFixed(1)} ±${tol})`, Number.isFinite(got) && Math.abs(angDiff(exp, got)) <= tol, got);
const st = (p) => p.evaluate(() => {
  const b = document.getElementById('btn-locate');
  return { mode: window.__sentiero.viewMode(), bearing: window.__sentiero.bearing(), label: b.textContent, pressed: b.getAttribute('aria-pressed'), dvm: b.dataset.viewMode };
});
const setHeading = (p, h) => p.evaluate((h) => { window.__h = h; }, h);
const inject = (p, f) => p.evaluate((f) => window.__sentiero.injectFix(f), { accuracy: 8, ...f });
const toast = (p) => p.evaluate(() => { const t = document.getElementById('toast'); return t.classList.contains('show') ? t.textContent : ''; });
const clearToast = (p) => p.evaluate(() => document.getElementById('toast').classList.remove('show'));
const tap = (p, ms = 400) => p.click('#btn-locate').then(() => W(p, ms));
/** Variazione del contatore rAF del ciclo bussola in `ms`. */
const rafDelta = async (p, ms) => {
  const a = await p.evaluate(() => window.__raf);
  await W(p, ms);
  return (await p.evaluate(() => window.__raf)) - a;
};
/** Posizione del pallino GPS rispetto alla mappa, e dimensioni (area visibile = mappa meno pannello). */
const gpsXY = (p) => p.evaluate(() => {
  const m = document.getElementById('map').getBoundingClientRect();
  const r = document.querySelector('.mk-gps').getBoundingClientRect();
  return { x: r.x + r.width / 2 - m.x, y: r.y + r.height / 2 - m.y, w: m.width, h: m.height, panel: document.getElementById('panel').offsetHeight };
});
const gpsPage = (p) => p.evaluate(() => { const r = document.querySelector('.mk-gps').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
const coneAngle = (p) => p.evaluate(() => {
  const c = document.querySelector('.mk-cone');
  const m = new DOMMatrix(getComputedStyle(c).transform);
  return { deg: (Math.atan2(m.b, m.a) * 180) / Math.PI, display: getComputedStyle(c).display };
});
const idbGet = (p, key) => p.evaluate((key) => new Promise((resolve) => {
  const open = indexedDB.open('sentiero');
  open.onsuccess = () => {
    const g = open.result.transaction('meta').objectStore('meta').get(key);
    g.onsuccess = () => { open.result.close(); resolve(g.result ?? null); };
  };
}), key);
const idbPut = (p, key, value) => p.evaluate(({ key, value }) => new Promise((resolve, reject) => {
  const open = indexedDB.open('sentiero');
  open.onsuccess = () => {
    const tx = open.result.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(value, key);
    tx.oncomplete = () => { open.result.close(); resolve(true); };
    tx.onerror = () => reject(tx.error);
  };
}), { key, value });

/** Conteggio pixel rossi (sfondo mappa forzato) nell'area della mappa: angoli senza tile. */
async function uncoveredPct(p, { hideTiles = false } = {}) {
  await p.addStyleTag({ content: `#map{background:#ff0000 !important}.leaflet-control-container{display:none!important}${hideTiles ? '.leaflet-tile-pane{display:none!important}' : ''}` });
  await W(p, 900);
  const buf = await p.screenshot();
  const rect = await p.evaluate(() => { const r = document.getElementById('map').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const r = await p.evaluate(async ({ b64, rect }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const sc = img.width / innerWidth;
    const d = ctx.getImageData(Math.round(rect.x * sc), Math.round(rect.y * sc), Math.round(rect.w * sc), Math.round(rect.h * sc)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 240 && d[i + 1] < 20 && d[i + 2] < 20) n++;
    return { red: n, total: d.length / 4 };
  }, { b64: buf.toString('base64'), rect });
  await p.addStyleTag({ content: '#map{background:#dfe3e6 !important}.leaflet-control-container{display:block!important}.leaflet-tile-pane{display:block!important}' });
  return (100 * r.red) / r.total;
}

export async function scenariosD() {
  // ------------------------------------------------------------------ 40
  await scenario(40, 'Bussola: ciclo a 3 stati, permesso nel tocco, nav segue la bussola, pagina nascosta', 'webkit', async (use) => {
    const app = use(await openCompass());
    const p = app.page;
    await inject(p, at(route.points[10]));
    let s = await st(p);
    ck('parte in free: Centra su di me, aria false, data-view-mode free', s.mode === 'free' && s.label === 'Centra su di me' && s.pressed === 'false' && s.dvm === 'free', s);
    ck('nessun ciclo rAF senza bussola attiva', (await rafDelta(p, 800)) < 5);
    ck('nessun listener deviceorientation prima del permesso', (await p.evaluate(() => window.__doAdd)) === 0);
    await p.evaluate(() => window.__sentiero.setView({ ...window.__sentiero.view(), bearing: 70 }));

    await p.click('#btn-locate');
    await W(p, 400);
    s = await st(p);
    ck('free→follow: Seguo la posizione, aria true, rotazione a 0', s.mode === 'follow' && s.label === 'Seguo la posizione' && s.pressed === 'true' && s.dvm === 'follow', s);
    ckAng('free→follow: rotazione azzerata', s.bearing, 0, 0.5);
    const calls = await p.evaluate(() => window.__permCalls);
    ck('requestPermission chiamato una volta, dentro il tocco su Centra', calls.length === 1 && /locate/.test(calls[0]), calls[0]?.split('\n').slice(0, 6));
    ck('listener aggiunto dopo il permesso', (await p.evaluate(() => window.__doAdd)) === 1);
    ck('ciclo rAF attivo con bussola attiva', (await rafDelta(p, 500)) > 10);

    await p.click('#btn-locate');
    await W(p, 600);
    s = await st(p);
    ck('follow→nav: Navigazione, aria true, data-view-mode nav', s.mode === 'nav' && s.label === 'Navigazione' && s.pressed === 'true' && s.dvm === 'nav', s);
    ckAng('nav: rotazione = 360 - 90 (il nord si sposta, la direzione 90 va in alto)', s.bearing, 270, 2);
    ck('nav: nessuna nuova richiesta di permesso', (await p.evaluate(() => window.__permCalls.length)) === 1);

    // la rotazione segue la bussola: a ogni direzione bearing = 360 - direzione (zona morta 1°)
    await setHeading(p, 200);
    await W(p, 1800);
    ckAng('bussola 200 → rotazione 160', (await st(p)).bearing, 160, 2);
    // zona morta di 1° rispetto alla rotazione applicata: il bersaglio è b0 + 0,6, quindi non ruota
    // (con +1 esatto il test dipenderebbe dall'arrotondamento in virgola mobile: stava sul bordo della soglia)
    const b0 = (await st(p)).bearing;
    await setHeading(p, 360 - b0 - 0.6);
    await W(p, 1500);
    ck('zona morta: bersaglio a +0,6 gradi dalla rotazione attuale non ruota', (await st(p)).bearing === b0, [b0, (await st(p)).bearing]);
    await setHeading(p, 360 - b0 - 1.5);
    await W(p, 1500);
    // la zona morta lascia al più 1° di errore: ruota appena il bersaglio la supera
    const moved = Math.abs(angDiff(b0, (await st(p)).bearing));
    ck('oltre la zona morta (+1,5 gradi): ruota (di almeno 0,9 e al più 1,6 gradi)', moved >= 0.9 && moved <= 1.6, moved);
    await setHeading(p, 205);
    await W(p, 1500);
    ckAng('+5 gradi: ruota', (await st(p)).bearing, 155, 2);
    await setHeading(p, 350);
    await W(p, 1800);
    ckAng('bussola 350 → rotazione 10', (await st(p)).bearing, 10, 2);
    // 350 → 10: attraversa lo 0 dalla parte corta, mai tra 60° e 300°
    await p.evaluate(() => { window.__trace = []; window.__tr = setInterval(() => window.__trace.push(window.__sentiero.bearing()), 40); });
    await setHeading(p, 10);
    await W(p, 1800);
    const trace = await p.evaluate(() => { clearInterval(window.__tr); return window.__trace; });
    ck('350→10: passa dallo 0 (parte corta), mai tra 60 e 300', trace.length > 20 && trace.every((b) => b < 60 || b > 300), trace.filter((b) => b >= 60 && b <= 300).slice(0, 5));
    ckAng('bearing finale 350', (await st(p)).bearing, 350, 2);

    // cono e bussolina a mappa ruotata
    const north = await p.evaluate(() => {
      const b = document.getElementById('btn-north');
      const r = b.getBoundingClientRect();
      const z = document.querySelector('.leaflet-control-zoom').getBoundingClientRect();
      const m = new DOMMatrix(getComputedStyle(document.getElementById('north-needle')).transform);
      return { hidden: b.hidden, r: { x: r.x, y: r.y, w: r.width, h: r.height }, zoomBottom: z.bottom, vw: innerWidth, needle: (Math.atan2(m.b, m.a) * 180) / Math.PI, label: b.getAttribute('aria-label') };
    });
    ck('bussolina visibile a mappa ruotata, ≥48 px, sotto lo zoom, dentro lo schermo', !north.hidden && north.r.w >= 48 && north.r.h >= 48 && north.r.y >= north.zoomBottom && north.r.x + north.r.w <= north.vw, north);
    ckAng('ago della bussolina ruotato come la mappa', north.needle, 350, 3);
    ck('aria-label della bussolina', north.label === 'Riporta il nord in alto', north.label);
    await p.screenshot({ path: `${SHOTS}\\40-nav.png` });

    // tocco sulla bussolina da nav: rotazione a 0 e passaggio a follow
    await p.click('#btn-north');
    await W(p, 300);
    s = await st(p);
    ck('bussolina da nav: rotazione 0 e follow', s.mode === 'follow' && Math.abs(angDiff(0, s.bearing)) < 0.5, s);
    ck('bussolina nascosta a nord in alto', await p.evaluate(() => document.getElementById('btn-north').hidden));
    await tap(p, 400);
    ck('follow→nav di nuovo', (await st(p)).mode === 'nav');
    await tap(p, 200);
    s = await st(p);
    ck('nav→free: Centra su di me, aria false, rotazione invariata', s.mode === 'free' && s.label === 'Centra su di me' && s.pressed === 'false' && Math.abs(angDiff(0, s.bearing)) > 5, s);
    const bf = s.bearing;
    await setHeading(p, 120);
    await W(p, 1000);
    ck('in free la bussola non ruota la mappa', Math.abs(angDiff(bf, (await st(p)).bearing)) < 0.5);
    ck('cono attivo in free', (await coneAngle(p)).display !== 'none');

    // pagina nascosta: ciclo fermo, listener rimosso; visibile: riparte senza nuova richiesta
    await p.evaluate(() => { window.__vis = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
    await W(p, 300);
    ck('pagina nascosta: rAF fermo', (await rafDelta(p, 1000)) === 0);
    ck('pagina nascosta: listener rimosso', (await p.evaluate(() => window.__doRem)) >= 1);
    await p.evaluate(() => { window.__vis = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
    await W(p, 500);
    ck('pagina visibile: rAF riparte', (await rafDelta(p, 500)) > 10);
    ck('listener riaggiunto senza nuova richiesta di permesso', (await p.evaluate(() => [window.__doAdd, window.__permCalls.length])).join() === '2,1', await p.evaluate(() => [window.__doAdd, window.__permCalls.length]));
  });

  // ------------------------------------------------------------------ 41
  await scenario(41, 'Rotazione: utente al 70% in nav senza salti, cono e frecce con la mappa, centro a mappa ruotata', 'webkit', async (use) => {
    const app = use(await openCompass());
    const p = app.page;
    await inject(p, at(route.points[10]));
    await tap(p, 400);
    await tap(p, 600);
    ck('in nav', (await st(p)).mode === 'nav');
    await W(p, 2000); // assestamento: la mappa scivola verso l'ancora al 70% e ruota

    // posizione in nav: orizzontale al centro, verticale al 70% dell'area visibile
    const g = await gpsXY(p);
    const vis = g.h - g.panel;
    ck('nav: utente a x=50%, y=70% area visibile', Math.abs(g.x - g.w / 2) < 3 && Math.abs(g.y - vis * 0.7) < 3, g);
    // nessun salto mentre la mappa ruota
    const drift = [];
    for (const h of [30, 120, 250, 350]) {
      await setHeading(p, h);
      await W(p, 1300);
      const q = await gpsXY(p);
      drift.push(Math.hypot(q.x - g.w / 2, q.y - vis * 0.7));
    }
    ck('nav: utente fermo a schermo mentre ruota (±3 px)', drift.every((d) => d < 3), drift);
    await setHeading(p, 90);
    await W(p, 1500);

    // cono: secondo figlio, senza interazione con i tocchi, --heading, punta in alto in nav
    const cone = await p.evaluate(() => {
      const c = document.querySelector('.mk-cone');
      const n = c.parentElement;
      return { display: getComputedStyle(c).display, pe: getComputedStyle(c).pointerEvents, kids: n.children.length, second: n.children[1] === c, first: n.firstChild.classList.contains('mk-gps'), heading: parseFloat(n.style.getPropertyValue('--heading')) };
    });
    ck('cono visibile, secondo figlio del marcatore GPS, non intercetta i tocchi', cone.display !== 'none' && cone.kids === 2 && cone.second && cone.first && cone.pe === 'none', cone);
    ckAng('cono: --heading = direzione 90', cone.heading, 90, 1);
    ckAng('cono in nav: punta in alto', (await coneAngle(p)).deg, 0, 3);

    // frecce sulla traccia: angolo = N + rotazione mappa (N = valore della regex, invariato)
    const arrowsNow = () => p.evaluate(() => {
      const map = document.getElementById('map');
      const arrows = [...document.querySelectorAll('.mk-arrow svg')].map((s) => {
        const m = new DOMMatrix(getComputedStyle(s).transform);
        return { key: Number(/rotate\(calc\((-?[\d.]+)deg/.exec(s.style.transform)?.[1]), css: (Math.atan2(m.b, m.a) * 180) / Math.PI };
      });
      return { bearing: window.__sentiero.bearing(), mapVar: map.style.getPropertyValue('--map-bearing'), arrows };
    });
    const ar = await arrowsNow();
    ck('frecce presenti sulla traccia', ar.arrows.length > 0, ar.arrows.length);
    ck('--map-bearing sulla mappa = rotazione', ar.mapVar === `${ar.bearing}deg`, [ar.mapVar, ar.bearing]);
    ar.arrows.slice(0, 5).forEach((a, i) => ckAng(`freccia ${i}: N + rotazione mappa`, a.css, a.key + ar.bearing, 1));

    // libera: centro a mappa ruotata e geometria del cono (direzione + rotazione)
    await tap(p, 400);
    ck('nav→free', (await st(p)).mode === 'free');
    for (const [b, h] of [[0, 0], [0, 90], [45, 30], [137, 200], [270, 350]]) {
      await p.evaluate((b) => window.__sentiero.setView({ ...window.__sentiero.view(), bearing: b }), b);
      await setHeading(p, h);
      await W(p, 2000);
      const c = await coneAngle(p);
      ckAng(`cono libero: mappa ${b}, direzione ${h} → ${(h + b) % 360}`, c.deg, h + b, 3);
      ck(`cono visibile con direzione ${h}`, c.display !== 'none', c.display);
      if (b === 0 && h === 0) {
        const rc = await p.evaluate(() => {
          const c = document.querySelector('.mk-cone').getBoundingClientRect();
          const d = document.querySelector('.mk-gps').getBoundingClientRect();
          return { cx: c.x + c.width / 2 - (d.x + d.width / 2), bottom: c.bottom - (d.y + d.height / 2) };
        });
        ck('cono con rotazione 0: punta dal centro del pallino', Math.abs(rc.cx) < 1.5 && Math.abs(rc.bottom) < 1.5, rc);
      }
    }
    await p.screenshot({ path: `${SHOTS}\\41-cone-137.png` });

    // centro a mappa ruotata: follow con rotazione forzata, il tick ricentra il pallino nell'area libera
    await tap(p, 400);
    await p.evaluate(() => window.__sentiero.setView({ ...window.__sentiero.view(), bearing: 137 }));
    await W(p, 1500);
    const f = await gpsXY(p);
    const v2 = f.h - f.panel;
    ck('follow a mappa ruotata 137: pallino al centro dell\'area libera (±3 px)', Math.abs(f.x - f.w / 2) < 3 && Math.abs(f.y - v2 / 2) < 3, f);
    ck('follow a mappa ruotata: modo follow (rotazione tenuta dal tocco su Centra)', (await st(p)).mode === 'follow');
  });

  // ------------------------------------------------------------------ 42
  await scenario(42, 'Banner a mappa ruotata, bussolina (posizione, ago, tocco), trascinamento e Modifica escono da nav', 'webkit', async (use) => {
    const app = use(await openCompass());
    const p = app.page;
    await inject(p, offset(start.lat, start.lon, 300, 0)); // 300 m a est dell'inizio: fuori traccia
    await p.waitForSelector('#banner:not([hidden])', { timeout: 5000 });
    const geo = await p.evaluate(() => window.__sentiero.snapshot().bearingToTrackDeg);
    const arrowDeg = () => p.evaluate(() => {
      const m = new DOMMatrixReadOnly(getComputedStyle(document.getElementById('banner-arrow')).transform);
      return (Math.atan2(m.b, m.a) * 180) / Math.PI;
    });
    const screenAngleToStart = () => p.evaluate(() => {
      const g = document.querySelector('.mk-gps').getBoundingClientRect();
      const s = document.querySelector('.mk-start').getBoundingClientRect();
      const dx = s.x + s.width / 2 - (g.x + g.width / 2);
      const dy = s.y + s.height / 2 - (g.y + g.height / 2);
      return (Math.atan2(dx, -dy) * 180) / Math.PI;
    });
    ck('banner fuori traccia: testo geografico verso ovest', /verso ovest/.test(await txt(p, '#banner-text')), await txt(p, '#banner-text'));
    ckAng('mappa a 0: freccia = direzione geografica', await arrowDeg(), geo, 1);
    for (const b of [0, 90, 200, 315]) {
      // lettura subito dopo la rotazione: nessun tick da 1 s di mezzo
      const sync = await p.evaluate((b) => {
        window.__sentiero.setView({ ...window.__sentiero.view(), bearing: b });
        const m = new DOMMatrixReadOnly(getComputedStyle(document.getElementById('banner-arrow')).transform);
        return (Math.atan2(m.b, m.a) * 180) / Math.PI;
      }, b);
      ckAng(`mappa a ${b}: freccia aggiornata subito = geo + rotazione`, sync, geo + b, 1);
      await W(p, 400);
      ckAng(`mappa a ${b}: freccia = angolo reale a schermo verso la traccia`, await arrowDeg(), await screenAngleToStart(), 4);
      ck(`mappa a ${b}: testo ancora geografico`, /verso ovest/.test(await txt(p, '#banner-text')));
    }

    // bussolina: visibile a mappa ruotata, ago ruotato, sotto lo zoom e fuori da barra di stato e banner
    await p.evaluate(() => window.__sentiero.setView({ ...window.__sentiero.view(), bearing: 315 }));
    await W(p, 300);
    const nb = await p.evaluate(() => {
      const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
      const btn = document.getElementById('btn-north');
      const m = new DOMMatrix(getComputedStyle(document.getElementById('north-needle')).transform);
      return {
        hidden: btn.hidden, box: r(btn), zoom: r(document.querySelector('.leaflet-control-zoom')), status: r(document.getElementById('status')),
        banner: r(document.getElementById('banner')), needle: (Math.atan2(m.b, m.a) * 180) / Math.PI, vw: innerWidth,
      };
    });
    ck('bussolina visibile a 315°, ≥48 px', !nb.hidden && nb.box.w >= 48 && nb.box.h >= 48, nb);
    ck('bussolina sotto i controlli di zoom, dentro lo schermo', nb.box.y >= nb.zoom.b && nb.box.r <= nb.vw, nb);
    ck('bussolina sotto la safe-area superiore', nb.box.y >= 47, nb.box.y);
    const overlap = (a, b) => a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;
    ck('bussolina non sovrapposta a barra di stato né banner', !overlap(nb.box, nb.status) && !overlap(nb.box, nb.banner), { box: nb.box, status: nb.status, banner: nb.banner });
    ckAng('ago della bussolina ruotato come la mappa (315)', nb.needle, 315, 3);

    // tocco da free: rotazione a 0, bussolina nascosta
    await p.click('#btn-north');
    await W(p, 300);
    ck('bussolina in free: rotazione 0 e nascosta', Math.abs(angDiff(0, (await st(p)).bearing)) < 0.5 && (await p.evaluate(() => document.getElementById('btn-north').hidden)));

    // da nav, la bussolina riporta il nord e passa a follow
    await tap(p, 400);
    await tap(p, 700);
    ck('in nav per il test della bussolina', (await st(p)).mode === 'nav');
    ck('nav: rotazione ≠ 0 e bussolina visibile', Math.abs(angDiff(0, (await st(p)).bearing)) > 5 && (await p.evaluate(() => !document.getElementById('btn-north').hidden)));
    await p.click('#btn-north');
    await W(p, 300);
    const afterNorth = await st(p);
    ck('bussolina da nav: follow e rotazione 0', afterNorth.mode === 'follow' && Math.abs(angDiff(0, afterNorth.bearing)) < 0.5, afterNorth);

    // trascinamento in nav → free
    await tap(p, 700);
    ck('di nuovo in nav', (await st(p)).mode === 'nav');
    await p.mouse.move(200, 300);
    await p.mouse.down();
    await p.mouse.move(150, 320, { steps: 5 });
    await p.mouse.move(100, 340, { steps: 5 });
    await p.mouse.up();
    await W(p, 300);
    ck('trascinamento in nav → free', (await st(p)).mode === 'free', await st(p));

    // Modifica traccia: esce da nav e riporta il nord in alto
    await tap(p, 400); // free → follow
    await tap(p, 700); // follow → nav
    ck('di nuovo in nav per Modifica', (await st(p)).mode === 'nav', await st(p));
    await p.click('#btn-tracks');
    await p.locator('.track').first().getByRole('button', { name: 'Modifica', exact: true }).click();
    await p.waitForSelector('.sheet.half');
    await W(p, 500);
    const se = await st(p);
    ck('foglio Modifica: esce da nav, rotazione 0', se.mode !== 'nav' && Math.abs(angDiff(0, se.bearing)) < 0.5, se);
    await closeSheet(p);
  });

  // ------------------------------------------------------------------ 43
  await scenario(43, 'Permesso negato, bussola assente, ascolto diretto senza requestPermission', 'webkit', async (use) => {
    // a) negato
    {
      const app = use(await openCompass({ perm: 'denied' }));
      const p = app.page;
      await inject(p, at(route.points[10]));
      await tap(p, 300);
      let s = await st(p);
      ck('negato: free→follow', s.mode === 'follow', s);
      await tap(p, 300);
      s = await st(p);
      ck('negato: follow→free (nav saltato)', s.mode === 'free' && s.pressed === 'false' && s.label === 'Centra su di me', s);
      ck('negato: toast con istruzioni', /Bussola non autorizzata/.test(await toast(p)), await toast(p));
      await clearToast(p);
      await tap(p, 200);
      await tap(p, 300);
      s = await st(p);
      ck('negato, secondo giro: ancora follow→free, mai nav', s.mode === 'free', s);
      ck('negato: toast una sola volta', (await toast(p)) === '', await toast(p));
      ck('negato: permesso richiesto a ogni tocco (4 tocchi)', (await p.evaluate(() => window.__permCalls.length)) === 4, await p.evaluate(() => window.__permCalls.length));
      ck('negato: nessun listener, rAF fermo', (await p.evaluate(() => window.__doAdd)) === 0 && (await rafDelta(p, 600)) < 5);
      ck('negato: cono nascosto', (await coneAngle(p)).display === 'none');
      ck('negato: nessun errore', app.errors.length === 0, app.errors);
      await app.close();
    }
    // b) permesso concesso ma nessuna misura
    {
      const app = use(await openCompass({ events: false }));
      const p = app.page;
      await inject(p, at(route.points[10]));
      await tap(p, 300);
      await tap(p, 300);
      const s = await st(p);
      ck('bussola assente: follow→free con toast', s.mode === 'free' && /Bussola non disponibile/.test(await toast(p)), [s, await toast(p)]);
      await app.close();
    }
    // c) nessun requestPermission (Android/desktop): ascolto diretto
    {
      const app = use(await openCompass({ api: false }));
      const p = app.page;
      await inject(p, at(route.points[10]));
      await tap(p, 400);
      await tap(p, 500);
      const s = await st(p);
      ck('senza requestPermission: ascolta direttamente, nav raggiunge 270', s.mode === 'nav' && Math.abs(angDiff(270, s.bearing)) < 3, s);
      ck('nessun errore', app.errors.length === 0, app.errors);
      await app.close();
    }
  });

  // ------------------------------------------------------------------ 44
  await scenario(44, 'Bussola inaffidabile: cono nascosto, nord in alto dopo 5 s con un solo toast per episodio; nav senza posizione', 'webkit', async (use) => {
    const app = use(await openCompass());
    const p = app.page;
    await inject(p, at(route.points[10]));
    await tap(p, 400);
    await tap(p, 600);
    ck('in nav', (await st(p)).mode === 'nav');
    await clearToast(p);
    await p.evaluate(() => { window.__acc = -1; });
    await W(p, 4200);
    ckAng('dopo ~4 s inaffidabile: ancora ruotato a 270', (await st(p)).bearing, 270, 3);
    ck('cono nascosto quando inaffidabile', (await coneAngle(p)).display === 'none');
    const toastShown = () => p.waitForFunction(() => { const t = document.getElementById('toast'); return t.classList.contains('show') && /Bussola non affidabile/.test(t.textContent); }, null, { timeout: 9000 });
    await toastShown();
    await W(p, 1200); // assestamento: la rotazione torna a 0 con l'animazione
    let s = await st(p);
    ck('inaffidabile da più di 5 s: rotazione 0, resta in nav', Math.abs(angDiff(0, s.bearing)) < 0.5 && s.mode === 'nav', s);
    ck('toast: mappa con il nord in alto', /Bussola non affidabile: mappa con il nord in alto/.test(await toast(p)), await toast(p));
    await clearToast(p);
    await p.evaluate(() => { window.__acc = 5; window.__h = 180; });
    await W(p, 2200);
    s = await st(p);
    ck('di nuovo affidabile: riprende (rotazione 180), nav', Math.abs(angDiff(180, s.bearing)) < 3 && s.mode === 'nav', s);
    ck('cono di nuovo visibile', (await coneAngle(p)).display !== 'none');
    // secondo episodio: un nuovo toast
    await p.evaluate(() => { window.__acc = -1; });
    await toastShown();
    ck('secondo episodio: toast di nuovo', /Bussola non affidabile/.test(await toast(p)), await toast(p));
    await p.evaluate(() => { window.__acc = 5; });
    await W(p, 1500);
    ck('nessun errore', app.errors.length === 0, app.errors);
    await app.close();
  });
  await scenario(45, 'Nav senza posizione ruota soltanto; compensazione orizzontale della bussola (screen.orientation 90)', 'webkit', async (use) => {
    // a) nav senza posizione: ruota e basta
    {
      const app = use(await openCompass({ tracks: false }));
      const p = app.page;
      await tap(p, 300);
      let s = await st(p);
      ck('senza posizione: toast e resta free', s.mode === 'free' && /Posizione GPS non ancora disponibile/.test(await toast(p)), s);
      await p.evaluate((s0) => window.__sentiero.injectFix({ lat: s0.lat, lon: s0.lon, accuracy: 10, timestamp: Date.now() - 13000 }), start);
      await tap(p, 300);
      await tap(p, 400);
      s = await st(p);
      ck('con fix (scaduto a breve): entra in nav', s.mode === 'nav', s);
      await W(p, 3500); // il fix scade (15 s): posizione ignota
      await setHeading(p, 30);
      await W(p, 1800);
      s = await st(p);
      ckAng('nav senza posizione: ruota comunque (330)', s.bearing, 330, 3);
      ck('nessun errore', app.errors.length === 0, app.errors);
      await app.close();
    }
    // b) orientamento schermo a 90 (WebKit in verticale): direzione = bussola + 90
    {
      const app = use(await openCompass());
      const p = app.page;
      await p.evaluate(() => { window.__ang = 90; });
      await inject(p, at(route.points[10]));
      await W(p, 1500); // il filtro converge a 180 prima di entrare in nav
      await tap(p, 400);
      await tap(p, 600);
      const s = await st(p);
      ck('angolo schermo 90, bussola 90: nav a 180 (screenHeading = 90 + 90)', s.mode === 'nav' && Math.abs(angDiff(180, s.bearing)) < 3, s);
      const cone = await coneAngle(p);
      ckAng('cono in nav con angolo 90: punta in alto', cone.deg, 0, 3);
      await p.evaluate(() => { window.__ang = 0; });
      await setHeading(p, 90);
      await W(p, 2000);
      ckAng('angolo tornato a 0: nav a 270', (await st(p)).bearing, 270, 3);
      await app.close();
    }
  });

  // ------------------------------------------------------------------ 46
  await scenario(46, 'Persistenza: rotazione salvata con la vista, modo non salvato, vista senza rotazione', 'webkit', async (use) => {
    const app = use(await openCompass());
    const p = app.page;
    await p.evaluate(() => window.__sentiero.setView({ ...window.__sentiero.view(), bearing: 45 }));
    // il salvataggio è in ritardo di 1 s (debounce): si interroga IndexedDB finché compare
    let saved = null;
    for (let i = 0; i < 40 && saved?.bearing !== 45; i++) {
      await W(p, 200);
      saved = await idbGet(p, 'view');
    }
    ck('vista salvata con bearing 45', saved?.bearing === 45, saved);
    await p.reload();
    await p.waitForFunction(() => !!window.__sentiero);
    await W(p, 800);
    let s = await st(p);
    ckAng('dopo ricarica: rotazione 45 ripristinata', s.bearing, 45, 0.5);
    ck('dopo ricarica: parte da free (modo non salvato)', s.mode === 'free' && s.label === 'Centra su di me', s);
    ck('dopo ricarica: nessun errore', app.errors.length === 0, app.errors);

    // vista salvata da una versione precedente: niente bearing = 0
    await idbPut(p, 'view', { lat: 46.01, lon: 11.02, zoom: 14 });
    await p.reload();
    await p.waitForFunction(() => !!window.__sentiero);
    await W(p, 800);
    s = await st(p);
    ck('vista senza bearing: rotazione 0', Math.abs(angDiff(0, s.bearing)) < 0.5, s);
    const v = await p.evaluate(() => window.__sentiero.view());
    ck('vista senza bearing: posizione e zoom salvati', Math.abs(v.lat - 46.01) < 1e-3 && Math.abs(v.lon - 11.02) < 1e-3 && v.zoom === 14, v);
    await app.close();
  });

  // ------------------------------------------------------------------ 47
  await scenario(47, 'Nessun angolo scoperto a mappa ruotata (tile), zoom e attribuzione', 'webkit', async (use) => {
    const app = use(await openCompass());
    const p = app.page;
    await inject(p, at(route.points[10]));
    const res = {};
    for (const b of [0, 45, 137, 270]) {
      await p.evaluate((b) => window.__sentiero.setView({ ...window.__sentiero.view(), bearing: b }), b);
      res[`mappa ${b}`] = await uncoveredPct(p);
    }
    await tap(p, 400);
    await tap(p, 600);
    res['nav'] = await uncoveredPct(p);
    // controllo della sonda: senza tile lo sfondo rosso deve vedersi, altrimenti 0% non vorrebbe dire nulla
    res.controllo = await uncoveredPct(p, { hideTiles: true });
    // il pannello e i controlli coprono circa metà dello schermo: il rosso visibile è ~44%, non 100%
    ck('controllo: senza tile la sonda vede il rosso (>20%)', res.controllo > 20, res.controllo);
    delete res.controllo;
    note(`angoli scoperti in % dello schermo: ${JSON.stringify(Object.fromEntries(Object.entries(res).map(([k, v]) => [k, +v.toFixed(3)])))}`);
    for (const [k, v] of Object.entries(res)) ck(`${k}: nessun angolo scoperto (<0,01%)`, v < 0.01, v);

    // zoom a mappa ruotata: la rotazione resta
    const z0 = (await p.evaluate(() => window.__sentiero.view())).zoom;
    await p.click('.leaflet-control-zoom-in');
    await W(p, 500);
    const v1 = await p.evaluate(() => window.__sentiero.view());
    ck('zoom avanti a mappa ruotata: zoom +1 e rotazione invariata', v1.zoom === z0 + 1 && Math.abs(angDiff(270, v1.bearing)) < 3, [z0, v1]);
    ck('attribuzione presente e visibile', await p.evaluate(() => { const a = document.querySelector('.leaflet-control-attribution'); return !!a && getComputedStyle(a).display !== 'none'; }));

    // ridimensionamento della finestra (ResizeObserver): nessun angolo scoperto
    await p.setViewportSize({ width: 390, height: 520 });
    await W(p, 800);
    const after = await uncoveredPct(p);
    ck('dopo ridimensionamento: nessun angolo scoperto (<0,01%)', after < 0.01, after);
    ck('dopo ridimensionamento: rotazione invariata', Math.abs(angDiff(270, (await st(p)).bearing)) < 3, await st(p));
  });

  // ------------------------------------------------------------------ 48
  await scenario(48, 'Gesto a due dita in nav (Chromium, CDP): ruota, passa a Seguo, la bussola non sovrascrive', 'chromium', async (use) => {
    const app = use(await openCompass({}, 'chromium'));
    const p = app.page;
    await inject(p, at(route.points[10]));
    await tap(p, 400);
    await tap(p, 700);
    ck('in nav prima del gesto', (await st(p)).mode === 'nav', await st(p));
    const c = await gpsPage(p);
    const cdp = await app.ctx.newCDPSession(p);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    const pair = (r, a) => [[c.x + r * Math.cos(a), c.y + r * Math.sin(a)], [c.x - r * Math.cos(a), c.y - r * Math.sin(a)]];
    await touch('touchStart', pair(80, 0));
    for (let i = 1; i <= 15; i++) {
      await touch('touchMove', pair(80, (i / 15) * (Math.PI / 3)));
      await W(p, 16);
    }
    // a metà del gesto la bussola cambia: la mappa non deve seguirla, né uscire da nav prima della fine
    await setHeading(p, 200);
    await W(p, 1200);
    const mid = await st(p);
    ck('durante il gesto: resta in nav', mid.mode === 'nav', mid);
    ck('durante il gesto: la rotazione è quella del gesto (60°), non la bussola (160)', Math.abs(Math.abs(angDiff(270, mid.bearing)) - 60) < 5, mid.bearing);
    await touch('touchEnd', []);
    await W(p, 900);
    const after = await st(p);
    ck('fine gesto: passa a Seguo la posizione', after.mode === 'follow' && after.label === 'Seguo la posizione' && after.pressed === 'true', after);
    ck('fine gesto: rotazione tenuta (60° da 270)', Math.abs(Math.abs(angDiff(270, after.bearing)) - 60) < 5, after.bearing);
    ck('fine gesto: rotazione = quella del gesto, nessuno scatto', Math.abs(angDiff(mid.bearing, after.bearing)) < 3, [mid.bearing, after.bearing]);
    await setHeading(p, 300);
    await W(p, 1500);
    ck('in follow la bussola non ruota più la mappa', Math.abs(angDiff(after.bearing, (await st(p)).bearing)) < 1, (await st(p)).bearing);
    ck('bussolina visibile con mappa ruotata', await p.evaluate(() => !document.getElementById('btn-north').hidden));
    ck('nessun errore', app.errors.length === 0, app.errors);
  });

  // ------------------------------------------------------------------ 49 .. 54: transizioni automatiche fluide
  const P0 = route.points[10];
  const fixAt = (dx, dy) => ({ accuracy: 8, ...offset(P0.lat, P0.lon, dx, dy) });
  /** Invia un fix e campiona a ogni fotogramma pallino (px dalla mappa) e centro della mappa. */
  const glide = (p, fix, ms) => p.evaluate(({ fix, ms }) => {
    window.__sentiero.injectFix(fix);
    return window.__rec(() => ({ ...window.__gpsRel(), c: window.__sentiero.view() }), ms);
  }, { fix, ms });
  const dist = (a, b) => haversineM({ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon });
  const animDelta = async (p, ms) => {
    const a = await p.evaluate(() => window.__animRaf);
    await W(p, ms);
    return (await p.evaluate(() => window.__animRaf)) - a;
  };

  await scenario(49, 'Transizioni: in follow e in nav mappa e pallino scivolano insieme (pallino fermo a schermo); in free il pallino scivola da solo', 'webkit', async (use) => {
    const app = use(await openCompass());
    const p = app.page;
    await inject(p, at(P0));
    await tap(p, 400); // follow
    await W(p, 1000);
    for (const mode of ['follow', 'nav']) {
      if (mode === 'nav') {
        await tap(p, 400);
        await W(p, 2500); // assestamento: rotazione e ancora al 70%
        ck('in nav', (await st(p)).mode === 'nav');
      }
      const a = await gpsXY(p);
      const vis = a.h - a.panel;
      const anchor = { x: a.w / 2, y: mode === 'nav' ? vis * 0.7 : vis / 2 };
      ck(`${mode}: a riposo il pallino sta sull'ancora (±3 px)`, Math.abs(a.x - anchor.x) < 3 && Math.abs(a.y - anchor.y) < 3, [a, anchor]);
      const dx = mode === 'nav' ? -25 : 25;
      const samples = await glide(p, fixAt(dx, 12), 1600);
      const c0 = samples[0].c;
      const cEnd = samples[samples.length - 1].c;
      const total = dist(c0, cEnd);
      const frac = samples.map((s) => (total > 0 ? dist(c0, s.c) / total : 0));
      const dev = Math.max(...samples.map((s) => Math.hypot(s.x - anchor.x, s.y - anchor.y)));
      ck(`${mode}: la mappa si sposta davvero (>15 m)`, total > 15, total);
      ck(`${mode}: al primo fotogramma la mappa non è già arrivata (<50%)`, frac[0] < 0.5, frac.slice(0, 3));
      ck(`${mode}: la mappa scivola, almeno 6 fotogrammi intermedi (10-90%)`, frac.filter((f) => f > 0.1 && f < 0.9).length >= 6, frac.map((f) => +f.toFixed(2)));
      ck(`${mode}: il percorso della mappa è monotono (nessun andirivieni)`, frac.every((f, i) => i === 0 || f >= frac[i - 1] - 0.02), frac.map((f) => +f.toFixed(2)));
      ck(`${mode}: il pallino resta fermo sullo schermo durante tutto lo scorrimento (±1,5 px)`, dev < 1.5, dev);
      await p.screenshot({ path: `${SHOTS}\\49-${mode}-fine.png` });
    }
    // libera: la mappa resta ferma, il pallino scivola da solo
    await tap(p, 300);
    ck('nav→free', (await st(p)).mode === 'free');
    await W(p, 800);
    const samples = await glide(p, fixAt(-40, 30), 1600);
    const c0 = samples[0].c;
    ck('free: la mappa non si muove (<0,05 m)', samples.every((s) => dist(c0, s.c) < 0.05), Math.max(...samples.map((s) => dist(c0, s.c))));
    const d0 = samples[0];
    const dEnd = samples[samples.length - 1];
    const tot = Math.hypot(dEnd.x - d0.x, dEnd.y - d0.y);
    const f = samples.map((s) => Math.hypot(s.x - d0.x, s.y - d0.y) / tot);
    ck('free: il pallino si sposta (>5 px)', tot > 5, tot);
    ck('free: al primo fotogramma il pallino non è già arrivato (<50%)', f[0] < 0.5, f.slice(0, 3));
    ck('free: il pallino scivola, almeno 6 fotogrammi intermedi', f.filter((v) => v > 0.1 && v < 0.9).length >= 6, f.map((v) => +v.toFixed(2)));
  });

  await scenario(50, 'Transizioni: la rotazione passa sempre dalla parte corta (350↔10), con valori intermedi', 'webkit', async (use) => {
    const app = use(await openCompass());
    const p = app.page;
    await inject(p, at(P0));
    await tap(p, 400);
    await setHeading(p, 10); // rotazione 350
    await tap(p, 600);
    await W(p, 2500);
    ckAng('in nav a 350', (await st(p)).bearing, 350, 1);
    const track = (target) => p.evaluate((h) => {
      window.__h = h;
      return window.__rec(() => window.__sentiero.bearing(), 2500);
    }, target);
    for (const [from, to, heading] of [[350, 10, 350], [10, 350, 10]]) {
      const b = await track(heading);
      const un = b.map((v) => from + angDiff(from, v)); // angolo srotolato rispetto alla partenza
      const inside = (v) => v >= 345 || v <= 15; // l'arco corto, con 1-2° di margine per la zona morta della bussola
      ck(`${from}→${to}: ogni valore intermedio sta tra 350 e 10 passando dallo 0 (mai dalla parte lunga)`, b.every(inside), b.filter((v) => !inside(v)).slice(0, 5));
      const sign = angDiff(from, to) > 0 ? 1 : -1;
      ck(`${from}→${to}: andamento monotono (dopo il primo fotogramma, tolleranza 0,3° per l'assestamento del filtro bussola)`, un.every((v, i) => i === 0 || (v - un[i - 1]) * sign >= -0.3), un.map((v) => +v.toFixed(1)));
      const mid = b.filter((v) => Math.abs(angDiff(v, from)) > 1 && Math.abs(angDiff(v, to)) > 1);
      ck(`${from}→${to}: almeno 6 fotogrammi intermedi`, mid.length >= 6, mid.length);
      const maxStep = Math.max(...b.slice(1).map((v, i) => Math.abs(angDiff(b[i], v))));
      ck(`${from}→${to}: nessuno scatto (passo massimo tra fotogrammi ≤ 9°)`, maxStep <= 9, +maxStep.toFixed(1));
      ckAng(`${from}→${to}: arriva a ${to} (la zona morta di 1° può lasciare fino a 1° di scarto)`, b[b.length - 1], to, 1.2);
    }
  });

  await scenario(51, 'Transizioni: il motore si ferma a fine animazione (nessun rAF inutile) e riparte al nuovo obiettivo', 'webkit', async (use) => {
    const app = use(await openCompass());
    const p = app.page;
    await inject(p, at(P0));
    await tap(p, 400);
    await tap(p, 600);
    await W(p, 3000);
    ck('in nav, ferma', (await st(p)).mode === 'nav');
    const loopBefore = await p.evaluate(() => window.__raf);
    ck('a riposo in nav: nessun rAF del motore in 2,5 s (il tick da 1 s e la bussola girano)', (await animDelta(p, 2500)) === 0);
    ck('(controllo) il ciclo bussola intanto è vivo', (await p.evaluate(() => window.__raf)) - loopBefore > 20);
    await inject(p, fixAt(20, 15));
    await W(p, 400);
    ck('nuovo obiettivo: il motore riparte', (await p.evaluate(() => window.__animRaf)) > 3);
    await W(p, 3600);
    ck('dopo l\'arrivo: di nuovo nessun rAF in 2 s', (await animDelta(p, 2000)) === 0);
    // libera: solo il pallino
    await tap(p, 300);
    await W(p, 500);
    await inject(p, fixAt(-20, 5));
    await W(p, 400);
    ck('free: il pallino in movimento usa il motore', (await p.evaluate(() => window.__animRaf)) > 0);
    await W(p, 3600);
    ck('free: arrivato, nessun rAF in 2 s', (await animDelta(p, 2000)) === 0);
    // la bussola cambia la rotazione: parte e si ferma
    await tap(p, 300);
    await tap(p, 300);
    await W(p, 2500);
    await setHeading(p, 200);
    await W(p, 3500);
    ck('rotazione arrivata, nessun rAF in 2 s', (await animDelta(p, 2000)) === 0);
    ckAng('rotazione arrivata a 160', (await st(p)).bearing, 160, 1.5);
  });

  await scenario(52, 'Transizioni: salti grandi, zoom esplicito, cambio di zoom e ritorno da pagina nascosta sono immediati', 'webkit', async (use) => {
    const app = use(await openCompass());
    const p = app.page;
    await inject(p, at(P0));
    // zoom esplicito (tocco su Centra): subito
    await p.click('#btn-locate');
    const a = await p.evaluate(() => ({ ...window.__gpsRel(), ...(() => { const m = document.getElementById('map').getBoundingClientRect(); return { w: m.width, h: m.height, panel: document.getElementById('panel').offsetHeight }; })() }));
    ck('tocco su Centra: il pallino è subito al centro dell\'area libera (±3 px)', Math.abs(a.x - a.w / 2) < 3 && Math.abs(a.y - (a.h - a.panel) / 2) < 3, a);
    await W(p, 1000);
    // salto grande (400 m) in follow: subito
    let s = await glide(p, fixAt(400, 0), 500);
    ck('follow, salto di 400 m: il pallino è sull\'ancora già al primo fotogramma (±2 px)', Math.hypot(s[0].x - a.w / 2, s[0].y - (a.h - a.panel) / 2) < 2, s[0]);
    ck('follow, salto di 400 m: nessun fotogramma intermedio', s.every((q) => Math.hypot(q.x - a.w / 2, q.y - (a.h - a.panel) / 2) < 2));
    await W(p, 800);
    ck('follow, salto di 400 m: il motore è già fermo', (await animDelta(p, 800)) <= 1);
    // cambio di zoom: al fix successivo la mappa si riporta sull'ancora subito
    await p.click('.leaflet-control-zoom-in');
    await W(p, 700);
    s = await glide(p, fixAt(402, 2), 400);
    ck('dopo il cambio di zoom: il pallino è sull\'ancora già al primo fotogramma (±2 px)', Math.hypot(s[0].x - a.w / 2, s[0].y - (a.h - a.panel) / 2) < 2, s[0]);
    // nav: salto grande subito, poi ritorno da pagina nascosta
    await tap(p, 400);
    await W(p, 2500);
    const vis = a.h - a.panel;
    s = await glide(p, fixAt(900, 100), 400);
    ck('nav, salto di 900 m: il pallino è sull\'ancora al 70% già al primo fotogramma (±2 px)', Math.hypot(s[0].x - a.w / 2, s[0].y - vis * 0.7) < 2, [s[0], vis * 0.7]);
    await W(p, 600);
    const hidden = await p.evaluate((fix) => {
      window.__sentiero.injectFix(fix);
      window.__vis = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      return { ...window.__gpsRel(), anim: window.__animRaf };
    }, fixAt(925, 110));
    ck('pagina nascosta con animazione in corso: arriva subito all\'obiettivo (±1,5 px)', Math.hypot(hidden.x - a.w / 2, hidden.y - vis * 0.7) < 1.5, hidden);
    ck('pagina nascosta: il motore resta fermo', (await animDelta(p, 600)) === 0);
    await p.evaluate(() => { window.__vis = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
  });

  await scenario(53, 'Transizioni: il trascinamento cancella l\'obiettivo di mappa e non si combatte col dito', 'webkit', async (use) => {
    const app = use(await openCompass());
    const p = app.page;
    await inject(p, at(P0));
    await tap(p, 400);
    await tap(p, 600);
    await W(p, 2500);
    ck('in nav', (await st(p)).mode === 'nav');
    await inject(p, fixAt(-30, 20)); // l'animazione parte
    await p.mouse.move(200, 300);
    await p.mouse.down();
    await p.mouse.move(150, 320, { steps: 4 });
    await p.mouse.move(100, 340, { steps: 4 });
    await W(p, 300); // fermo prima di rilasciare: niente inerzia di Leaflet
    await p.mouse.up();
    ck('trascinamento: passa a free', (await st(p)).mode === 'free', await st(p));
    await W(p, 200);
    const v1 = await p.evaluate(() => window.__sentiero.view());
    const rot1 = (await st(p)).bearing;
    await W(p, 2000);
    const v2 = await p.evaluate(() => window.__sentiero.view());
    ck('dopo il rilascio la mappa non si muove più verso il vecchio obiettivo (<0,5 m)', dist(v1, v2) < 0.5, dist(v1, v2));
    ckAng('dopo il rilascio la rotazione non cambia', (await st(p)).bearing, rot1, 0.3);
    ck('il pallino ha finito di scorrere e il motore è fermo', (await animDelta(p, 1000)) === 0);
  });

  await scenario(54, 'Transizioni: due dita sospendono l\'animazione e non la combattono (Chromium, CDP)', 'chromium', async (use) => {
    const app = use(await openCompass({}, 'chromium'));
    const p = app.page;
    await inject(p, at(P0));
    await tap(p, 400); // follow
    await W(p, 1000);
    const a = await gpsXY(p);
    const c = await gpsPage(p);
    const cdp = await app.ctx.newCDPSession(p);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    await inject(p, fixAt(30, 20)); // l'animazione parte
    await touch('touchStart', [[c.x + 70, c.y], [c.x - 70, c.y]]);
    const before = await p.evaluate(() => ({ anim: window.__animRaf, v: window.__sentiero.view() }));
    await W(p, 600);
    const during = await p.evaluate(() => ({ anim: window.__animRaf, v: window.__sentiero.view() }));
    ck('con due dita appoggiate il motore è sospeso (nessun rAF)', during.anim - before.anim <= 1, during.anim - before.anim);
    ck('con due dita appoggiate la mappa non si muove (<0,3 m)', dist(before.v, during.v) < 0.3, dist(before.v, during.v));
    await touch('touchEnd', []);
    await W(p, 2500);
    const g = await gpsXY(p);
    ck('a dita sollevate l\'animazione riprende e arriva: pallino sull\'ancora (±3 px)', Math.hypot(g.x - a.x, g.y - a.y) < 3, [g, a]);
    ck('e poi il motore si ferma', (await animDelta(p, 1000)) === 0);
    ck('nessun errore', app.errors.length === 0, app.errors);
  });

  await scenario(55, 'Transizioni: la freccia del banner usa la rotazione mostrata, anche a metà animazione', 'webkit', async (use) => {
    const app = use(await openCompass());
    const p = app.page;
    await inject(p, offset(start.lat, start.lon, 300, 0)); // 300 m a est dell'inizio: fuori traccia
    await p.waitForSelector('#banner:not([hidden])', { timeout: 5000 });
    const geo = await p.evaluate(() => window.__sentiero.snapshot().bearingToTrackDeg);
    await tap(p, 400);
    await tap(p, 600);
    await W(p, 2500);
    ck('in nav', (await st(p)).mode === 'nav');
    const samples = await p.evaluate((h) => {
      window.__h = h; // rotazione da 270 a 160
      return window.__rec(() => {
        const m = new DOMMatrixReadOnly(getComputedStyle(document.getElementById('banner-arrow')).transform);
        const g = document.querySelector('.mk-gps').getBoundingClientRect();
        const s = document.querySelector('.mk-start').getBoundingClientRect();
        return {
          bearing: window.__sentiero.bearing(),
          arrow: (Math.atan2(m.b, m.a) * 180) / Math.PI,
          real: (Math.atan2(s.x + s.width / 2 - (g.x + g.width / 2), -(s.y + s.height / 2 - (g.y + g.height / 2))) * 180) / Math.PI,
        };
      }, 2500);
    }, 200);
    const mid = samples.filter((q) => Math.abs(angDiff(q.bearing, 270)) > 5 && Math.abs(angDiff(q.bearing, 160)) > 5);
    ck('campionati almeno 5 fotogrammi a metà animazione', mid.length >= 5, mid.length);
    ck('freccia = direzione geografica + rotazione mostrata, a ogni fotogramma (±1,5°)', samples.every((q) => Math.abs(angDiff(q.arrow, geo + q.bearing)) < 1.5), samples.filter((q) => Math.abs(angDiff(q.arrow, geo + q.bearing)) >= 1.5).slice(0, 3));
    ck('freccia = angolo reale a schermo verso la traccia, a ogni fotogramma (±4°)', samples.every((q) => Math.abs(angDiff(q.arrow, q.real)) < 4), samples.filter((q) => Math.abs(angDiff(q.arrow, q.real)) >= 4).slice(0, 3));
    ckAng('rotazione finale 160', samples[samples.length - 1].bearing, 160, 1.5);
  });

  // ------------------------------------------------------------------ 56
  await scenario(56, 'Tema: predefinito chiaro, scelta persistente, automatico, colori e profilo', 'webkit', async (use) => {
    const app = use(await openCompass());
    const p = app.page;
    const look = () => p.evaluate(() => {
      const css = (el, prop) => getComputedStyle(el)[prop];
      const c = document.getElementById('profile');
      return {
        theme: document.documentElement.dataset.theme,
        pref: window.sentieroTheme.pref(),
        bg: css(document.getElementById('panel'), 'backgroundColor'),
        fg: css(document.getElementById('st-dist'), 'color'),
        filter: css(document.querySelector('.leaflet-tile-pane'), 'filter'),
        zoomBg: css(document.querySelector('.leaflet-control-zoom a'), 'backgroundColor'),
        toastBg: css(document.getElementById('toast'), 'backgroundColor'),
        arrow: css(document.querySelector('.mk-arrow svg'), 'fill'),
        bar: document.querySelector('meta[name="theme-color"]').content,
        profile: c.toDataURL(),
      };
    });
    const choose = async (label) => {
      await p.click('#btn-theme');
      await p.click(`.seg.wide button:has-text("${label}")`);
      const pressed = await p.$$eval('.seg.wide button[aria-pressed="true"]', (b) => b.map((x) => x.textContent));
      ck(`${label}: è l'unica opzione evidenziata`, pressed.length === 1 && pressed[0] === label, pressed);
      await closeSheet(p);
    };

    const light = await look();
    ck('senza scelta il tema è chiaro', light.theme === 'light' && light.pref === 'light', light.theme);
    ck('chiaro: nessun filtro sulla mappa', light.filter === 'none', light.filter);

    await choose('Scuro');
    const dark = await look();
    ck('scuro: tema applicato', dark.theme === 'dark', dark.theme);
    ck('scuro: pannello scuro e testo chiaro', dark.bg === 'rgb(21, 24, 28)' && dark.fg === 'rgb(241, 243, 245)', [dark.bg, dark.fg]);
    ck('scuro: mappa filtrata', dark.filter.includes('invert'), dark.filter);
    ck('scuro: controlli di zoom scuri', dark.zoomBg === 'rgb(21, 24, 28)', dark.zoomBg);
    ck('scuro: avvisi non chiari sotto testo bianco', dark.toastBg === 'rgb(42, 47, 54)', dark.toastBg);
    ck('scuro: frecce di direzione invariate', dark.arrow === light.arrow, [dark.arrow, light.arrow]);
    ck('scuro: barra del browser scura', dark.bar === '#15181c', dark.bar);
    ck('scuro: il profilo è stato ridisegnato', dark.profile !== light.profile);
    await p.screenshot({ path: `${SHOTS}\\56-scuro.png`, scale: 'css' });

    await p.reload();
    await p.waitForFunction(() => window.__sentiero && window.__sentiero.tracks().length > 0);
    const again = await p.evaluate(() => [document.documentElement.dataset.theme, window.sentieroTheme.pref()]);
    ck('dopo il riavvio resta scuro', again[0] === 'dark' && again[1] === 'dark', again);

    await p.emulateMedia({ colorScheme: 'dark' });
    await choose('Automatico');
    ck('automatico con iPhone scuro: scuro', (await look()).theme === 'dark');
    await p.emulateMedia({ colorScheme: 'light' });
    // L'evento del sistema arriva al primo aggiornamento di rendering, non subito: si attende, con un limite.
    await p.waitForFunction(() => document.documentElement.dataset.theme === 'light', null, { timeout: 2000 }).catch(() => {});
    const autoLight = await look();
    ck('automatico segue il passaggio a chiaro', autoLight.theme === 'light', autoLight.theme);
    await choose('Scuro');
    const darkAgain = await look();
    ck('scuro dopo il riavvio: profilo diverso dal chiaro', darkAgain.profile !== autoLight.profile);

    await p.emulateMedia({ colorScheme: 'dark' });
    await choose('Chiaro');
    await W(p, 100);
    const back = await look();
    ck('chiaro ignora l\'iPhone scuro', back.theme === 'light' && back.filter === 'none', back.theme);
    // Non con `light`: dopo il ricaricamento il pannello ha un altro stato e il profilo cambia a prescindere dal tema.
    ck('tornando a chiaro il profilo è identico a quello chiaro', back.profile === autoLight.profile);
  });
}
