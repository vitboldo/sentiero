// Scenari 1-5: import, inversione, camminata, perdita GPS, fuori traccia.
import {
  BAD, FILES3, FILE_OAB, FILE_STRAIGHT, advance, canvasColorX, ck, ckNear, closeSheet, fmtKmT, fmtTimeT, importFiles, injectAt, jump,
  minutesOf, near, nodeTracks, note, openApp, panel, parseIt, scenario, snap, tracksOf, txt, walk, SHOTS,
} from './harness.mjs';
import { buildRoute, remainingFrom, reverseSession, routeTimeSeconds } from '../src/core/route.js';
import { haversineM } from '../src/core/geo.js';

const rowNames = (p) => p.locator('.track .track-name strong').allTextContents();
const rowMeta = (p) => p.locator('.track .meta').allTextContents();
const rowOf = (p, name) => p.locator('.track', { hasText: name }).first();
// Stile: rotate(calc(Ndeg + var(--map-bearing, 0deg))); N è l'angolo della freccia sulla traccia (senza rotazione mappa).
const arrows = (p) => p.evaluate(() => [...document.querySelectorAll('.mk-arrow svg')].map((s) => Number(/rotate\(calc\((-?[\d.]+)deg/.exec(s.style.transform)?.[1])));

export async function scenariosA() {
  // ------------------------------------------------------------------ 1
  await scenario(1, 'Import di 3 GPX + 1 non valido, totali, riordino', 'webkit', async (use) => {
    const app = use(await openApp('webkit'));
    await app.boot();
    const nt = nodeTracks(FILES3);
    const route = buildRoute(nt);
    await importFiles(app, [FILES3[0], BAD, FILES3[1], FILES3[2]]);
    const p = app.page;

    ck('3 tracce nell\'elenco', (await p.locator('.track').count()) === 3);
    ck('nomi in ordine di import', JSON.stringify(await rowNames(p)) === JSON.stringify(['Alpha', 'Bravo', 'Charlie']), await rowNames(p));
    const report = await txt(p, '.notice[role=status]');
    ck('report: 3 importate', /Importate 3 tracce/.test(report), report);
    ck('report: file non valido citato con messaggio in italiano', /rotto\.gpx: .+/.test(report) && /[a-z]{4,}/i.test(report.split('rotto.gpx:')[1] ?? ''), report);
    const gap = route.trackRanges[1].gapBeforeM;
    const warn = await p.locator('.notice.warn', { hasText: 'Salto di' }).allTextContents();
    ck('avviso salto > 200 m solo per Bravo', warn.length === 1 && warn[0].includes(`Salto di ${Math.round(gap)} m`), { warn, gap });
    ck('salto non contato: totalDist < somma lunghezze + salti', route.totalDist > 0);

    await p.screenshot({ path: `${SHOTS}\\04-tracks-sheet.png`, scale: 'css' });
    await closeSheet(p);
    const pn = await panel(p);
    ck('km totali = core', pn.dist === fmtKmT(route.totalDist), [pn.dist, fmtKmT(route.totalDist)]);
    ck('D+ totale = core', pn.up === String(Math.round(route.totalUp)), [pn.up, route.totalUp]);
    ck('D- totale = core', pn.down === String(Math.round(route.totalDown)), [pn.down, route.totalDown]);
    ck('tempo = core', pn.time === fmtTimeT(routeTimeSeconds(route, 0, route.totalDist)), [pn.time, fmtTimeT(routeTimeSeconds(route, 0, route.totalDist))]);
    ck('selettore Tappa/Totale visibile con 3 tracce', await p.locator('#scope').isVisible());
    ck('didascalia senza posizione', /Dall'inizio/.test(pn.caption), pn.caption);

    // le 3 tracce sono visibili insieme sulla mappa, sopra il pannello
    const marks = await p.evaluate(() => {
      const top = document.getElementById('panel').getBoundingClientRect().top;
      const boxes = (sel) => [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }));
      return { top, w: innerWidth, start: boxes('.mk-start'), end: boxes('.mk-end') };
    });
    ck('3 marker di inizio e 3 di fine', marks.start.length === 3 && marks.end.length === 3, marks);
    ck('tutti i marker entro lo schermo e sopra il pannello', [...marks.start, ...marks.end].every((m) => m.x > 0 && m.x < marks.w && m.y > 0 && m.y < marks.top), marks);
    await p.waitForTimeout(300);
    await p.screenshot({ path: `${SHOTS}\\_tmp-import.png`, scale: 'css' });

    // riordino: Alpha giù
    await p.click('#btn-tracks');
    ck('Su disabilitato sulla prima, Giù sull\'ultima', await rowOf(p, 'Alpha').getByRole('button', { name: 'Su', exact: true }).isDisabled() && await rowOf(p, 'Charlie').getByRole('button', { name: 'Giù', exact: true }).isDisabled());
    await rowOf(p, 'Alpha').getByRole('button', { name: 'Giù', exact: true }).click();
    await p.waitForFunction(() => document.querySelector('.track .track-name strong').textContent === 'Bravo');
    ck('ordine UI dopo Giù', JSON.stringify(await rowNames(p)) === JSON.stringify(['Bravo', 'Alpha', 'Charlie']), await rowNames(p));
    ck('ordine stato dopo Giù', JSON.stringify((await tracksOf(p)).map((t) => t.name)) === JSON.stringify(['Bravo', 'Alpha', 'Charlie']));
    const reordered = buildRoute([nt[1], nt[0], nt[2]]);
    await closeSheet(p);
    const pn2 = await panel(p);
    ck('totali ricalcolati sul nuovo ordine = core', pn2.dist === fmtKmT(reordered.totalDist) && pn2.up === String(Math.round(reordered.totalUp)) && pn2.down === String(Math.round(reordered.totalDown)), [pn2, reordered.totalDist, reordered.totalUp, reordered.totalDown]);
    await p.click('#btn-tracks');
    await rowOf(p, 'Alpha').getByRole('button', { name: 'Su', exact: true }).click();
    await p.waitForFunction(() => document.querySelector('.track .track-name strong').textContent === 'Alpha');
    ck('Su ripristina l\'ordine', JSON.stringify(await rowNames(p)) === JSON.stringify(['Alpha', 'Bravo', 'Charlie']));
  });

  // ------------------------------------------------------------------ 2
  await scenario(2, 'Inversione di una traccia e di tutto il percorso', 'webkit', async (use) => {
    const app = use(await openApp('webkit'));
    await app.boot();
    const p = app.page;
    await importFiles(app, [FILE_STRAIGHT]);
    await closeSheet(p);
    const nt = nodeTracks([FILE_STRAIGHT]);
    const fwd = buildRoute(nt);
    const bwd = buildRoute([{ ...nt[0], reversed: true }]);
    const before = await panel(p);
    const arrowsBefore = await arrows(p);
    const yStart = (await p.locator('.mk-start').boundingBox()).y;
    const yEnd = (await p.locator('.mk-end').boundingBox()).y;
    ck('prima: inizio a sud (più in basso), fine a nord', yStart > yEnd, [yStart, yEnd]);
    ck('prima: frecce verso nord', arrowsBefore.length > 0 && arrowsBefore.every((a) => Math.abs(a) <= 15), arrowsBefore);
    ck('D+ > D- prima', Number(before.up) > Number(before.down));

    await p.click('#btn-tracks');
    await rowOf(p, 'Dritta').getByRole('button', { name: 'Inverti', exact: true }).click();
    await p.waitForFunction(() => window.__sentiero.tracks()[0].reversed === true);
    ck('riga indica il verso invertito', /verso invertito/.test((await rowMeta(p))[0]));
    await closeSheet(p);
    const after = await panel(p);
    ck('km conservati', after.dist === before.dist, [before.dist, after.dist]);
    ckNear('D+ dopo = D- prima', Number(after.up), Number(before.down), Math.max(2, Number(before.down) * 0.03));
    ckNear('D- dopo = D+ prima', Number(after.down), Number(before.up), Math.max(2, Number(before.up) * 0.03));
    ck('valori = core invertito', after.up === String(Math.round(bwd.totalUp)) && after.down === String(Math.round(bwd.totalDown)), [after, bwd.totalUp, bwd.totalDown]);
    const arrowsAfter = await arrows(p);
    ck('dopo: frecce verso sud (180°)', arrowsAfter.length > 0 && arrowsAfter.every((a) => Math.abs(Math.abs(a) - 180) <= 15), arrowsAfter);
    const yStart2 = (await p.locator('.mk-start').boundingBox()).y;
    const yEnd2 = (await p.locator('.mk-end').boundingBox()).y;
    ck('dopo: inizio a nord (più in alto), fine a sud', yStart2 < yEnd2, [yStart2, yEnd2]);

    // Intero percorso a 3 tracce
    await p.click('#btn-tracks');
    await p.locator('.track').first().getByRole('button', { name: 'Elimina', exact: true }).click();
    await p.click('.modal button:last-child');
    await p.waitForFunction(() => window.__sentiero.tracks().length === 0);
    await importFiles(app, FILES3);
    await closeSheet(p);
    const nt3 = nodeTracks(FILES3);
    const route = buildRoute(nt3);
    const rev = buildRoute(reverseSession(nt3));
    const pre = await panel(p);
    ck('prima dell\'inversione = core', pre.dist === fmtKmT(route.totalDist) && pre.up === String(Math.round(route.totalUp)));
    const reverseAll = async (firstName) => {
      await p.click('#btn-tracks');
      await p.getByRole('button', { name: 'Inverti tutto il percorso' }).click();
      await p.waitForFunction((n) => window.__sentiero.tracks()[0].name === n, firstName);
      return closeSheet(p);
    };
    await reverseAll('Charlie');
    const ts = await tracksOf(p);
    ck('ordine invertito e verso invertito per ciascuna', JSON.stringify(ts.map((t) => [t.name, t.reversed])) === JSON.stringify([['Charlie', true], ['Bravo', true], ['Alpha', true]]), ts.map((t) => [t.name, t.reversed]));
    const post = await panel(p);
    ck('km totali conservati', post.dist === pre.dist, [pre.dist, post.dist]);
    ck('D+/D- = core invertito', post.up === String(Math.round(rev.totalUp)) && post.down === String(Math.round(rev.totalDown)), [post, rev.totalUp, rev.totalDown]);
    ckNear('D+ dopo ≈ D- prima (3%)', Number(post.up), Number(pre.down), Math.max(3, Number(pre.down) * 0.03));
    ckNear('D- dopo ≈ D+ prima (3%)', Number(post.down), Number(pre.up), Math.max(3, Number(pre.up) * 0.03));
    await reverseAll('Alpha');
    ck('invertire due volte torna ai valori originali', JSON.stringify(await panel(p)) === JSON.stringify(pre), await panel(p));

    // con un fix fresco: viene riallineato sulla nuova route in posizione speculare
    await injectAt(app, route, 4000);
    const s1 = await snap(p);
    ckNear('posizione prima di invertire', s1.distAlong, 4000, 25);
    await reverseAll('Charlie');
    const s2 = await snap(p);
    ckNear('progresso riallineato (speculare)', s2.distAlong, route.totalDist - 4000, 30);
    ckNear('mancano = vecchio fatto', s2.remaining.dist, s1.done.dist, 35);
    ckNear('fatto + mancano = totale', s2.done.dist + s2.remaining.dist, route.totalDist, 1);
    // fix scaduto: lo stato riparte da zero senza posizione inventata
    await jump(app, 90_000);
    await reverseAll('Alpha');
    const s3 = await snap(p);
    ck('fix scaduto: nessuna posizione (source nessuna)', s3 === null || s3.source === 'nessuna', s3?.source);
    const pn3 = await panel(p);
    ck('fix scaduto: panel dall\'inizio, tutto il percorso', /Dall'inizio/.test(pn3.caption) && pn3.dist === fmtKmT(route.totalDist), pn3);
    ck('nessun marker GPS né stima', (await p.locator('.mk-gps, .mk-est').count()) === 0);
  });

  // ------------------------------------------------------------------ 3
  await scenario(3, 'Camminata lungo 3 tracce: km/D+/D-/ETA, Tappa/Totale, profilo', 'webkit', async (use) => {
    const app = use(await openApp('webkit'));
    await app.boot();
    const p = app.page;
    await importFiles(app, FILES3);
    await closeSheet(p);
    const route = buildRoute(nodeTracks(FILES3));
    const total = route.totalDist;
    const R = route.trackRanges;
    console.log(`    route: ${(total / 1000).toFixed(2)} km, D+ ${Math.round(route.totalUp)}, D- ${Math.round(route.totalDown)}, tappe a ${R.map((r) => Math.round(r.endDist)).join(', ')}`);
    const checkpoints = [400, 1500, R[0].endDist - 100, R[0].endDist + 100, R[1].startDist + 1200, R[1].endDist - 80, R[1].endDist + 200, R[2].startDist + 1500, total - 20];
    let last = { dist: Infinity, up: Infinity, down: Infinity, eta: Infinity, x: -1 };
    let at = 0;
    for (const [i, target] of checkpoints.entries()) {
      const d = await walk(app, route, at, target, { step: 40 });
      at = target;
      const s = await snap(p);
      const pn = await panel(p);
      const exp = remainingFrom(route, d);
      ck(`#${i} pillola GPS ok`, /^GPS ok ±8 m$/.test(await txt(p, '#status-text')), await txt(p, '#status-text'));
      ckNear(`#${i} posizione sulla route`, s.distAlong, d, 30);
      ckNear(`#${i} km mancanti (pannello)`, parseIt(pn.dist), exp.dist / 1000, 0.07);
      ckNear(`#${i} D+ mancante (pannello)`, Number(pn.up), exp.up, 12);
      ckNear(`#${i} D- mancante (pannello)`, Number(pn.down), exp.down, 12);
      const eta = minutesOf(pn.time);
      ckNear(`#${i} ETA (min) = Munter x ritmo osservato`, eta, s.remaining.etaSec / 60, 1.5);
      const ratio = s.remaining.etaSec / routeTimeSeconds(route, d);
      ck(`#${i} ritmo entro i limiti [0.5, 2]`, ratio >= 0.49 && ratio <= 2.01, ratio);
      ck(`#${i} km/D+/D-/ETA non crescono`, parseIt(pn.dist) <= last.dist && Number(pn.up) <= last.up && Number(pn.down) <= last.down && eta <= last.eta, [pn, last]);
      const lab = pn.label;
      ck(`#${i} etichetta fatti/mancano`, /^fatti [\d.,]+ km · mancano [\d.,]+ km$/.test(lab) && near(parseIt(/fatti ([\d.,]+) km/.exec(lab)[1]), d / 1000, 0.07), lab);
      // marker del profilo (linea blu GPS sul canvas)
      const px = await canvasColorX(p, '#profile', [0, 87, 217]);
      ck(`#${i} marker nel profilo`, px !== null && near(px.x, d / total, 0.04) && px.x >= last.x - 0.01, { px, expected: d / total });
      // Totale vs Tappa
      const rIdx = R.findIndex((r) => d < r.endDist);
      const range = R[rIdx < 0 ? R.length - 1 : rIdx];
      await p.click('#scope button[data-mode=tappa]');
      const pt = await panel(p);
      const expT = remainingFrom(route, d, range.endDist);
      ck(`#${i} Tappa: didascalia con nome ${range.name}`, pt.caption.includes(range.name), pt.caption);
      ckNear(`#${i} Tappa: km mancanti`, parseIt(pt.dist), expT.dist / 1000, 0.07);
      ckNear(`#${i} Tappa: D+`, Number(pt.up), expT.up, 12);
      ckNear(`#${i} Tappa: D-`, Number(pt.down), expT.down, 12);
      ck(`#${i} Tappa <= Totale`, parseIt(pt.dist) <= parseIt(pn.dist) + 0.001);
      ck(`#${i} Tappa premuto (aria-pressed)`, (await p.getAttribute('#scope button[data-mode=tappa]', 'aria-pressed')) === 'true');
      await p.click('#scope button[data-mode=totale]');
      ckNear(`#${i} Totale di nuovo`, parseIt((await panel(p)).dist), exp.dist / 1000, 0.07);
      last = { dist: parseIt(pn.dist), up: Number(pn.up), down: Number(pn.down), eta, x: px?.x ?? last.x };
    }
    await p.screenshot({ path: `${SHOTS}\\01-main-gps-ok.png`, scale: 'css' });
    const s = await snap(p);
    ck('a fine percorso mancano ~0 km', s.remaining.dist < 60, s.remaining);
  });

  await scenario(31, 'Andata e ritorno: la tratta di ritorno conta come progresso', 'webkit', async (use) => {
    const app = use(await openApp('webkit'));
    await app.boot();
    const p = app.page;
    await importFiles(app, [FILE_OAB]);
    await closeSheet(p);
    const route = buildRoute(nodeTracks([FILE_OAB]));
    const turn = route.totalDist / 2;
    let worst = 0;
    let snapped = 0;
    let prev = -1;
    let d = 0;
    for (; d <= route.totalDist - 20; d += 30) {
      await walk(app, route, d, d, { step: 30 });
      const s = await snap(p);
      const err = Math.abs(s.distAlong - d);
      worst = Math.max(worst, err);
      if (d > turn + 60 && s.distAlong < turn) snapped++;
      ck(`d=${Math.round(d)}: progresso mai all'indietro`, s.distAlong >= prev - 1, [s.distAlong, prev]);
      prev = s.distAlong;
    }
    ck('mai agganciato al ramo di andata sulla via del ritorno', snapped === 0, snapped);
    ck('errore massimo di posizione < 45 m su tutta l\'andata e ritorno', worst < 45, worst);
    const s = await snap(p);
    ckNear('a fine ritorno mancano ~0', s.remaining.dist, 0, 60);
    ckNear('fatto ≈ totale', s.done.dist, route.totalDist, 60);
    // il pannello dice la verità sul ritorno: a metà ritorno mancano ~ un quarto
    note(`errore massimo ${worst.toFixed(1)} m su ${Math.round(route.totalDist)} m`);
  });
}
