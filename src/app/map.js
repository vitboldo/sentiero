// Mappa Leaflet: tile con ripiego su antenate, tracce, frecce, marcatori GPS / ultimo punto sicuro / stima.
import { TILE_URL } from '../core/tiles.js';
import { effectivePoints, statsAt } from '../core/route.js';
import { bearingDeg } from '../core/geo.js';
import { normalizeDeg, angleDiffDeg, rotateOffset, dampStep, dampAngleStep } from '../core/heading.js';

const L = window.L;

const ATTRIBUTION = 'Kartendaten: © OpenStreetMap-Mitwirkende, SRTM | Kartendarstellung: © OpenTopoMap (CC-BY-SA)';
const MAX_ZOOM = 17;
const MAX_ANCESTOR_STEPS = 5;
const ARROW_SPACING_M = 500;
const MAX_ARROWS_IN_VIEW = 120;
const PREVIEW_MAX_POINTS = 1500;
const NAV_USER_FRACTION = 0.7; // in navigazione l'utente sta al 70% dell'altezza visibile
const MOVEEND_DEBOUNCE_MS = 200;
const MOVEEND_MAX_WAIT_MS = 1000;
const ROTATE_REFRESH_MS = 150;
const SNAP_NORTH_DEG = 5;
const USER_ROTATE_DEG = 8;
// Motore di animazione (solo visivo): costanti di tempo dello smorzamento esponenziale e soglie.
const TAU_ROT_MS = 120;
const TAU_POS_MS = 350;
const JUMP_M = 150; // oltre questa distanza (o oltre lo schermo) niente animazione
const DONE_PX = 0.2; // sotto questa distanza a schermo l'obiettivo è raggiunto
const DONE_DEG = 0.05;
const MAX_DT_MS = 100;
const TILE_REFRESH_MS = 250;
const PAN_REDRAW_FRACTION = 0.15; // spostamento netto (frazione dello schermo) dopo cui si ricentra il canvas
const WORK_MOVE_FRACTION = 0.1; // durante un'animazione lunga frecce e salvataggio si aggiornano dopo questo spostamento
const WORK_ROTATE_DEG = 15;
const LINE = { interactive: false, smoothFactor: 1.5 };

const loadImage = (url) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = url;
});

/** TileLayer che, se la tile manca, disegna la tile antenata (fino a z-5) ritagliata e ingrandita. */
const FallbackTileLayer = L.TileLayer.extend({
  createTile(coords, done) {
    const size = this.getTileSize();
    const tile = document.createElement('canvas');
    tile.width = size.x;
    tile.height = size.y;
    this._paint(tile, coords).then(() => done(null, tile), (err) => done(err, tile));
    return tile;
  },

  async _paint(tile, { x, y, z }) {
    const ctx = tile.getContext('2d');
    const size = tile.width;
    for (let dz = 0; dz <= MAX_ANCESTOR_STEPS && z - dz >= 0; dz++) {
      const ax = x >> dz;
      const ay = y >> dz;
      let img;
      try {
        img = await loadImage(L.Util.template(this._url, { x: ax, y: ay, z: z - dz }));
      } catch {
        continue;
      }
      if (dz === 0) {
        ctx.drawImage(img, 0, 0, size, size);
      } else {
        const sub = size / 2 ** dz;
        ctx.drawImage(img, (x - (ax << dz)) * sub, (y - (ay << dz)) * sub, sub, sub, 0, 0, size, size);
      }
      return;
    }
    throw new Error('tile non disponibile');
  },
});

