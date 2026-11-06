// Orchestrazione: stato, GPS, tracker, wake lock, persistenza e collegamento tra mappa, profilo e interfaccia.
import { parseGpx, serializeGpx } from '../core/gpx.js';
import { buildRoute, remainingFrom, reverseSession, routeTimeSeconds, statsAt } from '../core/route.js';
import { mergeTracks, removeWaypoint, renameTrack, restoreOriginal, toggleReverse, trimTrack } from '../core/edit.js';
import { createTracker } from '../core/tracker.js';
import { activateUpdate, registerServiceWorker } from './offline.js';
import { angleDiffDeg, bearingForHeading, screenBearing } from '../core/heading.js';
import { createCompass } from './compass.js';
import { createMap } from './map.js';
import { createProfile } from './profile.js';
import { cardinal, createUi, fmtAgo, fmtClock, fmtKm } from './ui.js';
import * as store from './store.js';

const COLORS = ['#d62828', '#00838f', '#c2185b', '#6d4c41', '#827717', '#37474f'];
const FRESH_MS = 15000;
const PERSIST_EVERY_MS = 10000;
const COMPASS_STEP_MS = 100;
const NAV_DEADZONE_DEG = 1; // i passi più piccoli li assorbe lo smorzamento della mappa
const COMPASS_LOST_MS = 5000;
const GEO_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 };

const state = {
  tracks: [],
  route: null,
  tracker: null,
  snap: null,
  mode: 'totale',
  lastFix: null,
  gpsError: null,
  watchId: null,
  viewMode: 'free', // 'free' | 'follow' | 'nav'
  navBearing: 0, // rotazione applicata in nav
  navFallback: false, // nav con nord in alto per bussola inaffidabile
  unreliableSince: 0,
  mapBearing: 0,
  compassToasted: false,
  wakeLock: null,
  wakeWarned: false,
  lastPersist: 0,
  recoveryShown: false,
};

const uid = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
const errorText = (err) => err?.message || String(err);

// ---------- Route e tracker ----------
const routeSignature = (route) => `${route.points.length}|${Math.round(route.totalDist)}|${route.trackRanges.map((r) => r.trackId).join(',')}`;

/**
 * Ricostruisce la route dalle tracce visibili e ricrea il tracker.
 * `clear`: scarta lo stato (percorso invertito); altrimenti riallinea l'ultimo fix alla nuova route.
 */
function rebuildRoute({ clear = false } = {}) {
  const hasVisible = state.tracks.some((t) => t.visible);
  const route = hasVisible ? buildRoute(state.tracks) : null;
  state.route = route && route.points.length >= 2 ? route : null;
  state.tracker = state.route ? createTracker(state.route) : null;
  const fix = state.lastFix;
  if (state.tracker && fix && (!clear || Date.now() - fix.timestamp <= FRESH_MS)) state.tracker.ingestFix(fix);
}

function refreshViews({ fit = false } = {}) {
  ui.setTracks(state.tracks, state.route);
  map.setData(state.tracks, state.route);
  // Prima il pannello (cambia altezza tra "vuoto" e "numeri"), poi l'adattamento della vista: altrimenti
  // la traccia finisce sotto il pannello.
  render();
  if (fit) {
    leaveNav();
    map.fitTracks();
  }
}

/** Applica un nuovo elenco di tracce: ricostruisce, ridisegna e salva. */
async function applyTracks(tracks, { changed = [], removed = [], order = false, clear = false, fit = false } = {}) {
  state.tracks = tracks;
  rebuildRoute({ clear });
  refreshViews({ fit });
  await Promise.all([
    store.putTracks(changed),
    store.removeTracks(removed),
    order || removed.length ? store.setMeta('order', tracks.map((t) => t.id)) : null,
  ]);
}

const replaceTrack = (id, track) => state.tracks.map((t) => (t.id === id ? track : t));
const findTrack = (id) => state.tracks.find((t) => t.id === id);

// ---------- Posizione ----------
function currentPosition() {
  const snap = state.snap;
  if (snap?.source === 'stima' && snap.estimate) return snap.estimate;
  if (snap?.gps && (snap.quality === 'good' || snap.quality === 'weak')) return snap.gps;
  const fix = state.lastFix;
  return !snap && fix && Date.now() - fix.timestamp <= FRESH_MS && fix.accuracy <= 100 ? fix : null;
}

