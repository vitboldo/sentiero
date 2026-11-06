// Percorsi relativi allo scope del SW: funziona in una sottocartella (GitHub Pages).
const CACHE_VERSION = 'v4';
const SHELL_CACHE = `sentiero-shell-${CACHE_VERSION}`;
const TILE_OFFLINE = 'tiles-offline-v1';   // mai toccata qui: appartiene ai pacchetti dell'utente
const TILE_RUNTIME = 'tiles-runtime-v1';
const RUNTIME_MAX = 2000;
const TILE_HOST_SUFFIX = 'tile.opentopomap.org';

// Un file mancante qui deve far fallire l'installazione.
const CORE = [
  './',
  'index.html',
  'styles.css',
  'src/app/main.js', 'src/app/store.js', 'src/app/map.js', 'src/app/profile.js',
  'src/app/ui.js', 'src/app/offline.js', 'src/app/compass.js', 'src/app/theme.js',
  'src/core/gpx.js', 'src/core/geo.js', 'src/core/route.js', 'src/core/edit.js',
  'src/core/matcher.js', 'src/core/tracker.js', 'src/core/tiles.js', 'src/core/heading.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'vendor/leaflet-rotate/leaflet-rotate.js',
];
// Un file mancante qui non blocca l'installazione.
const OPTIONAL = [
  'manifest.webmanifest',
  'vendor/leaflet/images/layers.png', 'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png',
  'icons/apple-touch-icon.png',
];

const abs = (p) => new URL(p, self.registration.scope).href;
const INDEX_URL = () => abs('index.html');

async function fetchFresh(url) {
  const res = await fetch(new Request(url, { cache: 'reload' }));
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Mai skipWaiting qui: l'app aperta non deve cambiare sotto i piedi dell'utente.
    await Promise.all(CORE.map(async (p) => cache.put(abs(p), await fetchFresh(abs(p)))));
    await Promise.all(OPTIONAL.map(async (p) => {
      try { await cache.put(abs(p), await fetchFresh(abs(p))); } catch { /* opzionale */ }
    }));
    // './' e 'index.html' sono la stessa risorsa: le navigazioni usano index.html.
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('sentiero-shell-') && k !== SHELL_CACHE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === TILE_HOST_SUFFIX || url.hostname.endsWith('.' + TILE_HOST_SUFFIX)) {
    event.respondWith(handleTile(event, req));
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(event, req));
    return;
  }
  event.respondWith(handleShell(event, req));
});

// La shell si aggiorna solo in blocco, cambiando CACHE_VERSION: aggiornare i file uno a uno
// con rete instabile può lasciare moduli di versioni diverse e impedire l'avvio dell'app.
async function handleShell(event, req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  return hit || fetch(req);
}

async function handleNavigation(event, req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(INDEX_URL());
  if (hit) return hit;
  try {
    return await fetch(req);
  } catch {
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function handleTile(event, req) {
  // ignoreVary: la tile salvata con fetch CORS non deve fallire il match per l'header Origin.
  const offline = await caches.open(TILE_OFFLINE);
  const off = await offline.match(req.url, { ignoreVary: true });
  if (off) return off;

  const runtime = await caches.open(TILE_RUNTIME);
  const rt = await runtime.match(req.url, { ignoreVary: true });
  if (rt) return rt;

  try {
    // Richiesta CORS (l'<img> di Leaflet sarebbe opaca): così si può verificare ok e tipo prima di salvare.
    const res = await fetch(req.url, { mode: 'cors', credentials: 'omit' });
    if (res.ok) {
      const ct = res.headers.get('Content-Type') || '';
      // Le richieste CORS arrivano dal download dei pacchetti (offline.js), che salva già le tile nella
      // propria cache: non vanno duplicate nella cache runtime (si riempirebbe di 2000 tile non richieste).
      if (ct.startsWith('image/') && req.mode !== 'cors') {
        event.waitUntil((async () => {
          try {
            await runtime.put(req.url, res.clone());
            await trimRuntime(runtime);
          } catch { /* quota: la tile viene comunque servita */ }
        })());
      }
      return res;
    }
  } catch { /* offline */ }
  // 504 -> Leaflet emette tileerror e usa la tile antenata.
  return new Response('', { status: 504, statusText: 'Tile non disponibile offline' });
}

async function trimRuntime(cache) {
  const keys = await cache.keys(); // ordine di inserimento = FIFO
  for (let i = 0; i < keys.length - RUNTIME_MAX; i++) await cache.delete(keys[i]);
}
