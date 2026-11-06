// Persistenza in IndexedDB "sentiero": tracce (store `tracks`) e impostazioni (store `meta`).
// Ogni chiamata tollera gli errori: li segnala al gestore registrato e restituisce un valore neutro.

const DB_NAME = 'sentiero';
const DB_VERSION = 1;

let dbPromise = null;
let reportError = () => {};

/** @param {(message: string) => void} handler */
export function setStoreErrorHandler(handler) {
  reportError = handler;
}

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('IndexedDB non disponibile'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('tracks', { keyPath: 'id' });
      req.result.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('database bloccato da un\'altra scheda'));
  });
  return dbPromise;
}

/** Esegue `work(tracksStore, metaStore)` in una transazione; risolve con `work().result` a transazione conclusa. */
async function transact(mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['tracks', 'meta'], mode);
    const request = work(tx.objectStore('tracks'), tx.objectStore('meta'));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transazione annullata'));
  });
}

async function guarded(action, fallback, work) {
  try {
    return await work();
  } catch (err) {
    dbPromise = null;
    reportError(`Archivio locale: ${action} non riuscito (${err?.message ?? err})`);
    return fallback;
  }
}

/** @returns {Promise<{tracks: object[], mode: string|null, view: object|null, tracker: object|null, welcomed: boolean}>} */
export function loadAll() {
  return guarded('lettura', { tracks: [], mode: null, view: null, tracker: null, welcomed: false }, async () => {
    const db = await openDb();
    const tx = db.transaction(['tracks', 'meta'], 'readonly');
    const asPromise = (req) => new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const [stored, order, mode, view, tracker, welcomed] = await Promise.all([
      asPromise(tx.objectStore('tracks').getAll()),
      ...['order', 'mode', 'view', 'tracker', 'welcomed'].map((k) => asPromise(tx.objectStore('meta').get(k))),
    ]);
    const byId = new Map(stored.map((t) => [t.id, t]));
    const sorted = (order ?? []).filter((id) => byId.has(id)).map((id) => byId.get(id));
    const rest = stored.filter((t) => !(order ?? []).includes(t.id));
    return {
      tracks: [...sorted, ...rest],
      mode: mode ?? null,
      view: view ?? null,
      tracker: tracker ?? null,
      welcomed: welcomed === true,
    };
  });
}

/** @param {object[]} tracks */
export function putTracks(tracks) {
  if (!tracks.length) return Promise.resolve();
  return guarded('salvataggio tracce', undefined, () =>
    transact('readwrite', (store) => {
      for (const t of tracks) store.put(t);
    }));
}

/** @param {string[]} ids */
export function removeTracks(ids) {
  if (!ids.length) return Promise.resolve();
  return guarded('eliminazione tracce', undefined, () =>
    transact('readwrite', (store) => {
      for (const id of ids) store.delete(id);
    }));
}

/** @param {'order'|'mode'|'view'|'tracker'|'welcomed'} key */
export function setMeta(key, value) {
  return guarded('salvataggio impostazioni', undefined, () =>
    transact('readwrite', (_, meta) => meta.put(value, key)));
}