function onPosition(position) {
  const { latitude, longitude, accuracy, speed } = position.coords;
  ingestFix({ lat: latitude, lon: longitude, accuracy, timestamp: position.timestamp, ...(speed != null && { speed }) });
}

function ingestFix(fix) {
  state.gpsError = null;
  state.lastFix = fix;
  state.tracker?.ingestFix(fix);
  render();
}

function onGeoError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    stopWatch();
    state.gpsError = 'denied';
    ui.toast('Posizione negata. Abilitala in Impostazioni > Privacy e sicurezza > Localizzazione > Safari / Sentiero, poi tocca la barra di stato.', { error: true, ms: 10000 });
  }
  render();
}

function startWatch() {
  stopWatch();
  if (!navigator.geolocation) {
    state.gpsError = 'unsupported';
    render();
    return;
  }
  state.gpsError = null;
  state.watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, GEO_OPTIONS);
}

function stopWatch() {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
}

async function acquireWakeLock() {
  if (state.wakeLock || document.visibilityState !== 'visible') return;
  if (!('wakeLock' in navigator)) {
    if (!state.wakeWarned) {
      state.wakeWarned = true;
      ui.toast('Schermo sempre acceso non disponibile: imposta Impostazioni > Schermo e luminosità > Blocco automatico su Mai.', { error: true, ms: 10000 });
    }
    return;
  }
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch {
    state.wakeLock = null;
  }
}

// ---------- Modelli per l'interfaccia ----------
const recoveryText = (delta) => `GPS recuperato, eri ${Math.abs(delta)} m ${delta >= 0 ? 'oltre' : 'prima'} la stima`;

function statusModel(snap, now) {
  if (state.gpsError === 'denied') return { level: 'error', text: 'GPS non autorizzato: tocca per riprovare' };
  if (state.gpsError === 'unsupported') return { level: 'error', text: 'GPS non disponibile su questo dispositivo' };
  if (snap) {
    const accuracy = Math.round(snap.accuracy ?? 0);
    if (snap.justRecovered) {
      const delta = Math.round(snap.justRecovered.deltaM);
      return { level: 'ok', text: recoveryText(delta) };
    }
    switch (snap.quality) {
      case 'good': return { level: 'ok', text: `GPS ok ±${accuracy} m` };
      case 'weak': return { level: 'weak', text: `GPS debole ±${accuracy} m` };
      case 'lost': {
        if (snap.estimate && snap.lastSure) return { level: 'lost', text: `Stima: ultimo punto sicuro ${fmtAgo((now - snap.lastSure.timestamp) / 1000)} fa` };
        if (snap.lastSure) return { level: 'lost', text: `GPS perso, stima non disponibile (${snap.estimateUnavailableReason ?? 'dati insufficienti'})` };
        return { level: 'lost', text: 'GPS perso' };
      }
      default: return { level: 'wait', text: 'In attesa del GPS' };
    }
  }
  const fix = state.lastFix;
  if (!fix) return { level: 'wait', text: 'In attesa del GPS' };
  const fresh = now - fix.timestamp <= FRESH_MS;
  const accuracy = Math.round(fix.accuracy);
  if (fresh && fix.accuracy <= 30) return { level: 'ok', text: `GPS ok ±${accuracy} m` };
  if (fresh && fix.accuracy <= 100) return { level: 'weak', text: `GPS debole ±${accuracy} m` };
  return { level: 'lost', text: 'GPS perso' };
}

function bannerModel(snap) {
  if (!snap?.offTrack || (snap.source !== 'gps' && snap.source !== 'approssimata')) return null;
  const m = snap.offTrackM;
  const distance = m >= 1000 ? `${fmtKm(m)} km` : `${Math.round(m)} m`;
  // `bearing` è l'angolo sullo schermo (la freccia segue la rotazione); il testo resta geografico.
  return { text: `Sei a ${distance} dalla traccia, verso ${cardinal(snap.bearingToTrackDeg)}`, bearing: screenBearing(snap.bearingToTrackDeg, state.mapBearing) };
}

