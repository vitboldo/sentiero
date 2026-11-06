// Mappe offline. I download girano nella pagina, non nel service worker:
// iOS termina i lavori in background del SW dopo pochi secondi.
import { tilesForCorridor, estimateBytes, PRECISION_PRESETS, MAX_TILES, tileUrl } from '../core/tiles.js';
import { effectivePoints } from '../core/route.js';

export const TILE_CACHE = 'tiles-offline-v1';
const DB_NAME = 'sentiero-offline';
const STORE = 'packages';
const MIN_ZOOM = 10;
const CONCURRENCY = 2;
const START_GAP_MS = 150;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;
const SUSPEND_AFTER_CONSECUTIVE = 5;

/** @typedef {{z:number,x:number,y:number}} Tile */

// ---------- Service worker ----------

/**
 * @param {{onUpdate?:(reg:ServiceWorkerRegistration)=>void}} [opts]
 * @returns {Promise<ServiceWorkerRegistration|null>}
 */
export async function registerServiceWorker({ onUpdate } = {}) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    if (!reg) return null;
    const notify = () => {
      // Un SW "waiting" con un controller attivo = aggiornamento pronto, in attesa dell'ok della UI.
      if (reg.waiting && navigator.serviceWorker.controller && onUpdate) onUpdate(reg);
    };
    notify();
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      // La pagina era già controllata da una versione precedente? Va deciso ora, prima che un SW alla
      // prima installazione faccia clients.claim(): altrimenti la prima apertura mostra un falso "Aggiornamento".
      const wasControlled = !!navigator.serviceWorker.controller;
      if (w) w.addEventListener('statechange', () => { if (w.state === 'installed' && wasControlled) notify(); });
    });
    return reg;
  } catch (e) {
    console.warn('Service worker non registrato', e);
    return null;
  }
}

/** Da chiamare solo su azione esplicita dell'utente: attiva il nuovo SW e ricarica una volta. */
export function activateUpdate(reg) {
  if (!reg || !reg.waiting) return;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
  reg.waiting.postMessage({ type: 'SKIP_WAITING' });
}

// ---------- IndexedDB ----------

function reqP(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('Database offline bloccato da un\'altra scheda.'));
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, mode);
    const out = await fn(tx.objectStore(STORE));
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
    return out;
  } finally {
    db.close();
  }
}

const getAll = () => withStore('readonly', (s) => reqP(s.getAll()));
const putPkg = (pkg) => withStore('readwrite', (s) => reqP(s.put(pkg)));

// ---------- Utilità ----------

const keyOf = (t) => `${t.z}/${t.x}/${t.y}`;
const tileOf = (k) => { const [z, x, y] = k.split('/').map(Number); return { z, x, y }; };

