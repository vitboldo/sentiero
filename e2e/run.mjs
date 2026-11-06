// E2E di Sentiero. Uso: `npm run e2e [-- --only=1,3 --engine=webkit]`.
// Ogni scenario dichiara il motore su cui gira; il riepilogo finale lo riporta.
import './harness.mjs';
import { closeBrowsers, results, session, startStatic } from './harness.mjs';
import { scenariosA } from './scenarios-a.mjs';
import { scenariosA2 } from './scenarios-a2.mjs';
import { scenariosB } from './scenarios-b.mjs';
import { scenariosC, scenariosPerf } from './scenarios-c.mjs';

const srv = await startStatic();
console.log(`server statico su ${srv.origin}`);
try {
  await scenariosA();
  await scenariosA2();
  await scenariosB();
  await scenariosC();
  await scenariosPerf();
} finally {
  await closeBrowsers();
  await session.srv.close();
}

console.log('\n================ RIEPILOGO ================');
let assertions = 0;
for (const r of results) {
  assertions += r.assertions;
  console.log(`${r.status.toUpperCase().padEnd(8)} [${r.id}] ${r.name} (${r.engine}) - ${r.assertions} controlli${r.note ? ` | ${r.note}` : ''}`);
  for (const f of r.failures) console.log(`           x ${f}`);
}
const ran = results.filter((r) => r.status !== 'not-run');
const failed = results.filter((r) => r.status === 'fail');
console.log(`Scenari eseguiti: ${ran.length}, passati: ${ran.length - failed.length}, falliti: ${failed.length}, non eseguiti: ${results.length - ran.length}; controlli: ${assertions}`);
console.log(`Richieste reali a opentopomap.org in tutta la sessione: ${session.realTiles} (massimo ${session.REAL_TILE_CAP})`);
process.exit(failed.length ? 1 : 0);