const SOURCE_CAPTION = {
  gps: 'Dalla tua posizione',
  approssimata: 'Da posizione approssimata',
  stima: 'Da posizione stimata',
  nessuna: 'Dall\'inizio (posizione non nota)',
};

function panelModel(snap) {
  const route = state.route;
  if (!route) {
    return {
      empty: true,
      emptyText: state.tracks.length ? 'Nessuna traccia visibile. Attivane una da Tracce.' : 'Nessuna traccia. Tocca Tracce per importare un file GPX.',
    };
  }
  const hasPosition = snap && snap.source !== 'nessuna';
  const scopeVisible = route.trackRanges.length > 1;
  const mode = scopeVisible ? state.mode : 'totale';
  const stage = mode === 'tappa';

  let rem;
  let caption = SOURCE_CAPTION[hasPosition ? snap.source : 'nessuna'];
  if (hasPosition && stage && snap.currentTrack) {
    rem = snap.currentTrack.remaining;
    caption += ` · ${snap.currentTrack.name}`;
  } else if (hasPosition) {
    rem = snap.remaining;
  } else {
    const range = stage ? route.trackRanges[0] : null;
    const from = range ? range.startDist : 0;
    const to = range ? range.endDist : route.totalDist;
    rem = { ...remainingFrom(route, from, to), etaSec: routeTimeSeconds(route, from, to) };
    if (range) caption += ` · ${range.name}`;
  }

  const profileLabel = hasPosition
    ? `fatti ${fmtKm(snap.done.dist)} km · mancano ${fmtKm(snap.remaining.dist)} km`
    : `percorso di ${fmtKm(route.totalDist)} km`;
  return { empty: false, scopeVisible, mode, caption, approx: snap?.source === 'stima', hasElevation: route.hasElevation, rem, profileLabel };
}

function profileModel(snap) {
  const pos = snap && snap.source !== 'nessuna' ? { dist: snap.distAlong, kind: snap.source === 'stima' ? 'stima' : 'gps' } : null;
  const estimate = snap?.quality === 'lost' ? snap.estimate : null;
  return {
    route: state.route,
    pos,
    band: estimate && { min: estimate.minDist, max: estimate.maxDist },
    sureDist: snap?.lastSure?.onTrack && snap.quality !== 'good' ? snap.lastSure.distAlong : null,
  };
}

function mapPositions(snap, now) {
  const fix = state.lastFix;
  let gps = null;
  if (snap) {
    if ((snap.quality === 'good' || snap.quality === 'weak') && snap.gps) gps = { ...snap.gps, weak: snap.quality === 'weak' };
  } else if (fix && now - fix.timestamp <= FRESH_MS && fix.accuracy <= 100) {
    gps = { ...fix, weak: fix.accuracy > 30 };
  }
  const showSure = snap?.lastSure && snap.quality !== 'good';
  return {
    gps,
    lastSure: showSure ? { lat: snap.lastSure.lat, lon: snap.lastSure.lon, label: fmtClock(snap.lastSure.timestamp) } : null,
    estimate: snap?.quality === 'lost' ? snap.estimate : null,
  };
}

function render() {
  const now = Date.now();
  const snap = state.tracker ? state.tracker.snapshot(now) : null;
  state.snap = snap;
  // Il rientro dalla stima si segnala anche con un avviso, una volta per rientro (la pillola torna normale dopo 30 s).
  if (snap?.justRecovered && !state.recoveryShown) {
    state.recoveryShown = true;
    ui.toast(recoveryText(Math.round(snap.justRecovered.deltaM)));
  } else if (!snap?.justRecovered) {
    state.recoveryShown = false;
  }
  ui.renderStatus(statusModel(snap, now));
  ui.renderBanner(bannerModel(snap));
  ui.renderPanel(panelModel(snap));
  map.setPositions(mapPositions(snap, now));
  const progress = snap && snap.source !== 'nessuna' ? snap.distAlong : null;
  const estimate = snap?.quality === 'lost' ? snap.estimate : null;
  map.setProgress(progress, estimate && { min: estimate.minDist, max: estimate.maxDist });
  profile.update(profileModel(snap));
  const pos = currentPosition();
  if (state.viewMode === 'follow' && pos) map.centerOn(pos.lat, pos.lon);
  else if (state.viewMode === 'nav') applyNav(pos);
}