const lowerBound = (arr, v) => {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/** Tratto di route tra due distanze, spezzato ai salti tra tracce. */
function sliceRoute(route, d0, d1) {
  const { points, cumDist } = route;
  const lo = lowerBound(cumDist, d0);
  const hi = lowerBound(cumDist, d1);
  const segments = [];
  let current = null;
  let currentId = null;
  const push = (p, trackId) => {
    if (!current || trackId !== currentId) {
      current = [];
      currentId = trackId;
      segments.push(current);
    }
    current.push([p.lat, p.lon]);
  };
  if (hi <= lo) return segments;
  if (lo > 0 && points[lo - 1].trackId === points[lo].trackId) push(statsAt(route, d0), points[lo].trackId);
  for (let i = lo; i < hi; i++) push(points[i], points[i].trackId);
  if (hi < points.length && points[hi - 1].trackId === points[hi].trackId) push(statsAt(route, d1), points[hi].trackId);
  return segments;
}

/** Posizioni delle frecce di direzione, ogni ~500 m lungo la route. */
function computeArrows(route) {
  const arrows = [];
  if (!route) return arrows;
  const { points, cumDist } = route;
  let next = ARROW_SPACING_M / 2;
  for (let i = 1; i < points.length; i++) {
    if (points[i].trackId !== points[i - 1].trackId) {
      next = cumDist[i] + ARROW_SPACING_M / 2;
      continue;
    }
    if (cumDist[i] < next) continue;
    let j = i + 1;
    while (j < points.length - 1 && points[j].trackId === points[i].trackId && cumDist[j] - cumDist[i] < 30) j++;
    const forward = j < points.length && points[j].trackId === points[i].trackId;
    const bearing = forward ? bearingDeg(points[i], points[j]) : bearingDeg(points[i - 1], points[i]);
    arrows.push({ lat: points[i].lat, lon: points[i].lon, bearing, dist: cumDist[i] });
    next = cumDist[i] + ARROW_SPACING_M;
  }
  return arrows;
}

const arrowIcons = new Map();
function arrowIcon(bearing) {
  const key = Math.round(bearing / 15) * 15;
  if (!arrowIcons.has(key)) {
    arrowIcons.set(key, L.divIcon({
      className: 'mk-arrow',
      html: `<svg viewBox="0 0 24 24" style="transform:rotate(calc(${key}deg + var(--map-bearing, 0deg)))"><path d="M12 2 20 21l-8-5-8 5z"/></svg>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    }));
  }
  return arrowIcons.get(key);
}

/** Icona quadrata centrata sul punto. */
const dotIcon = (className, size, text) => {
  const el = document.createElement('div');
  el.className = className;
  if (text) el.textContent = text;
  return L.divIcon({ className: '', html: el, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
};

/**
 * @param {HTMLElement} el
 * @param {{getBottomInset: () => number, onUserMove: () => void, onViewChange: (v:{lat:number,lon:number,zoom:number,bearing:number}) => void,
 *   onUserRotate?: () => void, onBearingChange?: (deg:number) => void}} hooks
 */
export function createMap(el, { getBottomInset, onUserMove, onViewChange, onUserRotate, onBearingChange }) {
  const renderer = L.canvas({ padding: 0.3 });
  const map = L.map(el, { maxZoom: MAX_ZOOM, minZoom: 4, renderer, zoomControl: false, attributionControl: true, rotate: true, touchRotate: true, rotateControl: false, bearing: 0 });
  map.attributionControl.setPrefix(false);

  // ---- API PRIVATA del plugin, isolata qui ----
  // setBearing() ricalcola _pixelOrigin da getCenter(): dopo uno spostamento del pannello il valore cambia di ~1e-9 px
  // per arrotondamento. I renderer lo confrontano con equals() e a ogni passo riproiettano TUTTE le polilinee
  // (_onZoomEnd) e ridisegnano il canvas (misurato: ~35 ms a passo con 10.000 punti, Chromium CPU x4; con questo ~3 ms).
  // Se l'origine è cambiata di meno di 0,01 px rimetto quella di prima. Il listener deve essere registrato PRIMA
  // di quelli dei renderer (che nascono con la prima polilinea).
  let lastOrigin = null;
  map.on('rotate', () => {
    const o = map._pixelOrigin;
    if (!o) return;
    if (lastOrigin && o !== lastOrigin && Math.abs(o.x - lastOrigin.x) < 0.01 && Math.abs(o.y - lastOrigin.y) < 0.01) map._pixelOrigin = lastOrigin;
    else lastOrigin = o;
  });
  L.control.zoom({ position: 'topright', zoomInText: '+', zoomOutText: '−' }).addTo(map);
  const tileLayer = new FallbackTileLayer(TILE_URL, {
    maxZoom: MAX_ZOOM,
    maxNativeZoom: MAX_ZOOM,
    attribution: ATTRIBUTION,
    updateWhenIdle: true,
    keepBuffer: 3,
  }).addTo(map);
  map.setView([46.0, 11.0], 7);

  const tracksLayer = L.layerGroup().addTo(map);
  const marksLayer = L.layerGroup().addTo(map);
  const arrowLayer = L.layerGroup().addTo(map);
  const doneLine = L.polyline([], { ...LINE, renderer, color: '#374151', weight: 6, opacity: 0.9 }).addTo(map);
  const estimateLine = L.polyline([], { ...LINE, renderer, color: '#c24a00', weight: 13, opacity: 0.6 }).addTo(map);
  const previewLine = L.polyline([], { ...LINE, renderer, color: '#ff00aa', weight: 9, opacity: 0.85 }).addTo(map);

  const markerOpts = { interactive: false, keyboard: false };
  const accuracyCircle = L.circle([0, 0], { renderer, interactive: false, radius: 1, color: '#0057d9', weight: 1, fillColor: '#0057d9', fillOpacity: 0.12 });
  // Cono di direzione: SECONDO figlio dell'icona (il primo resta il pallino). Ricreato a ogni aggiunta del marcatore.
  let heading = null;
  const applyHeading = (node) => {
    if (!node) return;
    node.classList.toggle('has-heading', heading !== null);
    if (heading !== null) node.style.setProperty('--heading', `${heading}deg`);
  };
  const GpsIcon = L.DivIcon.extend({
    createIcon(old) {
      const div = L.DivIcon.prototype.createIcon.call(this, old);
      if (div.children.length < 2) {
        const cone = document.createElement('div');
        cone.className = 'mk-cone';
        div.append(cone);
      }
      applyHeading(div);
      return div;
    },
  });
  const gpsDot = Object.assign(document.createElement('div'), { className: 'mk-gps' });
  const gpsIcon = new GpsIcon({ className: '', html: gpsDot, iconSize: [24, 24], iconAnchor: [12, 12] });
  const gpsMarker = L.marker([0, 0], { ...markerOpts, icon: gpsIcon, zIndexOffset: 1000 });
  const sureMarker = L.marker([0, 0], { ...markerOpts, zIndexOffset: 500 });
  const estimateMarker = L.marker([0, 0], { ...markerOpts, icon: dotIcon('mk-est', 38, '~'), zIndexOffset: 600 });
  const crossMarker = L.marker([0, 0], { ...markerOpts, icon: dotIcon('mk-cross', 48), zIndexOffset: 2000 });
  let sureLabel = null;

  let route = null;
  let arrows = [];
  let bounds = null;
  let doneDist = null;
  let arrowDoneDist = null;
  let bandKey = '';
  let accuracyKey = '';

  const place = (layer, latlng) => {
    if (!latlng) {
      layer.remove();
      return;
    }
    layer.setLatLng(latlng);
    if (!map.hasLayer(layer)) layer.addTo(map);
  };

  function drawArrows() {
    arrowLayer.clearLayers();
    const view = map.getBounds().pad(0.1);
    const zoom = map.getZoom();
    const stride = zoom >= 15 ? 1 : zoom >= 13 ? 2 : zoom >= 11 ? 4 : 8;
    let shown = 0;
    for (let i = 0; i < arrows.length && shown < MAX_ARROWS_IN_VIEW; i += stride) {
      const a = arrows[i];
      if (!view.contains([a.lat, a.lon])) continue;
      arrowLayer.addLayer(L.marker([a.lat, a.lon], { ...markerOpts, icon: arrowIcon(a.bearing), opacity: a.dist < (doneDist ?? 0) ? 0.35 : 1 }));
      shown++;
    }
    arrowDoneDist = doneDist;
  }

  function addTrack(track) {
    const pts = effectivePoints(track);
    if (!pts.length) return null;
    const latlngs = pts.map((p) => [p.lat, p.lon]);
    tracksLayer.addLayer(L.polyline(latlngs, { ...LINE, renderer, color: '#ffffff', weight: 11, opacity: 0.85 }));
    tracksLayer.addLayer(L.polyline(latlngs, { ...LINE, renderer, color: track.color, weight: 6, opacity: 1 }));
    const first = pts[0];
    const last = pts[pts.length - 1];
    marksLayer.addLayer(L.marker([first.lat, first.lon], { ...markerOpts, icon: dotIcon('mk-start', 26, 'P') }));
    marksLayer.addLayer(L.marker([last.lat, last.lon], { ...markerOpts, icon: dotIcon('mk-end', 26, 'A') }));
    for (const wp of track.waypoints ?? []) {
      const wpEl = document.createElement('div');
      wpEl.className = 'mk-wp';
      const label = document.createElement('span');
      label.textContent = wp.name;
      wpEl.append(label);
      marksLayer.addLayer(L.marker([wp.lat, wp.lon], { ...markerOpts, icon: L.divIcon({ className: '', html: wpEl, iconSize: [14, 14], iconAnchor: [7, 7] }) }));
    }
    return latlngs;
  }

  function extendBounds(latlngs) {
    for (const [lat, lon] of latlngs) {
      if (!bounds) bounds = L.latLngBounds([lat, lon], [lat, lon]);
      else bounds.extend([lat, lon]);
    }
  }

  // ---- Rotazione: stato, gesti, lavoro rimandato ----
  let gesturing = false;
  let gestureStartBearing = 0;
  let programmatic = 0; // >0 mentre l'app stessa muove la mappa
  let moveTimer = 0;
  let moveFirstAt = 0;
  let rotateTimer = 0;
  let lastBearing = 0;

  const currentBearing = () => normalizeDeg(map.getBearing());
  const blocked = () => gesturing || map._animatingZoom;
  const programmaticly = (fn) => {
    programmatic++;
    try {
      return fn();
    } finally {
      programmatic--;
    }
  };

  let workView = null; // vista all'ultimo lavoro di fine movimento (frecce, salvataggio)
  let workAt = 0;
  const onMoveEnd = () => {
    workView = { c: map.project(map.getCenter()), z: map.getZoom(), b: currentBearing() };
    drawArrows();
    const c = map.getCenter();
    onViewChange({ lat: c.lat, lon: c.lng, zoom: map.getZoom(), bearing: currentBearing() });
  };
  // Cambi programmatici: lavoro accorpato (debounce con attesa massima), niente ricalcoli a ogni chiamata.
  const scheduleMoveEnd = () => {
    const now = performance.now();
    if (!moveTimer) moveFirstAt = now;
    clearTimeout(moveTimer);
    const wait = Math.max(0, Math.min(MOVEEND_DEBOUNCE_MS, moveFirstAt + MOVEEND_MAX_WAIT_MS - now));
    moveTimer = setTimeout(() => {
      moveTimer = 0;
      onMoveEnd();
    }, wait);
  };
  map.on('dragstart', () => {
    clearTargets(); // il dito comanda: niente obiettivo di mappa
    onUserMove();
  });
  map.on('moveend', () => {
    panNet = { x: 0, y: 0 };
    if (programmatic) {
      scheduleMoveEnd();
      return;
    }
    clearTimeout(moveTimer);
    moveTimer = 0;
    onMoveEnd();
  });
  map.on('zoomend', () => {
    el.classList.toggle('zoom-low', map.getZoom() < 13);
    wakeIfBusy(); // fine dell'animazione di zoom: il motore riparte
  });

  // Dopo una rotazione restano angoli senza tile: un moveend (rimandato) li fa caricare.
  const refreshAfterRotate = () => {
    clearTimeout(rotateTimer);
    rotateTimer = setTimeout(() => {
      if (!gesturing) programmaticly(() => map.fire('moveend'));
    }, ROTATE_REFRESH_MS);
  };
  map.on('rotate', () => {
    const b = currentBearing();
    el.style.setProperty('--map-bearing', `${b}deg`);
    refreshAfterRotate();
    if (b !== lastBearing) {
      lastBearing = b;
      onBearingChange?.(b);
    }
  });

  // Gesto a due dita: il plugin non emette eventi di inizio/fine, li ricavo dai touch.
  const finishGesture = () => {
    gesturing = false;
    const now = currentBearing();
    if (gestureStartBearing === 0 && Math.abs(angleDiffDeg(0, now)) < SNAP_NORTH_DEG) {
      if (now !== 0) programmaticly(() => map.setBearing(0));
    } else if (Math.abs(angleDiffDeg(gestureStartBearing, now)) > USER_ROTATE_DEG) {
      onUserRotate?.();
    }
    refreshAfterRotate();
    wakeIfBusy();
  };
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2 || gesturing) return;
    gesturing = true;
    gestureStartBearing = currentBearing();
    rotTarget = null; // la rotazione è delle dita
    cancelAnimationFrame(animRaf);
    animRaf = 0;
  }, { passive: true });
  const onTouchEnd = (e) => {
    if (!gesturing || e.touches.length >= 2) return;
    // Il plugin chiude il suo gesto (e avvia l'animazione di zoom) sullo stesso evento: aspetto che finisca.
    setTimeout(() => {
      if (map._animatingZoom) map.once('zoomend', finishGesture);
      else finishGesture();
    }, 0);
  };
  document.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('touchcancel', onTouchEnd, { passive: true });

  new ResizeObserver(() => map.invalidateSize()).observe(el);

  /** Centro della mappa che porta il punto sulla posizione schermo (px da el) indicata. */
  const centerFor = (lat, lon, zoom, screenX, screenY) => {
    const size = map.getSize();
    const d = rotateOffset(size.x / 2 - screenX, size.y / 2 - screenY, -currentBearing());
    return map.unproject(map.project([lat, lon], zoom).add([d.x, d.y]), zoom);
  };
  const visibleHeight = () => Math.max(1, map.getSize().y - getBottomInset());

  // ---- Motore di animazione (solo visivo) ----
  // Obiettivi: rotazione (rotTarget), pallino GPS (dot) e "fuoco" della mappa (focus: un punto tenuto a una posizione
  // dello schermo, l'ancora). Ogni passo li avvicina con smorzamento esponenziale dipendente da dt (heading.js).
  // Il ciclo rAF gira solo finché c'è qualcosa da muovere. Durante l'animazione la mappa si sposta con _rawPanBy
  // senza moveend: il lavoro di fine movimento (frecce, salvataggio, tile) è accorpato alla fine.
  // I dati (stime, ultimo punto sicuro, valori per pannello e tracker) non passano di qui: restano esatti.
  let rotTarget = null; // gradi, null = nessuna rotazione in corso (il valore mostrato è la rotazione reale della mappa)
  let dot = null; // pallino GPS mostrato e obiettivo: {lat, lon, tLat, tLon}
  let focus = null; // {lat, lon, tLat, tLon, ax, ay, tax, tay, zoom}: punto e ancora (px da el) mostrati / obiettivo
  let animRaf = 0;
  let animLast = 0;
  let animMoved = false; // la mappa si è mossa dall'ultimo lavoro di fine movimento
  let tileAt = 0;
  let panNet = { x: 0, y: 0 }; // spostamento netto dall'ultimo ridisegno del canvas

  const clearTargets = () => {
    rotTarget = null;
    focus = null;
  };
  const apartPx = (lat0, lon0, lat1, lon1) => {
    const z = map.getZoom();
    return map.project([lat0, lon0], z).distanceTo(map.project([lat1, lon1], z));
  };
  /** Salto grande: oltre JUMP_M metri o oltre lo schermo. */
  const isFar = (lat0, lon0, lat1, lon1) => {
    const size = map.getSize();
    return map.distance([lat0, lon0], [lat1, lon1]) > JUMP_M || apartPx(lat0, lon0, lat1, lon1) > Math.max(size.x, size.y);
  };
  const focusLive = () => focus !== null && focus.zoom === map.getZoom();
  const focusOffset = () => map.latLngToContainerPoint([focus.lat, focus.lon]).subtract([focus.ax, focus.ay]);
  const dotBusy = () => dot !== null && apartPx(dot.lat, dot.lon, dot.tLat, dot.tLon) >= DONE_PX;
  const focusBusy = () => {
    if (!focusLive()) return false;
    if (apartPx(focus.lat, focus.lon, focus.tLat, focus.tLon) >= DONE_PX || Math.abs(focus.ax - focus.tax) >= DONE_PX || Math.abs(focus.ay - focus.tay) >= DONE_PX) return true;
    const o = focusOffset();
    return Math.abs(o.x) >= DONE_PX || Math.abs(o.y) >= DONE_PX;
  };
  const animBusy = () => rotTarget !== null || dotBusy() || focusBusy();

  // API PRIVATE di Leaflet, isolate qui: _rawPanBy sposta il pannello (in px schermo, come panBy ma senza moveend e
  // senza troncare); GridLayer._update carica le tile mancanti, cioè ciò che fa moveend con updateWhenIdle, senza il
  // ridisegno completo del canvas.
  /** Sposta la mappa perché il fuoco stia sull'ancora. @returns {boolean} true se si è mossa */
  const pinFocus = () => {
    const o = focusOffset();
    if (Math.abs(o.x) < 1e-3 && Math.abs(o.y) < 1e-3) return false;
    map._rawPanBy(o);
    map.fire('move');
    panNet = { x: panNet.x + o.x, y: panNet.y + o.y };
    return true;
  };
  const refreshTiles = () => {
    if (typeof tileLayer._update === 'function') tileLayer._update();
    else programmaticly(() => map.fire('moveend'));
  };

  /** Un passo di animazione di `dt` ms. */
  function stepAnim(dt) {
    let rotated = false;
    let panned = false;
    if (rotTarget !== null) {
      let next = dampAngleStep(currentBearing(), rotTarget, dt, TAU_ROT_MS);
      if (Math.abs(angleDiffDeg(next, rotTarget)) < DONE_DEG) {
        next = rotTarget;
        rotTarget = null;
      }
      programmaticly(() => map.setBearing(next));
      rotated = true;
    }
    if (dot && (dot.lat !== dot.tLat || dot.lon !== dot.tLon)) {
      dot.lat = dampStep(dot.lat, dot.tLat, dt, TAU_POS_MS);
      dot.lon = dampStep(dot.lon, dot.tLon, dt, TAU_POS_MS);
      if (apartPx(dot.lat, dot.lon, dot.tLat, dot.tLon) < DONE_PX) {
        dot.lat = dot.tLat;
        dot.lon = dot.tLon;
      }
      gpsMarker.setLatLng([dot.lat, dot.lon]);
    }
    if (focusLive()) {
      const f = focus;
      if (f.lat !== f.tLat || f.lon !== f.tLon || f.ax !== f.tax || f.ay !== f.tay) {
        f.lat = dampStep(f.lat, f.tLat, dt, TAU_POS_MS);
        f.lon = dampStep(f.lon, f.tLon, dt, TAU_POS_MS);
        f.ax = dampStep(f.ax, f.tax, dt, TAU_POS_MS);
        f.ay = dampStep(f.ay, f.tay, dt, TAU_POS_MS);
        if (apartPx(f.lat, f.lon, f.tLat, f.tLon) < DONE_PX && Math.abs(f.ax - f.tax) < DONE_PX && Math.abs(f.ay - f.tay) < DONE_PX) {
          f.lat = f.tLat;
          f.lon = f.tLon;
          f.ax = f.tax;
          f.ay = f.tay;
        }
      }
      panned = pinFocus();
    }
    if (!rotated && !panned) return;
    animMoved = true;
    const now = performance.now();
    if (now - tileAt >= TILE_REFRESH_MS) {
      tileAt = now;
      refreshTiles();
    }
    // Se l'animazione dura a lungo (navigazione a piedi) il lavoro di fine movimento non arriverebbe mai:
    // al massimo una volta al secondo, e solo se la vista è cambiata abbastanza, aggiorno frecce e salvataggio.
    if (now - workAt >= MOVEEND_MAX_WAIT_MS) {
      workAt = now;
      const sz = map.getSize();
      if (!workView || workView.z !== map.getZoom() || map.project(map.getCenter()).distanceTo(workView.c) > WORK_MOVE_FRACTION * Math.min(sz.x, sz.y)
        || Math.abs(angleDiffDeg(workView.b, currentBearing())) > WORK_ROTATE_DEG) onMoveEnd();
    }
    // Con la rotazione ci pensa il plugin (ridisegna il canvas quando serve); senza rotazione lo faccio io.
    const size = map.getSize();
    if (!rotated && Math.hypot(panNet.x, panNet.y) > PAN_REDRAW_FRACTION * Math.min(size.x, size.y)) programmaticly(() => map.fire('moveend'));
  }

  function mapAnimFrame(ts) {
    animRaf = 0;
    if (blocked()) {
      animLast = 0;
      return; // gesto o zoom in corso: sospeso, riparte da wakeIfBusy()
    }
    const dt = animLast ? Math.min(Math.max(ts - animLast, 0), MAX_DT_MS) : 16;
    animLast = ts;
    stepAnim(dt);
    if (animBusy()) {
      animRaf = requestAnimationFrame(mapAnimFrame);
      return;
    }
    animLast = 0;
    if (animMoved) {
      animMoved = false;
      refreshAfterRotate(); // lavoro di fine movimento, accorpato
    }
  }
  const wake = () => {
    if (animRaf || blocked() || document.visibilityState === 'hidden') return;
    animLast = 0;
    animRaf = requestAnimationFrame(mapAnimFrame);
  };
  const wakeIfBusy = () => {
    if (animBusy()) wake();
  };
  // Pagina nascosta o di ritorno: si arriva subito agli obiettivi, senza animazione.
  document.addEventListener('visibilitychange', () => {
    cancelAnimationFrame(animRaf);
    animRaf = 0;
    animLast = 0;
    if (!blocked()) stepAnim(1e9);
  });

  /**
   * Punta il fuoco su un punto con l'ancora indicata: animato se il salto è piccolo, subito se è grande,
   * se lo zoom è cambiato o se lo zoom è esplicito.
   */
  function aimAt(lat, lon, tax, tay, zoom) {
    const z = map.getZoom();
    if (zoom !== undefined || !focus || focus.zoom !== z || isFar(focus.lat, focus.lon, lat, lon)) {
      const zz = zoom ?? z;
      focus = { lat, lon, tLat: lat, tLon: lon, ax: tax, ay: tay, tax, tay, zoom: zz };
      const center = centerFor(lat, lon, zz, tax, tay);
      programmaticly(() => map.setView(center, zz, { animate: false }));
    } else {
      focus.tLat = lat;
      focus.tLon = lon;
      focus.tax = tax;
      focus.tay = tay;
    }
    wakeIfBusy();
  }
  const setRotTarget = (deg) => {
    rotTarget = Math.abs(angleDiffDeg(currentBearing(), deg)) < DONE_DEG ? null : deg;
  };

  return {
    /** Ricostruisce tracce, marcatori e frecce. */
    setData(tracks, nextRoute) {
      route = nextRoute;
      tracksLayer.clearLayers();
      marksLayer.clearLayers();
      bounds = null;
      for (const track of tracks) {
        if (!track.visible) continue;
        const latlngs = addTrack(track);
        if (latlngs) extendBounds(latlngs);
      }
      doneLine.bringToFront();
      estimateLine.bringToFront();
      previewLine.bringToFront();
      arrows = computeArrows(route);
      doneDist = null;
      bandKey = '';
      doneLine.setLatLngs([]);
      estimateLine.setLatLngs([]);
      drawArrows();
    },

    /** Parte fatta (0..dist) e arco di stima [min,max] evidenziati sulla traccia. */
    setProgress(dist, band) {
      if (!route) return;
      const d = dist ?? null;
      if (d === null) {
        if (doneDist !== null) doneLine.setLatLngs([]);
        doneDist = null;
      } else if (doneDist === null || Math.abs(d - doneDist) >= 5) {
        doneLine.setLatLngs(sliceRoute(route, 0, d));
        doneDist = d;
        if (arrowDoneDist === null || Math.abs(d - arrowDoneDist) >= 100) drawArrows();
      }
      const key = band ? `${Math.round(band.min)}|${Math.round(band.max)}` : '';
      if (key !== bandKey) {
        estimateLine.setLatLngs(band ? sliceRoute(route, band.min, band.max) : []);
        bandKey = key;
      }
    },

    /** gps {lat,lon,accuracy,weak} · lastSure {lat,lon,label} · estimate {lat,lon}; tutti opzionali. */
    setPositions({ gps, lastSure, estimate }) {
      if (gps) {
        // Il pallino scivola verso il nuovo punto (salto grande: subito); il cerchio di accuratezza, sul canvas, si
        // aggiorna all'arrivo del dato e non a ogni fotogramma.
        if (!dot || !map.hasLayer(gpsMarker) || isFar(dot.lat, dot.lon, gps.lat, gps.lon)) {
          dot = { lat: gps.lat, lon: gps.lon, tLat: gps.lat, tLon: gps.lon };
          place(gpsMarker, [gps.lat, gps.lon]);
        } else {
          dot.tLat = gps.lat;
          dot.tLon = gps.lon;
          wakeIfBusy();
        }
        gpsMarker.getElement()?.firstChild.classList.toggle('weak', gps.weak);
        const radius = Math.max(gps.accuracy ?? 1, 1);
        const key = `${gps.lat}|${gps.lon}|${radius}`;
        if (key !== accuracyKey || !map.hasLayer(accuracyCircle)) {
          accuracyKey = key;
          accuracyCircle.setRadius(radius);
          place(accuracyCircle, [gps.lat, gps.lon]);
        }
      } else {
        dot = null;
        accuracyKey = '';
        place(gpsMarker, null);
        accuracyCircle.remove();
      }
      if (lastSure && lastSure.label !== sureLabel) {
        sureLabel = lastSure.label;
        const box = document.createElement('div');
        box.className = 'mk-sure';
        box.innerHTML = '<i></i><b></b>';
        box.querySelector('b').textContent = lastSure.label;
        sureMarker.setIcon(L.divIcon({ className: '', html: box, iconSize: [64, 48], iconAnchor: [32, 12] }));
      }
      place(sureMarker, lastSure && [lastSure.lat, lastSure.lon]);
      place(estimateMarker, estimate && [estimate.lat, estimate.lon]);
    },

    setCrosshair(point) {
      place(crossMarker, point && [point.lat, point.lon]);
    },

    /** Anteprima del taglio: tratto che resterà. */
    setPreview(points) {
      if (!points) {
        previewLine.setLatLngs([]);
        return;
      }
      const step = Math.ceil(points.length / PREVIEW_MAX_POINTS);
      const latlngs = [];
      for (let i = 0; i < points.length; i += step) latlngs.push([points[i].lat, points[i].lon]);
      const last = points[points.length - 1];
      latlngs.push([last.lat, last.lon]);
      previewLine.setLatLngs(latlngs);
    },

    /** @param {number} [bottomInset] altezza coperta in basso (default: il pannello) */
    fitTracks(bottomInset = getBottomInset()) {
      if (!bounds) return;
      clearTargets();
      if (currentBearing() !== 0) map.setBearing(0);
      map.fitBounds(bounds, { paddingTopLeft: [16, 80], paddingBottomRight: [16, bottomInset + 16], maxZoom: 16, animate: false });
    },

    /** Centra il punto nella parte di mappa non coperta dal pannello (a qualsiasi rotazione). */
    centerOn(lat, lon, zoom) {
      if (blocked()) return;
      aimAt(lat, lon, map.getSize().x / 2, visibleHeight() / 2, zoom);
    },

    /** Navigazione: rotazione e posizione insieme; l'utente sta al centro in orizzontale e al 70% dell'altezza visibile. */
    navigate(lat, lon, bearing) {
      if (blocked()) return;
      setRotTarget(normalizeDeg(bearing));
      aimAt(lat, lon, map.getSize().x / 2, visibleHeight() * NAV_USER_FRACTION);
    },

    /** Rotazione animata verso `deg` (senza spostare la mappa). */
    rotateTo(deg) {
      if (blocked()) return;
      setRotTarget(normalizeDeg(deg));
      wakeIfBusy();
    },

    /** Rotazione immediata, senza animazione (il nord appare a `deg` gradi in senso orario). */
    setBearing(deg) {
      if (blocked()) return;
      rotTarget = null;
      programmaticly(() => map.setBearing(normalizeDeg(deg)));
      if (focusLive()) pinFocus(); // il fuoco resta fermo sull'ancora
    },

    /** Ferma gli obiettivi di mappa (rotazione e inseguimento); il pallino finisce il suo scorrimento. */
    stopAnimation() {
      clearTargets();
    },

    getBearing() {
      return currentBearing();
    },

    /** Direzione dell'iPhone per il cono (gradi sullo schermo, nord in alto); null = cono nascosto. */
    setHeading(deg) {
      heading = Number.isFinite(deg) ? normalizeDeg(deg) : null;
      applyHeading(gpsMarker.getElement());
    },

    getView() {
      const c = map.getCenter();
      return { lat: c.lat, lon: c.lng, zoom: map.getZoom(), bearing: currentBearing() };
    },

    setView({ lat, lon, zoom, bearing }) {
      clearTargets();
      map.setBearing(normalizeDeg(bearing ?? 0));
      map.setView([lat, lon], zoom, { animate: false });
    },
  };
}
