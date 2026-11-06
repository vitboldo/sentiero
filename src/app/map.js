// Mappa Leaflet: tile con ripiego su antenate, tracce, frecce, marcatori GPS / ultimo punto sicuro / stima.
import { TILE_URL } from '../core/tiles.js';
import { effectivePoints, statsAt } from '../core/route.js';
import { bearingDeg } from '../core/geo.js';

const L = window.L;

const ATTRIBUTION = 'Kartendaten: © OpenStreetMap-Mitwirkende, SRTM | Kartendarstellung: © OpenTopoMap (CC-BY-SA)';
const MAX_ZOOM = 17;
const MAX_ANCESTOR_STEPS = 5;
const ARROW_SPACING_M = 500;
const MAX_ARROWS_IN_VIEW = 120;
const PREVIEW_MAX_POINTS = 1500;
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
      html: `<svg viewBox="0 0 24 24" style="transform:rotate(${key}deg)"><path d="M12 2 20 21l-8-5-8 5z"/></svg>`,
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
 * @param {{getBottomInset: () => number, onUserMove: () => void, onViewChange: (v:{lat:number,lon:number,zoom:number}) => void}} hooks
 */
export function createMap(el, { getBottomInset, onUserMove, onViewChange }) {
  const renderer = L.canvas({ padding: 0.3 });
  const map = L.map(el, { maxZoom: MAX_ZOOM, minZoom: 4, renderer, zoomControl: false, attributionControl: true });
  map.attributionControl.setPrefix(false);
  L.control.zoom({ position: 'topright', zoomInText: '+', zoomOutText: '−' }).addTo(map);
  new FallbackTileLayer(TILE_URL, {
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
  const gpsMarker = L.marker([0, 0], { ...markerOpts, icon: dotIcon('mk-gps', 24), zIndexOffset: 1000 });
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
  let lastCenter = null;

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

  map.on('dragstart', onUserMove);
  map.on('moveend', () => {
    drawArrows();
    const c = map.getCenter();
    onViewChange({ lat: c.lat, lon: c.lng, zoom: map.getZoom() });
  });
  map.on('zoomend', () => el.classList.toggle('zoom-low', map.getZoom() < 13));
  new ResizeObserver(() => map.invalidateSize()).observe(el);

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
      place(gpsMarker, gps && [gps.lat, gps.lon]);
      if (gps) {
        gpsMarker.getElement()?.firstChild.classList.toggle('weak', gps.weak);
        accuracyCircle.setRadius(Math.max(gps.accuracy ?? 1, 1));
        place(accuracyCircle, [gps.lat, gps.lon]);
      } else {
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
      map.fitBounds(bounds, { paddingTopLeft: [16, 80], paddingBottomRight: [16, bottomInset + 16], maxZoom: 16, animate: false });
    },

    /** Centra il punto nella parte di mappa non coperta dal pannello. */
    centerOn(lat, lon, zoom) {
      const moved = !lastCenter || Math.abs(lastCenter[0] - lat) > 2e-5 || Math.abs(lastCenter[1] - lon) > 2e-5;
      if (!moved && zoom === undefined) return;
      lastCenter = [lat, lon];
      const z = zoom ?? map.getZoom();
      const shifted = map.project([lat, lon], z).add([0, getBottomInset() / 2]);
      map.setView(map.unproject(shifted, z), z, { animate: false });
    },

    getView() {
      const c = map.getCenter();
      return { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
    },

    setView({ lat, lon, zoom }) {
      map.setView([lat, lon], zoom, { animate: false });
    },
  };
}
