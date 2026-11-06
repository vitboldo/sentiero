// Interfaccia: stato GPS, pannello numeri, fogli (Tracce, Modifica, Mappe offline), dialoghi e avvisi.
import { buildRoute, effectivePoints } from '../core/route.js';
import { haversineM } from '../core/geo.js';
import { BUFFER_OPTIONS_M, DEFAULT_BUFFER_M, PRECISION_PRESETS } from '../core/tiles.js';
import { createProfile } from './profile.js';
import { planDownload, startDownload, listPackages, deletePackage, storageInfo, requestPersist } from './offline.js';

const JUMP_WARN_M = 200;

// ---------- Formattazione ----------
const num1 = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const fmtKm = (m) => num1.format(m / 1000);
export const fmtMB = (bytes) => `${num1.format(bytes / 1048576)} MB`;
export const fmtClock = (ts) => new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

export function fmtTime(sec) {
  const total = Math.max(0, Math.round(sec / 60));
  const hours = Math.floor(total / 60);
  return hours > 0 ? `${hours}h${String(total % 60).padStart(2, '0')}` : `${total}min`;
}

export function fmtAgo(sec) {
  if (sec < 60) return `${Math.round(sec)} s`;
  const min = Math.floor(sec / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

const CARDINALS = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ovest', 'ovest', 'nord-ovest'];
export const cardinal = (deg) => CARDINALS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);

/** Crea un elemento. Le proprietà sono assegnate nell'ordine dato (min/max prima di value). */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}

const button = (label, onclick, props = {}) => h('button', { type: 'button', class: 'btn', onclick, ...props }, label);

// ---------- Stato del modulo ----------
let actions;
let data = { tracks: [], route: null, report: null };
let sheet = null; // { kind, trackId, body, dispose, after }
let toastTimer = 0;

const lengthCache = new WeakMap();
function trackLengthM(track) {
  if (!lengthCache.has(track)) {
    let sum = 0;
    for (let i = 1; i < track.points.length; i++) sum += haversineM(track.points[i - 1], track.points[i]);
    lengthCache.set(track, sum);
  }
  return lengthCache.get(track);
}

// ---------- Avvisi e dialoghi ----------
function toast(message, { error = false, ms = error ? 7000 : 3500 } = {}) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/** @returns {Promise<string>} il `value` del pulsante premuto */
function modal({ title, paragraphs, buttons }) {
  return new Promise((resolve) => {
    const close = (value) => {
      back.remove();
      resolve(value);
    };
    const back = h('div', { class: 'modal-back' },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('h2', {}, title),
        paragraphs.map((p) => h('p', {}, p)),
        buttons.map((b) => button(b.label, () => close(b.value), { class: `btn ${b.kind ?? ''}` }))));
    document.body.append(back);
    back.querySelector('button:last-child').focus();
  });
}

async function confirmDialog(message, okLabel) {
  const answer = await modal({
    title: 'Conferma',
    paragraphs: [message],
    buttons: [{ label: 'Annulla', value: 'no' }, { label: okLabel, value: 'yes', kind: 'danger' }],
  });
  return answer === 'yes';
}

function showWelcome({ standalone }) {
  const paragraphs = [
    'A schermo bloccato iOS sospende il GPS. Sentiero non registra: al ritorno stimerà dove sei arrivato, e lo segnalerà in arancione.',
    'Per tenere lo schermo acceso l\'app usa il blocco schermo; se non è disponibile, imposta Impostazioni > Schermo e luminosità > Blocco automatico su Mai.',
  ];
  if (!standalone) paragraphs.push('Per un uso affidabile installa l\'app: tocca Condividi, poi Aggiungi alla schermata Home.');
  return modal({ title: 'Prima di partire', paragraphs, buttons: [{ label: 'Ho capito', value: 'ok', kind: 'primary' }] });
}

async function askUpdate() {
  const answer = await modal({
    title: 'Aggiornamento disponibile',
    paragraphs: ['È pronta una nuova versione di Sentiero. Il programma si ricaricherà: meglio non farlo durante un tratto in cui ti serve la mappa.'],
    buttons: [{ label: 'Più tardi', value: 'later' }, { label: 'Aggiorna ora', value: 'now', kind: 'primary' }],
  });
  return answer === 'now';
}

