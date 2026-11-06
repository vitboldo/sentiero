// Bussola: permesso iOS, ascolto di deviceorientation, direzione filtrata del telefono.
import { createHeadingFilter, screenHeading } from '../core/heading.js';

/**
 * @param {{onStatus?: (status: string) => void}} [hooks]
 * Stati: 'idle' (mai richiesta), 'active', 'denied', 'unavailable'.
 */
export function createCompass({ onStatus } = {}) {
  const filter = createHeadingFilter();
  let status = 'idle';
  let wanted = false; // permesso ottenuto: ascolta quando la pagina è visibile
  let attached = false;
  let gotSample = false;
  let pending = null;

  const setStatus = (next) => {
    if (next === status) return;
    status = next;
    onStatus?.(status);
  };

  function onOrientation(e) {
    let heading;
    let accuracy;
    if (Number.isFinite(e.webkitCompassHeading)) {
      heading = e.webkitCompassHeading;
      accuracy = Number.isFinite(e.webkitCompassAccuracy) ? e.webkitCompassAccuracy : undefined;
    } else if (e.absolute && Number.isFinite(e.alpha)) {
      heading = 360 - e.alpha;
    } else {
      return;
    }
    gotSample = true;
    filter.push({ heading: screenHeading(heading, screen.orientation?.angle ?? 0), accuracy, timestamp: Date.now() });
  }

  function attach() {
    if (attached) return;
    attached = true;
    addEventListener('deviceorientation', onOrientation);
  }

  function detach() {
    if (!attached) return;
    attached = false;
    removeEventListener('deviceorientation', onOrientation);
  }

  function start() {
    wanted = true;
    if (document.visibilityState === 'visible') attach();
    setStatus('active');
  }

  // Pagina nascosta: niente ascolto (batteria); al ritorno si riprende senza richiedere di nuovo il permesso.
  document.addEventListener('visibilitychange', () => {
    if (!wanted) return;
    if (document.visibilityState === 'visible') attach();
    else detach();
  });

  return {
    /**
     * Da chiamare DENTRO un gestore di click, prima di qualsiasi await: iOS rifiuta la richiesta fuori da un gesto.
     * Il permesso non è salvato: se iOS lo dimentica, il tocco successivo lo richiede di nuovo.
     * @returns {Promise<string>} lo stato risultante
     */
    request() {
      if (status === 'active' || status === 'unavailable') return Promise.resolve(status);
      if (pending) return pending;
      if (typeof DeviceOrientationEvent === 'undefined') {
        setStatus('unavailable');
        return Promise.resolve(status);
      }
      if (typeof DeviceOrientationEvent.requestPermission !== 'function') {
        start();
        return Promise.resolve(status);
      }
      let asked;
      try {
        asked = Promise.resolve(DeviceOrientationEvent.requestPermission()); // chiamata sincrona
      } catch {
        asked = Promise.reject(new Error('requestPermission'));
      }
      pending = asked.then(
        (answer) => {
          if (answer === 'granted') start();
          else setStatus('denied');
          return status;
        },
        () => {
          setStatus('denied');
          return status;
        },
      ).finally(() => { pending = null; });
      return pending;
    },

    status: () => status,
    isActive: () => status === 'active',
    /** Attiva e con almeno una misura ricevuta: solo allora la navigazione ha senso. */
    canNavigate: () => status === 'active' && gotSample,
    /** @returns {{deg:number|null, reliable:boolean}} direzione verso cui punta la parte alta dello schermo */
    read: (now = Date.now()) => filter.read(now),
  };
}