function persistTracker(force = false) {
  const now = Date.now();
  if (!state.tracker || !state.lastFix || (!force && now - state.lastPersist < PERSIST_EVERY_MS)) return;
  state.lastPersist = now;
  store.setMeta('tracker', { sig: routeSignature(state.route), state: state.tracker.serialize() });
}

function tick() {
  render();
  persistTracker();
}

// ---------- Azioni dell'interfaccia ----------
function setViewMode(mode) {
  if (state.viewMode === mode) return;
  state.viewMode = mode;
  state.unreliableSince = 0;
  state.navFallback = false;
  if (mode === 'free') map.stopAnimation();
  ui.setViewMode(mode);
}

/** Prima di map.fitTracks: la navigazione ruota la mappa, l'adattamento ai bordi presuppone il nord in alto. */
function leaveNav(to = 'follow') {
  if (state.viewMode === 'nav') setViewMode(to);
}

/** Navigazione: rotazione dell'ultima lettura, utente in basso nell'area visibile. Senza posizione ruota soltanto. */
function applyNav(pos = currentPosition()) {
  if (pos) map.navigate(pos.lat, pos.lon, state.navBearing);
  else map.rotateTo(state.navBearing);
}

function notifyCompassOnce(message) {
  if (state.compassToasted) return;
  state.compassToasted = true;
  ui.toast(message);
}

// ---------- Bussola ----------
let rafId = 0;
let lastStepAt = 0;
const compassLive = () => compass.isActive() && document.visibilityState === 'visible';

/** Un passo del ciclo: cono di direzione e, in nav, rotazione (con zona morta). */
function compassStep() {
  const now = Date.now();
  const { deg, reliable } = compass.read(now);
  map.setHeading(reliable && deg !== null ? deg : null);
  if (state.viewMode !== 'nav') return;
  if (reliable && deg !== null) {
    const target = bearingForHeading(deg);
    const recovered = state.navFallback;
    state.unreliableSince = 0;
    state.navFallback = false;
    if (recovered || Math.abs(angleDiffDeg(state.navBearing, target)) > NAV_DEADZONE_DEG) {
      state.navBearing = target;
      applyNav();
    }
  } else if (!state.unreliableSince) {
    state.unreliableSince = now;
  } else if (!state.navFallback && now - state.unreliableSince >= COMPASS_LOST_MS) {
    state.navFallback = true;
    state.navBearing = 0;
    ui.toast('Bussola non affidabile: mappa con il nord in alto');
    applyNav();
  }
}

function compassLoop(ts) {
  rafId = 0;
  if (!compassLive()) return;
  if (ts - lastStepAt >= COMPASS_STEP_MS) {
    lastStepAt = ts;
    compassStep();
  }
  rafId = requestAnimationFrame(compassLoop);
}

/** Il ciclo gira solo con bussola attiva e pagina visibile. */
function syncCompassLoop() {
  if (compassLive()) {
    if (!rafId) rafId = requestAnimationFrame(compassLoop);
  } else if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  if (!compass.isActive()) map.setHeading(null);
}

async function readTrackFile(file, colorIndex) {
  const parsed = parseGpx(await file.text());
  return parsed.tracks.map((t, i) => ({
    id: uid(),
    name: t.name || file.name.replace(/\.gpx$/i, ''),
    color: COLORS[(colorIndex + i) % COLORS.length],
    visible: true,
    reversed: false,
    points: t.points,
    waypoints: t.waypoints ?? [],
    original: null,
  }));
}

const downloadName = (track) => `${track.name.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'traccia'}.gpx`;