function newId() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms, signal) {
  return new Promise((res) => {
    if (signal && signal.aborted) return res();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); res(); }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

function isQuotaError(e) {
  return !!e && (e.name === 'QuotaExceededError' || e.code === 22 || /quota/i.test(String(e.message || '')));
}

const isAbort = (e) => !!e && e.name === 'AbortError';

/** Corpo non vuoto che inizia come PNG o JPEG: una pagina HTML d'errore con 200 non deve contare come tile. */
async function looksLikeImage(blob) {
  if (blob.size < 64) return false;
  const b = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const jpg = b[0] === 0xff && b[1] === 0xd8;
  return png || jpg;
}

// ---------- API ----------

/**
 * @param {Array<object>} tracks Track da scaricare (tipicamente le visibili)
 * @param {{presetId:string,bufferM:number}} opts
 */
export function planDownload(tracks, { presetId, bufferM }) {
  const preset = PRECISION_PRESETS.find((p) => p.id === presetId) || PRECISION_PRESETS[1];
  const points = [];
  for (const t of tracks || []) for (const p of effectivePoints(t)) points.push(p);
  if (!points.length) return { tiles: [], count: 0, bytes: 0, tooMany: false, presetId: preset.id, bufferM };
  const tiles = tilesForCorridor(points, { minZoom: MIN_ZOOM, maxZoom: preset.maxZoom, bufferM });
  return {
    tiles, count: tiles.length, bytes: estimateBytes(tiles),
    tooMany: tiles.length > MAX_TILES, presetId: preset.id, bufferM,
  };
}

/**
 * @param {string} name
 * @param {ReturnType<typeof planDownload>} plan
 * @param {{onProgress?:Function, signal?:AbortSignal}} [opts]
 * @returns {Promise<{done:number,failed:number,skipped:number,aborted:boolean,suspended?:boolean}>}
 */
export async function startDownload(name, plan, { onProgress, signal } = {}) {
  if (plan.tooMany || plan.count > MAX_TILES) {
    throw new Error(`Troppe tile (${plan.count}): il massimo è ${MAX_TILES}. Riduci la precisione o la fascia.`);
  }
  const tiles = plan.tiles;
  const total = tiles.length;
  const cache = await caches.open(TILE_CACHE);

  // Stesso nome = riprendi/aggiorna lo stesso pacchetto, senza duplicare i riferimenti alle tile.
  const existing = (await getAll()).find((p) => p.name === name);
  const pkg = {
    id: existing ? existing.id : newId(),
    name,
    presetId: plan.presetId,
    bufferM: plan.bufferM,
    createdAt: existing ? existing.createdAt : Date.now(),
    tiles: [...new Set([...(existing ? existing.tiles : []), ...tiles.map(keyOf)])],
    count: 0, bytes: 0, failed: 0,
  };

  const st = { done: 0, failed: 0, skipped: 0, bytes: 0, processed: 0 };
  let fatal = null;        // QuotaExceededError o altro errore bloccante
  let suspended = false;
  let consecutiveServerTrouble = 0;
  let nextStart = 0;
  let cursor = 0;
  const stop = () => !!(signal && signal.aborted) || !!fatal || suspended;

  const snapshotPkg = () => {
    pkg.count = st.done + st.skipped;
    pkg.failed = st.failed;
    pkg.bytes = st.bytes + estimateBytes(new Array(st.skipped));
  };
  await putPkg((snapshotPkg(), pkg)); // salvato subito: se iOS uccide la pagina le tile in cache restano referenziate

  const report = () => { if (onProgress) onProgress({ done: st.done, total, failed: st.failed, skipped: st.skipped }); };

  /** @returns {Promise<'ok'|'fail'|'server'|'abort'>} */
  async function fetchTile(tile) {
    const url = tileUrl(tile);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (signal && signal.aborted) return 'abort';
      let serverTrouble = false;
      try {
        const res = await fetch(url, { mode: 'cors', credentials: 'omit', signal });
        if (res.ok) {
          const blob = await res.blob();
          if (!(await looksLikeImage(blob))) return 'fail';
          await cache.put(url, new Response(blob, {
            status: 200, headers: { 'Content-Type': res.headers.get('Content-Type') || 'image/png' },
          }));
          st.bytes += blob.size;
          return 'ok';
        }
        if (res.status !== 429 && res.status < 500) return 'fail'; // 404 ecc.: inutile riprovare
        serverTrouble = true;
      } catch (e) {
        if (isAbort(e) || (signal && signal.aborted)) return 'abort';
        if (isQuotaError(e)) throw e;
        serverTrouble = true; // errore di rete
      }
      if (attempt < MAX_ATTEMPTS - 1) await sleep(BACKOFF_BASE_MS * 2 ** attempt, signal);
      else if (serverTrouble) return 'server';
    }
    return 'fail';
  }

  async function worker() {
    while (!stop() && cursor < total) {
      const tile = tiles[cursor++];
      // Rispetto del server: almeno 150 ms tra un avvio e l'altro, anche tra i worker.
      const now = Date.now();
      const startAt = Math.max(now, nextStart);
      nextStart = startAt + START_GAP_MS;
      if (startAt > now) await sleep(startAt - now, signal);
      if (stop()) { cursor--; break; }

      let outcome;
      try {
        const hit = await cache.match(tileUrl(tile), { ignoreVary: true });
        if (hit) {
          st.skipped++;
          outcome = 'skip';
        } else {
          outcome = await fetchTile(tile);
        }
      } catch (e) {
        fatal = fatal || e;
        break;
      }
      if (outcome === 'abort') break;
      if (outcome === 'ok') { st.done++; consecutiveServerTrouble = 0; }
      else if (outcome === 'fail') { st.failed++; consecutiveServerTrouble = 0; }
      else if (outcome === 'server') {
        st.failed++;
        if (++consecutiveServerTrouble >= SUSPEND_AFTER_CONSECUTIVE) suspended = true;
      }
      st.processed++;
      report();
      if (st.processed % 50 === 0) { snapshotPkg(); putPkg(pkg).catch(() => {}); }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  snapshotPkg();
  await putPkg(pkg);

  if (fatal) {
    if (isQuotaError(fatal)) {
      const err = new Error('Spazio esaurito sul dispositivo: download interrotto. Le tile già scaricate sono salvate; libera spazio o riduci precisione e fascia, poi riprendi.');
      err.name = 'QuotaExceededError';
      throw err;
    }
    throw fatal;
  }
  report();
  return {
    done: st.done, failed: st.failed, skipped: st.skipped,
    aborted: !!(signal && signal.aborted) || suspended,
    suspended,
  };
}

export async function listPackages() {
  const all = await getAll();
  return all
    .map(({ id, name, count, bytes, failed, createdAt, presetId }) => ({ id, name, count, bytes, failed, createdAt, presetId }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function deletePackage(id) {
  const all = await getAll();
  const target = all.find((p) => p.id === id);
  if (!target) return;
  const keep = new Set();
  for (const p of all) if (p.id !== id) for (const k of p.tiles) keep.add(k);
  const cache = await caches.open(TILE_CACHE);
  for (const k of target.tiles) {
    if (!keep.has(k)) await cache.delete(tileUrl(tileOf(k)), { ignoreVary: true });
  }
  await withStore('readwrite', (s) => reqP(s.delete(id)));
}

export async function storageInfo() {
  const out = { usageBytes: 0, quotaBytes: 0, persisted: false };
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      out.usageBytes = e.usage || 0;
      out.quotaBytes = e.quota || 0;
    }
    if (navigator.storage && navigator.storage.persisted) out.persisted = await navigator.storage.persisted();
  } catch { /* stima non disponibile */ }
  return out;
}

export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* ignorato */ }
  return false;
}
