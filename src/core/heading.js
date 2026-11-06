// Funzioni di orientamento pure (gradi). Nessuna dipendenza dal DOM.

const DEG = Math.PI / 180;

/**
 * Normalizza un angolo in [0,360).
 * @param {number} d
 * @returns {number}
 */
export function normalizeDeg(d) {
  return ((d % 360) + 360) % 360;
}

/**
 * Differenza più breve con segno da `from` a `to`, in (-180,180].
 * @param {number} from
 * @param {number} to
 * @returns {number}
 */
export function angleDiffDeg(from, to) {
  let d = normalizeDeg(to - from);
  if (d > 180) d -= 360;
  return d;
}

/**
 * Direzione della bussola (gradi dal nord) convertita in angolo sullo schermo,
 * tenendo conto della rotazione del dispositivo.
 * @param {number} compass
 * @param {number} screenAngle
 * @returns {number}
 */
export function screenHeading(compass, screenAngle) {
  return normalizeDeg(compass + screenAngle);
}

/**
 * Rotazione della mappa (setBearing) che porta la direzione `h` in alto.
 * @param {number} h
 * @returns {number}
 */
export function bearingForHeading(h) {
  return normalizeDeg(360 - h);
}

/**
 * Angolo sullo schermo di una direzione geografica con la mappa ruotata di `mapBearing`.
 * @param {number} geo
 * @param {number} mapBearing
 * @returns {number}
 */
export function screenBearing(geo, mapBearing) {
  return normalizeDeg(geo + mapBearing);
}

/**
 * Ruota il vettore (dx,dy) di `deg` gradi in senso orario sullo schermo (y verso il basso).
 * @param {number} dx
 * @param {number} dy
 * @param {number} deg
 * @returns {{x:number, y:number}}
 */
export function rotateOffset(dx, dy, deg) {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

/**
 * Filtro circolare della direzione (media esponenziale sui vettori unitari).
 * Il tempo è sempre passato esplicitamente.
 *
 * - `push` ignora campioni con heading o timestamp non finiti.
 * - `accuracy` assente = affidabile; `accuracy` non finita, `< 0` o `> maxAccuracy` = inaffidabile
 *   (il campione non entra nella media).
 * - `read(now)` restituisce `{deg, reliable}`: `reliable` è false se non ci sono campioni affidabili
 *   o se l'ultimo è più vecchio di `staleMs`; `deg` resta l'ultimo valore noto.
 *
 * @param {{tauMs?:number, maxAccuracy?:number, staleMs?:number}} [opts]
 */
export function createHeadingFilter({ tauMs = 300, maxAccuracy = 30, staleMs = 3000 } = {}) {
  /** @type {{x:number, y:number}|null} */
  let mean = null;
  let lastDeg = null;
  let lastT = 0;

  return {
    /**
     * @param {{heading:number, accuracy?:number, timestamp:number}} s
     */
    push({ heading, accuracy, timestamp }) {
      if (!Number.isFinite(heading) || !Number.isFinite(timestamp)) return;
      if (accuracy !== undefined && !(Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= maxAccuracy)) return;

      const tx = Math.cos(heading * DEG);
      const ty = Math.sin(heading * DEG);
      if (mean === null) {
        mean = { x: tx, y: ty };
        lastT = timestamp;
      } else {
        // dt<=0 (campioni fuori ordine o doppi) non sposta la media e non fa NaN.
        const dt = Math.max(0, timestamp - lastT);
        const a = dt > 0 ? 1 - Math.exp(-dt / tauMs) : 0;
        mean = { x: mean.x * (1 - a) + tx * a, y: mean.y * (1 - a) + ty * a };
        lastT = Math.max(lastT, timestamp);
      }
      lastDeg = normalizeDeg(Math.atan2(mean.y, mean.x) / DEG);
    },

    /**
     * @param {number} nowMs
     * @returns {{deg:number|null, reliable:boolean}}
     */
    read(nowMs) {
      if (lastDeg === null) return { deg: null, reliable: false };
      return { deg: lastDeg, reliable: nowMs - lastT <= staleMs };
    },
  };
}

/**
 * Coefficiente di avvicinamento esponenziale per un passo di `dtMs` con costante di tempo `tauMs`:
 * 0 senza tempo trascorso, tende a 1 per dt grandi, 1 se `tauMs` non è positivo. Indipendente dal frame rate.
 * @param {number} dtMs
 * @param {number} tauMs
 * @returns {number} in [0,1]
 */
export function dampFactor(dtMs, tauMs) {
  if (!Number.isFinite(dtMs) || dtMs <= 0) return 0;
  if (!(tauMs > 0)) return 1;
  return 1 - Math.exp(-dtMs / tauMs);
}

/**
 * Un passo di smorzamento esponenziale di un valore lineare verso `target`.
 * @param {number} current
 * @param {number} target
 * @param {number} dtMs
 * @param {number} tauMs
 * @returns {number}
 */
export function dampStep(current, target, dtMs, tauMs) {
  return current + (target - current) * dampFactor(dtMs, tauMs);
}

/**
 * Come `dampStep` per un angolo in gradi: passa sempre dalla parte corta (350 → 10 attraversa lo 0),
 * a 180 gradi esatti gira in senso orario. Il risultato è in [0,360).
 * @param {number} current
 * @param {number} target
 * @param {number} dtMs
 * @param {number} tauMs
 * @returns {number}
 */
export function dampAngleStep(current, target, dtMs, tauMs) {
  return normalizeDeg(current + angleDiffDeg(current, target) * dampFactor(dtMs, tauMs));
}