const actions = {
  setMode(mode) {
    state.mode = mode;
    store.setMeta('mode', mode);
    render();
  },

  /** Pulsante a 3 stati: free -> follow -> nav -> free (nav solo con bussola utilizzabile). */
  locate() {
    // Sincrono dentro il click, prima di qualsiasi await: iOS altrimenti rifiuta il permesso.
    compass.request();
    const mode = state.viewMode;
    if (mode === 'nav') {
      setViewMode('free');
      return;
    }
    if (mode === 'follow') {
      if (compass.canNavigate()) {
        const { deg } = compass.read();
        state.navBearing = deg === null ? 0 : bearingForHeading(deg);
        setViewMode('nav');
        applyNav();
      } else {
        setViewMode('free');
        notifyCompassOnce(compass.status() === 'denied'
          ? 'Bussola non autorizzata: abilitala in Impostazioni > Safari > Movimento e orientamento. Navigazione non disponibile.'
          : 'Bussola non disponibile: modalità Navigazione non attiva.');
      }
      return;
    }
    const pos = currentPosition();
    if (!pos) {
      if (state.gpsError) startWatch();
      ui.toast('Posizione GPS non ancora disponibile.');
      map.fitTracks();
      return;
    }
    setViewMode('follow');
    map.setBearing(0);
    map.centerOn(pos.lat, pos.lon, Math.max(map.getView().zoom, 15));
  },

  /** Bussolina: nord in alto; da nav si passa a follow. */
  northUp() {
    map.setBearing(0);
    leaveNav('follow');
  },

  statusTap() {
    if (state.gpsError || state.watchId === null) startWatch();
  },

  async importFiles(files) {
    const added = [];
    const errors = [];
    for (const file of files) {
      try {
        added.push(...await readTrackFile(file, state.tracks.length + added.length));
      } catch (err) {
        errors.push({ name: file.name, message: errorText(err) });
      }
    }
    const hadRoute = state.route !== null;
    if (added.length) await applyTracks([...state.tracks, ...added], { changed: added, order: true, fit: !hadRoute });
    ui.showImportReport({ added: added.length, errors });
  },

  toggleVisible(id) {
    const track = findTrack(id);
    const next = { ...track, visible: !track.visible };
    return applyTracks(replaceTrack(id, next), { changed: [next] });
  },

  moveTrack(id, delta) {
    const from = state.tracks.findIndex((t) => t.id === id);
    const to = from + delta;
    if (to < 0 || to >= state.tracks.length) return null;
    const tracks = [...state.tracks];
    [tracks[from], tracks[to]] = [tracks[to], tracks[from]];
    return applyTracks(tracks, { order: true });
  },

  reverseTrack(id) {
    const next = toggleReverse(findTrack(id));
    return applyTracks(replaceTrack(id, next), { changed: [next] });
  },

  reverseAll() {
    const tracks = reverseSession(state.tracks);
    return applyTracks(tracks, { changed: tracks, order: true, clear: true });
  },

  async exportTrack(id) {
    const track = findTrack(id);
    const file = new File([serializeGpx(track)], downloadName(track), { type: 'application/gpx+xml' });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: track.name });
          return;
        } catch (err) {
          if (err.name === 'AbortError') return;
          // Condivisione non riuscita (es. blocco del gesto utente): ripiega sul download del file.
        }
      }
      const url = URL.createObjectURL(file);
      const link = Object.assign(document.createElement('a'), { href: url, download: file.name });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      if (err.name !== 'AbortError') ui.toast(`Esportazione non riuscita: ${errorText(err)}`, { error: true });
    }
  },

  deleteTrack(id) {
    return applyTracks(state.tracks.filter((t) => t.id !== id), { removed: [id] });
  },

  renameTrack(id, name) {
    const next = renameTrack(findTrack(id), name);
    return applyTracks(replaceTrack(id, next), { changed: [next] });
  },

  trimTrack(id, startIdx, endIdx) {
    const next = trimTrack(findTrack(id), startIdx, endIdx);
    return applyTracks(replaceTrack(id, next), { changed: [next] });
  },

  mergeNext(id) {
    const index = state.tracks.findIndex((t) => t.id === id);
    const a = state.tracks[index];
    const b = state.tracks[index + 1];
    const merged = mergeTracks(a, b, uid());
    const tracks = state.tracks.filter((t) => t.id !== b.id).map((t) => (t.id === a.id ? merged : t));
    return applyTracks(tracks, { changed: [merged], removed: a.id === merged.id ? [b.id] : [a.id, b.id], order: true });
  },

  removeWaypoint(id, index) {
    const next = removeWaypoint(findTrack(id), index);
    return applyTracks(replaceTrack(id, next), { changed: [next] });
  },

  restoreOriginal(id) {
    const next = restoreOriginal(findTrack(id));
    return applyTracks(replaceTrack(id, next), { changed: [next] });
  },

  previewTrim(points) {
    map.setPreview(points);
  },

  /** Porta la traccia nella parte di mappa non coperta da un foglio alto `height` px. */
  fitAboveSheet(height) {
    leaveNav('free');
    map.fitTracks(height);
  },
};