// ---------- Barra di stato, banner, pannello ----------
function renderStatus({ level, text }) {
  $('status').dataset.level = level;
  $('status-text').textContent = text;
}

/** @param {{text:string, bearing:number}|null} info  `bearing`: angolo della freccia sullo schermo (già corretto per la rotazione della mappa) */
function renderBanner(info) {
  $('banner').hidden = !info;
  if (!info) return;
  $('banner-text').textContent = info.text;
  $('banner-arrow').style.transform = `rotate(${info.bearing}deg)`;
}

/**
 * @param {{empty:boolean, emptyText?:string, scopeVisible?:boolean, mode?:string, caption?:string,
 *   approx?:boolean, hasElevation?:boolean, rem?:{dist:number,up:number,down:number,etaSec:number}, profileLabel?:string}} m
 */
function renderPanel(m) {
  $('empty').hidden = !m.empty;
  $('live').hidden = m.empty;
  if (m.empty) {
    $('empty-text').textContent = m.emptyText;
    return;
  }
  $('scope').hidden = !m.scopeVisible;
  for (const b of $('scope').children) b.setAttribute('aria-pressed', String(b.dataset.mode === m.mode));
  $('caption').textContent = m.caption;
  $('stats').classList.toggle('approx', m.approx);
  $('stats').classList.toggle('no-ele', !m.hasElevation);
  const prefix = m.approx ? '~' : '';
  $('st-dist').textContent = prefix + fmtKm(m.rem.dist);
  $('st-up').textContent = prefix + Math.round(m.rem.up);
  $('st-down').textContent = prefix + Math.round(m.rem.down);
  $('st-time').textContent = prefix + fmtTime(m.rem.etaSec);
  $('noele').hidden = m.hasElevation;
  $('profile-label').textContent = m.profileLabel;
}

const VIEW_MODES = {
  free: { label: 'Centra su di me', pressed: false },
  follow: { label: 'Seguo la posizione', pressed: true },
  nav: { label: 'Navigazione', pressed: true },
};

/** @param {'free'|'follow'|'nav'} mode */
function setViewMode(mode) {
  const btn = $('btn-locate');
  btn.dataset.viewMode = mode;
  btn.setAttribute('aria-pressed', String(VIEW_MODES[mode].pressed));
  btn.textContent = VIEW_MODES[mode].label;
}

/** Bussolina: visibile solo con la mappa ruotata; l'ago segue la rotazione (gradi, senso orario). */
function setNorth(deg) {
  const btn = $('btn-north');
  btn.hidden = Math.abs(((deg + 180) % 360) - 180) < 0.5;
  btn.style.setProperty('--map-bearing', `${deg}deg`);
}

function showScrub(text) {
  $('scrub').hidden = false;
  $('scrub').textContent = text;
}

function hideScrub() {
  $('scrub').hidden = true;
}

// ---------- Gestione fogli ----------
const SHEET_TITLES = { tracks: 'Tracce', edit: 'Modifica traccia', offline: 'Mappe offline' };

