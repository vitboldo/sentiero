// Scenari 4-5: perdita GPS e banner fuori traccia.
import {
  FILES3, SHOTS, advance, canvasColorX, ck, ckNear, closeSheet, fmtKmT, importFiles, injectAt, jump, near, nodeTracks, note, offset,
  openApp, panel, parseIt, scenario, snap, txt, walk,
} from './harness.mjs';
import { buildRoute, remainingFrom, statsAt } from '../src/core/route.js';

export async function scenariosA2() {
  // ------------------------------------------------------------------ 4
  await scenario(4, 'Perdita GPS: pillola, marker, ~, recupero, >2 h, fuori traccia', 'webkit', async (use) => {
    const app = use(await openApp('webkit'));
    await app.boot();
    const p = app.page;
    await importFiles(app, FILES3);
    await closeSheet(p);
    const route = buildRoute(nodeTracks(FILES3));
    const level = () => p.getAttribute('#status', 'data-level');
    const pill = () => txt(p, '#status-text');
    const centre = (sel) => p.evaluate((q) => {
      const r = document.querySelector(q)?.getBoundingClientRect();
      return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, sel);

    await walk(app, route, 0, 1800, { step: 28, speed: 1.4 });
    ck('verde con GPS buono', (await level()) === 'ok' && (await pill()) === 'GPS ok ±8 m', await pill());
    const sure = await snap(p);
    ck('ultimo punto sicuro sulla traccia', sure.lastSure?.onTrack === true);

    await p.clock.fastForward(20_000);
    await advance(app, 1100);
    ck('giallo dopo ~20 s senza fix', (await level()) === 'weak' && (await pill()) === 'GPS debole ±8 m', [await level(), await pill()]);

    await p.clock.fastForward(54_000);
    await advance(app, 1100);
    ck('rosso dopo ~75 s: testo italiano esatto', (await level()) === 'lost' && (await pill()) === 'Stima: ultimo punto sicuro 1 min fa', [await level(), await pill()]);

    await jump(app, 11 * 60_000 - 20_000);   // circa 12 min dall'ultimo punto sicuro
    const s = await snap(p);
    const ageMin = Math.floor(s.estimate.ageSec / 60);
    ck('pillola: minuti trascorsi', (await pill()) === `Stima: ultimo punto sicuro ${ageMin} min fa` && ageMin >= 11, [await pill(), ageMin]);
    ck('stima disponibile, fonte stima', s.quality === 'lost' && s.source === 'stima' && s.estimate && s.estimate.minDist === s.lastSure.distAlong, s.estimate);
    ck('stima avanzata sulla route entro limiti ragionevoli', s.estimate.distAlong > s.lastSure.distAlong + 400 && s.estimate.distAlong < s.lastSure.distAlong + 1600, [s.estimate.distAlong, s.lastSure.distAlong]);
    ck('ritmo osservato', s.estimate.paceSource === 'osservato', s.estimate.paceSource);
    ck('maxDist >= stima >= minDist', s.estimate.maxDist >= s.estimate.distAlong && s.estimate.distAlong >= s.estimate.minDist);

    // marker distinti
    const sureBox = await centre('.mk-sure i');
    const estBox = await centre('.mk-est');
    ck('entrambi i marker (ultimo sicuro e stima) presenti', !!sureBox && !!estBox);
    ck('marker lontani tra loro (non sovrapposti)', sureBox && estBox && Math.hypot(sureBox.x - estBox.x, sureBox.y - estBox.y) > 30, [sureBox, estBox]);
    ck('nessun marker GPS blu durante la stima', (await p.locator('.mk-gps').count()) === 0);
    const styles = await p.evaluate(() => {
      const cs = (q) => getComputedStyle(document.querySelector(q));
      return {
        estBorder: cs('.mk-est').borderTopStyle, estColor: cs('.mk-est').borderTopColor, sureBg: cs('.mk-sure i').backgroundColor,
        estText: document.querySelector('.mk-est').textContent, sureText: document.querySelector('.mk-sure b').textContent,
      };
    });
    ck('stima tratteggiata arancione, con ~', styles.estBorder === 'dashed' && styles.estColor === 'rgb(194, 74, 0)' && styles.estText === '~', styles);
    ck('ultimo sicuro: viola pieno con l\'ora', styles.sureBg === 'rgb(91, 33, 182)' && /^\d{2}:\d{2}$/.test(styles.sureText), styles);
    const pn = await panel(p);
    ck('numeri con prefisso ~', [pn.dist, pn.up, pn.down, pn.time].every((v) => v.startsWith('~')), pn);
    ck('didascalia: posizione stimata', /Da posizione stimata/.test(pn.caption), pn.caption);
    ck('numeri in arancione', (await p.evaluate(() => getComputedStyle(document.getElementById('st-dist')).color)) === 'rgb(194, 74, 0)');
    ckNear('km mancanti dalla stima', parseIt(pn.dist), remainingFrom(route, s.estimate.distAlong).dist / 1000, 0.07);
    ck('profilo: stima arancione', (await canvasColorX(p, '#profile', [194, 74, 0], 30)) !== null);
    const sureTick = await canvasColorX(p, '#profile', [91, 33, 182], 20);
    ck('profilo: tacca dell\'ultimo punto sicuro viola', sureTick !== null && near(sureTick.x, s.lastSure.distAlong / route.totalDist, 0.05), sureTick);
    await p.screenshot({ path: `${SHOTS}\\02-estimate.png`, scale: 'css' });

    // recupero: un fix buono 180 m oltre la stima
    const s0 = await snap(p);
    await injectAt(app, route, s0.estimate.distAlong + 180);
    const rec = await snap(p);
    ck('justRecovered con delta ≈ 180 m', rec.justRecovered && near(rec.justRecovered.deltaM, rec.distAlong - s0.estimate.distAlong, 3) && near(rec.justRecovered.deltaM, 180, 20), rec.justRecovered);
    const t = await pill();
    ck('pillola di recupero in italiano', t === `GPS recuperato, eri ${Math.round(rec.justRecovered.deltaM)} m oltre la stima`, t);
    const toast = await p.evaluate(() => ({ cls: document.getElementById('toast').className, text: document.getElementById('toast').textContent }));
    ck('toast di recupero con il delta', /show/.test(toast.cls) && toast.text.includes('GPS recuperato') && toast.text.includes(`${Math.round(rec.justRecovered.deltaM)} m`), toast);
    ck('niente ~ dopo il recupero', !(await panel(p)).dist.startsWith('~'));
    await p.clock.fastForward(40_000);
    await injectAt(app, route, s0.estimate.distAlong + 200);
    await advance(app, 1100);
    ck('dopo 30 s torna a "GPS ok"', (await pill()) === 'GPS ok ±8 m', await pill());

    // oltre 2 ore senza fix: nessuna stima, nessuna posizione fuorviante
    await jump(app, 2 * 3600_000 + 5 * 60_000);
    const old = await snap(p);
    ck('> 2 h: stima non disponibile', old.estimate === null && old.estimateUnavailableReason === 'troppo tempo senza GPS' && old.source === 'nessuna', old);
    const pl = await pill();
    ck('> 2 h: pillola "stima non disponibile"', (await level()) === 'lost' && /stima non disponibile/.test(pl) && !/^Stima:/.test(pl), pl);
    ck('> 2 h: nessun marker di stima o GPS', (await p.locator('.mk-est, .mk-gps').count()) === 0);
    const pold = await panel(p);
    ck('> 2 h: pannello senza posizione né ~', /Dall'inizio/.test(pold.caption) && !pold.dist.startsWith('~') && pold.dist === fmtKmT(route.totalDist), pold);
    ck('> 2 h: profilo senza banda arancione', (await canvasColorX(p, '#profile', [194, 74, 0], 30)) === null);

    // ultimo punto sicuro fuori traccia: nessuna stima
    const pos = statsAt(route, 2000);
    const far = offset(pos.lat, pos.lon, 300, 0);
    await p.evaluate((f) => window.__sentiero.injectFix(f), { lat: far.lat, lon: far.lon, accuracy: 8 });
    const off = await snap(p);
    ck('fix a 300 m: fuori traccia, ultimo sicuro non sulla traccia', off.offTrack === true && off.lastSure.onTrack === false, [off.offTrack, off.lastSure]);
    await jump(app, 120_000);
    const lost = await snap(p);
    ck('fuori traccia + GPS perso: niente stima', lost.quality === 'lost' && lost.estimate === null && lost.estimateUnavailableReason === 'fuori traccia', lost);
    ck('pillola: stima non disponibile (fuori traccia)', (await pill()) === 'GPS perso, stima non disponibile (fuori traccia)', await pill());
    ck('nessun marker di stima', (await p.locator('.mk-est').count()) === 0);
    ck('resta visibile l\'ultimo punto sicuro', (await p.locator('.mk-sure').count()) === 1);
    note(`ultimo sicuro a ${Math.round(sure.lastSure.distAlong)} m, stima a ${Math.round(s.estimate.distAlong)} m dopo ${ageMin} min`);
  });

  // ------------------------------------------------------------------ 5
  await scenario(5, 'Banner fuori traccia: distanza, freccia ruotata, rientro', 'webkit', async (use) => {
    const app = use(await openApp('webkit'));
    await app.boot();
    const p = app.page;
    await importFiles(app, FILES3);
    await closeSheet(p);
    const route = buildRoute(nodeTracks(FILES3));
    const arrowDeg = () => p.evaluate(() => {
      const m = new DOMMatrixReadOnly(getComputedStyle(document.getElementById('banner-arrow')).transform);
      return (Math.atan2(m.b, m.a) * 180 / Math.PI + 360) % 360;
    });
    const D = 1000;
    const base = statsAt(route, D);
    const lateralTo = async (from, to, stepDx) => {
      for (let dx = from; stepDx > 0 ? dx <= to : dx >= to; dx += stepDx) {
        await app.page.clock.fastForward(7000);
        const at = offset(base.lat, base.lon, dx, 0);
        await p.evaluate((f) => window.__sentiero.injectFix(f), { lat: at.lat, lon: at.lon, accuracy: 8 });
      }
    };
    await walk(app, route, 0, D, { step: 28, speed: 1.4 });
    ck('sulla traccia: nessun banner', await p.locator('#banner').isHidden());
    // si allontana gradualmente a est (la traccia va a nord: il punto più vicino è a ovest)
    await lateralTo(10, 120, 10);
    await advance(app, 1100);
    ck('banner visibile', await p.locator('#banner').isVisible());
    const bt = await txt(p, '#banner-text');
    const s = await snap(p);
    ck('testo: distanza ≈ 120 m e direzione ovest', /^Sei a 1[12]\d m dalla traccia, verso ovest$/.test(bt) && near(s.offTrackM, 120, 4), [bt, s.offTrackM]);
    ck('freccia ruotata verso ovest (270°)', near(await arrowDeg(), 270, 8), await arrowDeg());
    ck('stato offTrack, pillola GPS ok', s.offTrack === true && (await txt(p, '#status-text')) === 'GPS ok ±8 m');
    ck('km mancanti = miglior progresso', near(parseIt((await panel(p)).dist), remainingFrom(route, D).dist / 1000, 0.1), await panel(p));
    await p.screenshot({ path: `${SHOTS}\\03-off-track.png`, scale: 'css' });

    // dall'altra parte: verso est, freccia a 90°
    await lateralTo(100, -120, -20);
    const bt2 = await txt(p, '#banner-text');
    ck('dall\'altra parte: verso est, freccia a 90°', /verso est$/.test(bt2) && near(await arrowDeg(), 90, 8), [bt2, await arrowDeg()]);
    // rientro
    await lateralTo(-100, 0, 20);
    ck('rientrato: banner nascosto', await p.locator('#banner').isHidden());
    ck('rientrato: offTrack falso', (await snap(p)).offTrack === false);
  });
}