// ---------- Avvio ----------
const ui = createUi(actions);
const compass = createCompass({ onStatus: () => syncCompassLoop() });
const map = createMap(document.getElementById('map'), {
  getBottomInset: ui.getBottomInset,
  onUserMove: () => setViewMode('free'),
  onUserRotate: () => leaveNav('follow'),
  onBearingChange(deg) {
    state.mapBearing = deg;
    ui.setNorth(deg);
    // La freccia del banner segue subito la rotazione, senza aspettare il tick da 1 s.
    if (state.snap) ui.renderBanner(bannerModel(state.snap));
  },
  onViewChange: (() => {
    let timer = 0;
    return (view) => {
      clearTimeout(timer);
      timer = setTimeout(() => store.setMeta('view', view), 1000);
    };
  })(),
});
const profile = createProfile(document.getElementById('profile'), {
  onScrub(dist) {
    if (dist === null || !state.route) {
      ui.hideScrub();
      map.setCrosshair(null);
      return;
    }
    const here = statsAt(state.route, dist);
    const rest = remainingFrom(state.route, dist);
    const parts = [`km ${fmtKm(dist)}`];
    if (state.route.hasElevation) {
      parts.push(`${Math.round(here.ele)} m`, `D+ ${Math.round(rest.up)}`, `D− ${Math.round(rest.down)} da qui`);
    } else {
      parts.push(`mancano ${fmtKm(rest.dist)} km`);
    }
    ui.showScrub(parts.join(' · '));
    map.setCrosshair(here);
  },
});

async function start() {
  store.setStoreErrorHandler((message) => ui.toast(message, { error: true }));
  const saved = await store.loadAll();
  state.tracks = saved.tracks;
  if (saved.mode === 'tappa' || saved.mode === 'totale') state.mode = saved.mode;
  rebuildRoute();
  if (state.route && saved.tracker?.sig === routeSignature(state.route)) {
    state.tracker = createTracker(state.route, { restored: saved.tracker.state });
  }
  ui.setTracks(state.tracks, state.route);
  map.setData(state.tracks, state.route);
  if (saved.view) map.setView(saved.view);
  else map.fitTracks();
  render();

  registerServiceWorker({ onUpdate: async (reg) => { if (await ui.askUpdate()) activateUpdate(reg); } });
  setInterval(tick, 1000);

  if (!saved.welcomed) {
    await ui.showWelcome({ standalone: navigator.standalone === true || matchMedia('(display-mode: standalone)').matches });
    store.setMeta('welcomed', true);
  }
  startWatch();
  acquireWakeLock();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    acquireWakeLock();
    startWatch();
    state.unreliableSince = 0;
    syncCompassLoop();
    render();
  } else {
    syncCompassLoop();
    persistTracker(true);
  }
});
addEventListener('pagehide', () => persistTracker(true));
// Sul primo tocco riprova il blocco schermo, che su iOS può richiedere un gesto dell'utente.
addEventListener('pointerdown', () => acquireWakeLock(), { passive: true });
// Evita che il pizzico della pagina (iOS) si scontri con quello della mappa.
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (e) => e.preventDefault());

window.__sentiero = {
  tracks: () => state.tracks,
  snapshot: () => (state.tracker ? state.tracker.snapshot(Date.now()) : null),
  injectFix: (fix) => ingestFix({ accuracy: 10, timestamp: Date.now(), ...fix }),
  view: () => map.getView(),
  setView: (view) => map.setView(view),
  viewMode: () => state.viewMode,
  bearing: () => map.getBearing(),
};

start();
