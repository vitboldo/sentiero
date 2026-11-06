// Profilo altimetrico su canvas. Si ridisegna solo se cambia qualcosa.

const C = {
  doneFill: '#4b5563',
  todoFill: '#9ec1ea',
  doneLine: '#0b0b0b',
  todoLine: '#0b3a82',
  gps: '#0057d9',
  estimate: '#c24a00',
  sure: '#5b21b6',
  trim: '#d6007f',
};

/**
 * @typedef {object} ProfileModel
 * @property {object|null} route
 * @property {{dist:number, kind:'gps'|'stima'}|null} [pos]   posizione corrente
 * @property {{min:number, max:number}|null} [band]           banda della stima
 * @property {number|null} [sureDist]                         ultimo punto sicuro sulla traccia
 * @property {{start:number, end:number}|null} [trim]         intervallo mantenuto (anteprima taglio)
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Quote riempite dove mancano; null se la route non ne ha. */
function filledElevations(points) {
  const out = new Float64Array(points.length);
  let last = null;
  for (let i = 0; i < points.length; i++) {
    if (points[i].ele != null) last = points[i].ele;
    out[i] = last ?? NaN;
  }
  const first = out.find((v) => !Number.isNaN(v));
  if (first === undefined) return null;
  for (let i = 0; out[i] !== out[i]; i++) out[i] = first;
  return out;
}

/** Quota per colonna di pixel, con minimo e massimo. */
function sampleCurve(route, width) {
  const ele = route.hasElevation ? filledElevations(route.points) : null;
  const ys = new Float32Array(width);
  if (!ele) return { ys, min: 0, max: 0 };
  const { cumDist, totalDist } = route;
  let j = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let x = 0; x < width; x++) {
    const d = (x / (width - 1)) * totalDist;
    while (j < cumDist.length - 2 && cumDist[j + 1] < d) j++;
    const span = cumDist[j + 1] - cumDist[j];
    const t = span > 0 ? clamp((d - cumDist[j]) / span, 0, 1) : 0;
    const v = ele[j] + (ele[j + 1] - ele[j]) * t;
    ys[x] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { ys, min, max };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{onScrub?: (dist: number|null) => void}} [opts]
 */
export function createProfile(canvas, { onScrub } = {}) {
  const ctx = canvas.getContext('2d');
  const routeIds = new WeakMap();
  let nextRouteId = 1;
  let model = { route: null };
  let scrubDist = null;
  let drawnKey = '';
  let curve = { route: null, width: 0, data: null };

  const routeId = (route) => {
    if (!routeIds.has(route)) routeIds.set(route, nextRouteId++);
    return routeIds.get(route);
  };
  const r10 = (v) => (v == null ? '' : Math.round(v / 10));

  function draw() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w < 2 || h < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const { route, pos, band, sureDist, trim } = model;
    const key = [
      route ? routeId(route) : 0, w, h, dpr, r10(pos?.dist), pos?.kind, r10(band?.min), r10(band?.max),
      r10(sureDist), r10(trim?.start), r10(trim?.end), r10(scrubDist),
    ].join('|');
    if (key === drawnKey) return;
    drawnKey = key;

    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!route || !(route.totalDist > 0)) return;

    if (curve.route !== route || curve.width !== w) curve = { route, width: w, data: sampleCurve(route, w) };
    paint(w, h);
  }

  function paint(w, h) {
    const { route, pos, band, sureDist, trim } = model;
    const { ys, min, max } = curve.data;
    const padT = 22;
    const padB = 6;
    const plotH = h - padT - padB;
    const total = route.totalDist;
    const xOf = (d) => clamp(d / total, 0, 1) * (w - 1);
    const mid = (min + max) / 2;
    const range = Math.max(max - min, 40);
    const yOfEle = (e) => padT + plotH * (1 - (e - (mid - range / 2)) / range);
    const yAt = (x) => (route.hasElevation ? yOfEle(ys[clamp(Math.round(x), 0, w - 1)]) : h - padB - plotH * 0.25);

    const trace = () => {
      ctx.beginPath();
      ctx.moveTo(0, h - padB);
      for (let x = 0; x < w; x++) ctx.lineTo(x, yAt(x));
      ctx.lineTo(w - 1, h - padB);
      ctx.closePath();
    };
    const region = (x0, x1, fill, stroke) => {
      if (x1 <= x0) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, x1 - x0, h);
      ctx.clip();
      trace();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = stroke;
      ctx.stroke();
      ctx.restore();
    };
    const vline = (x, color, width, dash = []) => {
      ctx.save();
      ctx.setLineDash(dash);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.restore();
    };
    const dot = (x, color) => {
      ctx.beginPath();
      ctx.arc(x, yAt(x), 7, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    };

    const doneX = pos ? xOf(pos.dist) : 0;
    region(0, doneX, C.doneFill, C.doneLine);
    region(doneX, w, C.todoFill, C.todoLine);

    if (band) {
      const x0 = xOf(band.min);
      const x1 = Math.max(xOf(band.max), x0 + 3);
      ctx.fillStyle = 'rgba(194, 74, 0, 0.4)';
      ctx.fillRect(x0, 0, x1 - x0, h);
      vline(x0, C.estimate, 2, [5, 3]);
      vline(x1, C.estimate, 2, [5, 3]);
    }
    for (const r of route.trackRanges.slice(1)) vline(xOf(r.startDist), '#0b0b0b', 2, [4, 3]);

    if (sureDist != null) {
      const x = xOf(sureDist);
      vline(x, C.sure, 3);
      ctx.fillStyle = C.sure;
      ctx.fillRect(x - 6, 0, 12, 12);
    }
    if (pos) {
      const color = pos.kind === 'stima' ? C.estimate : C.gps;
      vline(doneX, color, 3, pos.kind === 'stima' ? [6, 4] : []);
      dot(doneX, color);
    }
    if (trim) {
      const x0 = xOf(trim.start);
      const x1 = xOf(trim.end);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
      ctx.fillRect(0, 0, x0, h);
      ctx.fillRect(x1, 0, w - x1, h);
      vline(x0, C.trim, 3);
      vline(x1, C.trim, 3);
    }
    if (scrubDist != null) {
      const x = xOf(scrubDist);
      vline(x, '#0b0b0b', 2);
      dot(x, '#0b0b0b');
    }

    if (route.hasElevation) {
      ctx.font = '700 16px -apple-system, sans-serif';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#fff';
      ctx.fillStyle = '#0b0b0b';
      const label = (text, y) => {
        ctx.strokeText(text, 4, y);
        ctx.fillText(text, 4, y);
      };
      label(`${Math.round(max)} m`, 17);
      label(`${Math.round(min)} m`, h - padB - 2);
    }
  }

  const distAt = (ev) => {
    const rect = canvas.getBoundingClientRect();
    return clamp((ev.clientX - rect.left) / rect.width, 0, 1) * model.route.totalDist;
  };
  const scrubTo = (ev) => {
    scrubDist = distAt(ev);
    draw();
    onScrub?.(scrubDist);
  };
  const endScrub = () => {
    if (scrubDist == null) return;
    scrubDist = null;
    draw();
    onScrub?.(null);
  };

  canvas.addEventListener('pointerdown', (ev) => {
    if (!model.route) return;
    ev.preventDefault();
    canvas.setPointerCapture(ev.pointerId);
    scrubTo(ev);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (scrubDist != null) scrubTo(ev);
  });
  canvas.addEventListener('pointerup', endScrub);
  canvas.addEventListener('pointercancel', endScrub);

  return {
    /** @param {ProfileModel} next */
    update(next) {
      model = next;
      draw();
    },
  };
}