function openSheet(kind, trackId = null) {
  closeSheet();
  const body = h('div', { class: 'sheet-body' });
  const el = h('section', { class: `sheet${kind === 'edit' ? ' half' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': SHEET_TITLES[kind] },
    h('header', { class: 'sheet-head' }, h('h2', {}, SHEET_TITLES[kind]), button('Chiudi', closeSheet)),
    body);
  $('sheet-root').append(el);
  sheet = { kind, trackId, el, body, dispose: null, after: null };
  if (kind === 'offline') {
    off.refs = {};
    prepareOffline();
  }
  renderSheet();
  if (kind === 'edit') actions.fitAboveSheet(el.offsetHeight);
}

function closeSheet() {
  if (!sheet) return;
  sheet.dispose?.();
  sheet.el.remove();
  if (sheet.kind === 'edit') actions.previewTrim(null);
  data.report = null;
  sheet = null;
}

function renderSheet() {
  if (!sheet) return;
  const scroll = sheet.body.scrollTop;
  sheet.dispose?.();
  sheet.dispose = null;
  sheet.after = null;
  const content = { tracks: tracksContent, edit: editContent, offline: offlineContent }[sheet.kind]();
  sheet.body.replaceChildren(...content.flat().filter(Boolean));
  sheet.body.scrollTop = scroll;
  sheet.after?.();
}

/** Aggiorna tracce e route; ridisegna il foglio aperto. */
function setTracks(tracks, route) {
  data = { ...data, tracks, route };
  if (!sheet) return;
  if (sheet.kind === 'offline') schedulePlan();
  else renderSheet();
}

function showImportReport(report) {
  data.report = report;
  if (sheet?.kind === 'tracks') renderSheet();
}

// ---------- Foglio Tracce ----------
function tracksContent() {
  const { tracks, route, report } = data;
  const jumps = new Map((route?.trackRanges ?? []).filter((r) => r.gapBeforeM > JUMP_WARN_M).map((r) => [r.trackId, r.gapBeforeM]));

  const input = h('input', {
    id: 'file-input',
    class: 'visually-hidden',
    type: 'file',
    multiple: true,
    onchange: (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (files.length) actions.importFiles(files);
    },
  });

  const rows = tracks.map((t, i) => h('li', { class: `track${t.visible ? '' : ' off'}` },
    h('div', { class: 'track-head' },
      h('span', { class: 'swatch', style: `background:${t.color}` }),
      h('div', { class: 'track-name' },
        h('strong', {}, t.name),
        h('span', { class: 'meta' }, `${fmtKm(trackLengthM(t))} km · ${t.points.length} punti${t.reversed ? ' · verso invertito' : ''}`)),
      h('label', { class: 'vis' }, h('input', { type: 'checkbox', checked: t.visible, onchange: () => actions.toggleVisible(t.id) }), 'Visibile')),
    jumps.has(t.id) && h('p', { class: 'notice warn' }, `Salto di ${Math.round(jumps.get(t.id))} m dalla traccia precedente: non è contato nella distanza.`),
    h('div', { class: 'track-actions' },
      button('Su', () => actions.moveTrack(t.id, -1), { disabled: i === 0 }),
      button('Giù', () => actions.moveTrack(t.id, 1), { disabled: i === tracks.length - 1 }),
      button('Inverti', () => actions.reverseTrack(t.id)),
      button('Modifica', () => openSheet('edit', t.id)),
      button('Esporta GPX', () => actions.exportTrack(t.id)),
      button('Elimina', async () => {
        if (await confirmDialog(`Eliminare la traccia «${t.name}»?`, 'Elimina')) actions.deleteTrack(t.id);
      }, { class: 'btn danger' }))));

  return [
    h('label', { class: 'btn primary', for: 'file-input', style: 'display:flex;align-items:center;justify-content:center' }, 'Importa file GPX'),
    input,
    report && importReportNode(report),
    tracks.length ? h('ul', { class: 'list' }, rows) : h('p', { class: 'hint' }, 'Nessuna traccia. Importa uno o più file GPX.'),
    button('Inverti tutto il percorso', () => actions.reverseAll(), { disabled: !route }),
  ];
}

function importReportNode({ added, errors }) {
  return h('div', { class: `notice${errors.length ? ' warn' : ''}`, role: 'status' },
    added ? `Importate ${added} tracce.` : 'Nessuna traccia importata.',
    errors.length > 0 && h('ul', {}, errors.map((e) => h('li', {}, `${e.name}: ${e.message}`))));
}

// ---------- Foglio Modifica ----------
function editContent() {
  const track = data.tracks.find((t) => t.id === sheet.trackId);
  if (!track) {
    queueMicrotask(closeSheet);
    return [];
  }
  const index = data.tracks.indexOf(track);
  const next = data.tracks[index + 1];
  const points = effectivePoints(track);
  const last = points.length - 1;
  const mini = buildRoute([{ ...track, visible: true }]);
  const distAt = (i) => mini.cumDist[Math.min(i, mini.cumDist.length - 1)];
  const state = { start: 0, end: last };

  const nameInput = h('input', { type: 'text', value: track.name, maxLength: 80, 'aria-label': 'Nome' });
  const canvas = h('canvas', { class: 'edit-profile', 'aria-label': 'Anteprima del taglio' });
  const startLabel = h('span');
  const endLabel = h('span');
  const startRange = h('input', { type: 'range', min: 0, max: last, step: 1, value: 0, oninput: () => onRange('start') });
  const endRange = h('input', { type: 'range', min: 0, max: last, step: 1, value: last, oninput: () => onRange('end') });
  const applyBtn = button('Applica taglio', () => actions.trimTrack(track.id, state.start, state.end), { class: 'btn primary' });
  const profile = createProfile(canvas);
  let frame = 0;

  const refresh = () => {
    frame = 0;
    const trimmed = state.start > 0 || state.end < last;
    profile.update({ route: mini, trim: trimmed ? { start: distAt(state.start), end: distAt(state.end) } : null });
    actions.previewTrim(trimmed ? points.slice(state.start, state.end + 1) : null);
  };

  function onRange(which) {
    if (which === 'start') {
      state.start = Number(startRange.value);
      if (state.start >= state.end) state.end = Math.min(last, state.start + 1);
      if (state.start >= state.end) state.start = state.end - 1;
    } else {
      state.end = Number(endRange.value);
      if (state.end <= state.start) state.start = Math.max(0, state.end - 1);
      if (state.end <= state.start) state.end = state.start + 1;
    }
    startRange.value = state.start;
    endRange.value = state.end;
    startLabel.textContent = `Inizio: km ${fmtKm(distAt(state.start))} (taglia ${fmtKm(distAt(state.start))} km)`;
    endLabel.textContent = `Fine: km ${fmtKm(distAt(state.end))} (taglia ${fmtKm(mini.totalDist - distAt(state.end))} km)`;
    applyBtn.disabled = state.start === 0 && state.end === last;
    if (!frame) frame = requestAnimationFrame(refresh);
  }

  sheet.after = () => {
    onRange('start');
    cancelAnimationFrame(frame);
    refresh();
  };
  sheet.dispose = () => cancelAnimationFrame(frame);

  const waypoints = track.waypoints ?? [];
  return [
    // Taglio per primo: è l'operazione con anteprima, deve restare visibile nel mezzo foglio senza scorrere.
    h('h3', {}, 'Taglia inizio e fine'),
    last < 1 ? h('p', { class: 'hint' }, 'La traccia ha un solo punto: non si può tagliare.') : [
      canvas,
      h('label', { class: 'field' }, startLabel, startRange),
      h('label', { class: 'field' }, endLabel, endRange),
      applyBtn,
    ],
    h('h3', {}, 'Nome'),
    h('form', {
      class: 'name-form',
      onsubmit: (e) => {
        e.preventDefault();
        const name = nameInput.value.trim();
        if (name) actions.renameTrack(track.id, name);
      },
    }, h('div', { class: 'name-row' }, nameInput, h('button', { class: 'btn', type: 'submit' }, 'Rinomina'))),
    h('h3', {}, 'Altre modifiche'),
    button(next ? `Unisci con «${next.name}»` : 'Unisci con la traccia successiva', async () => {
      if (await confirmDialog(`Unire «${track.name}» con «${next.name}»? Le due tracce diventano una sola.`, 'Unisci')) actions.mergeNext(track.id);
    }, { disabled: !next }),
    track.original && button('Ripristina originale', async () => {
      if (await confirmDialog('Annullare tutte le modifiche e tornare alla traccia importata?', 'Ripristina')) actions.restoreOriginal(track.id);
    }),
    waypoints.length > 0 && h('h3', {}, 'Waypoint'),
    waypoints.map((wp, i) => h('div', { class: 'wp-row' }, h('span', {}, wp.name || 'Senza nome'), button('Elimina', () => actions.removeWaypoint(track.id, i), { class: 'btn danger' }))),
  ];
}

// ---------- Foglio Mappe offline ----------
const off = {
  presetId: 'media',
  bufferM: DEFAULT_BUFFER_M,
  name: '',
  nameTouched: false,
  plan: null,
  token: 0,
  timer: 0,
  packages: [],
  info: null,
  refs: {},
};
/** Stato del download: sopravvive alla chiusura del foglio. */
const dl = { running: false, abort: null, progress: null, result: null, plan: null, name: '' };

const visibleTracks = () => data.tracks.filter((t) => t.visible);

function prepareOffline() {
  if (!off.nameTouched) off.name = visibleTracks().map((t) => t.name).join(', ').slice(0, 60);
  schedulePlan();
  loadOfflineMeta();
}

async function loadOfflineMeta() {
  try {
    [off.packages, off.info] = await Promise.all([listPackages(), storageInfo()]);
  } catch (err) {
    toast(`Impossibile leggere le mappe offline: ${err.message}`, { error: true });
  }
  paintOffline();
}

function schedulePlan() {
  clearTimeout(off.timer);
  off.plan = null;
  const token = ++off.token;
  paintOffline();
  const tracks = visibleTracks();
  if (!tracks.length) return;
  off.timer = setTimeout(async () => {
    try {
      const plan = await planDownload(tracks, { presetId: off.presetId, bufferM: off.bufferM });
      if (token !== off.token) return;
      off.plan = plan;
      paintOffline();
    } catch (err) {
      toast(`Calcolo delle tile non riuscito: ${err.message}`, { error: true });
    }
  }, 250);
}

async function runDownload(plan, name) {
  if (dl.running) return;
  Promise.resolve().then(requestPersist).catch(() => {});
  Object.assign(dl, { running: true, abort: new AbortController(), result: null, plan, name, progress: { done: 0, total: plan.count, failed: 0, skipped: 0 } });
  paintOffline();
  try {
    dl.result = await startDownload(name, plan, {
      signal: dl.abort.signal,
      onProgress: (p) => {
        dl.progress = p;
        paintOffline();
      },
    });
  } catch (err) {
    dl.result = { error: err.message };
    toast(`Download non riuscito: ${err.message}`, { error: true });
  }
  dl.running = false;
  await loadOfflineMeta();
}

function field(label, control) {
  return h('label', { class: 'field' }, label, control);
}

function offlineContent() {
  const r = off.refs;
  r.name = h('input', {
    type: 'text', maxLength: 60, value: off.name, placeholder: 'Nome del pacchetto',
    oninput: (e) => {
      off.name = e.target.value;
      off.nameTouched = true;
      paintOffline();
    },
  });
  r.preset = h('select', {
    onchange: (e) => {
      off.presetId = e.target.value;
      schedulePlan();
    },
  }, PRECISION_PRESETS.map((p) => h('option', { value: p.id, selected: p.id === off.presetId }, `${p.label} (zoom fino a ${p.maxZoom})`)));
  r.buffer = h('select', {
    onchange: (e) => {
      off.bufferM = Number(e.target.value);
      schedulePlan();
    },
  }, BUFFER_OPTIONS_M.map((m) => h('option', { value: m, selected: m === off.bufferM }, `±${m} m dalla traccia`)));
  r.estimate = h('p', { class: 'estimate' });
  r.warn = h('p', { class: 'notice warn' });
  r.start = button('Scarica', () => runDownload(off.plan, off.name.trim()), { class: 'btn primary' });
  r.cancel = button('Annulla download', () => dl.abort?.abort(), { class: 'btn danger' });
  r.progress = h('progress');
  r.status = h('p', { class: 'notice' });
  r.retry = button('Riprova le tile mancanti', () => runDownload(dl.plan, dl.name), { class: 'btn primary' });
  r.packages = h('ul', { class: 'list' });
  r.storage = h('p', { class: 'hint' });
  sheet.after = paintOffline;

  return [
    field('Nome del pacchetto', r.name),
    field('Precisione', r.preset),
    field('Fascia', r.buffer),
    r.estimate,
    r.warn,
    r.start,
    r.progress,
    r.status,
    r.cancel,
    r.retry,
    h('h3', {}, 'Pacchetti scaricati'),
    r.packages,
    r.storage,
    h('p', { class: 'hint' }, 'Le tile vengono scaricate da OpenTopoMap con poche richieste alla volta, per rispettare il server.'),
  ];
}

function resultMessage(result) {
  if (result.error) return `Download interrotto: ${result.error}`;
  if (result.aborted) return 'Download annullato. Le tile già scaricate restano e al prossimo tentativo non vengono riscaricate.';
  if (result.failed > 0) return `Scaricate ${result.done} tile, ${result.failed} non riuscite. Puoi riprovare.`;
  return `Download completato: ${result.done} tile.`;
}

function paintOffline() {
  const r = off.refs;
  if (sheet?.kind !== 'offline' || !r.name) return;
  const { plan } = off;
  const none = visibleTracks().length === 0;
  const busy = dl.running;

  r.name.disabled = r.preset.disabled = r.buffer.disabled = busy;
  r.estimate.textContent = none ? 'Nessuna traccia visibile: mostrane almeno una.' : plan ? `${plan.count} tile · circa ${fmtMB(plan.bytes)}` : 'Calcolo in corso…';
  r.warn.hidden = !plan?.tooMany;
  if (plan?.tooMany) r.warn.textContent = `Troppe tile (${plan.count}). Riduci la precisione o la fascia, oppure mostra meno tracce.`;
  r.start.hidden = busy;
  r.start.disabled = none || !plan || plan.tooMany || plan.count === 0 || !off.name.trim();
  r.cancel.hidden = !busy;

  r.progress.hidden = !busy;
  if (busy) {
    r.progress.max = Math.max(dl.progress.total, 1);
    r.progress.value = dl.progress.done + dl.progress.skipped + dl.progress.failed;
  }
  r.status.hidden = !busy && !dl.result;
  r.status.textContent = busy
    ? `${dl.progress.done + dl.progress.skipped} di ${dl.progress.total} tile${dl.progress.failed ? ` · ${dl.progress.failed} non riuscite` : ''}`
    : dl.result ? resultMessage(dl.result) : '';
  r.retry.hidden = busy || !(dl.result?.failed > 0);

  r.packages.replaceChildren(...(off.packages.length ? off.packages.map((p) => h('li', { class: 'pkg' },
    h('strong', {}, p.name),
    h('span', { class: 'meta' }, `${p.count} tile · ${fmtMB(p.bytes)}${p.failed ? ` · ${p.failed} mancanti` : ''} · ${new Date(p.createdAt).toLocaleDateString('it-IT')}`),
    button('Elimina', async () => {
      if (!await confirmDialog(`Eliminare il pacchetto «${p.name}»? Le tile condivise con altri pacchetti restano.`, 'Elimina')) return;
      try {
        await deletePackage(p.id);
      } catch (err) {
        toast(`Eliminazione non riuscita: ${err.message}`, { error: true });
      }
      loadOfflineMeta();
    }, { class: 'btn danger' }))) : [h('li', { class: 'hint' }, 'Nessun pacchetto scaricato.')]));
  r.storage.textContent = off.info
    ? `Spazio usato: ${fmtMB(off.info.usageBytes)} di ${fmtMB(off.info.quotaBytes)}${off.info.persisted ? '' : ' · il sistema potrebbe cancellare i dati se manca spazio'}`
    : '';
}

// ---------- Avvio ----------
/**
 * @param {object} actionHandlers  azioni fornite da main.js
 */
export function createUi(actionHandlers) {
  actions = actionHandlers;
  $('btn-tracks').addEventListener('click', () => openSheet('tracks'));
  $('btn-offline').addEventListener('click', () => openSheet('offline'));
  $('btn-locate').addEventListener('click', () => actions.locate());
  $('btn-north').addEventListener('click', () => actions.northUp());
  $('status').addEventListener('click', () => actions.statusTap());
  $('scope').addEventListener('click', (e) => {
    const mode = e.target.dataset?.mode;
    if (mode) actions.setMode(mode);
  });

  const root = document.documentElement;
  new ResizeObserver(() => root.style.setProperty('--panel-h', `${$('panel').offsetHeight}px`)).observe($('panel'));

  return {
    renderStatus, renderBanner, renderPanel, setViewMode, setNorth, showScrub, hideScrub,
    setTracks, showImportReport, toast, showWelcome, askUpdate,
    getBottomInset: () => $('panel').offsetHeight,
  };
}
