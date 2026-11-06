// Tema dell'interfaccia. Script classico caricato in <head> prima del primo disegno: un modulo partirebbe
// dopo il rendering e l'app lampeggerebbe chiara a ogni avvio.
(() => {
  const KEY = 'sentiero-theme';
  const PREFS = ['light', 'dark', 'auto'];
  const BAR = { light: '#ffffff', dark: '#15181c' }; // come --paper in styles.css
  const system = matchMedia('(prefers-color-scheme: dark)');
  const listeners = new Set();
  let pref = 'light'; // predefinito: il più leggibile al sole

  try {
    const saved = localStorage.getItem(KEY);
    if (PREFS.includes(saved)) pref = saved;
  } catch { /* archivio non disponibile: resta il predefinito */ }

  const resolved = () => (pref === 'auto' ? (system.matches ? 'dark' : 'light') : pref);

  function apply() {
    const theme = resolved();
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BAR[theme]);
    for (const fn of listeners) fn(theme);
  }

  system.addEventListener('change', () => {
    if (pref === 'auto') apply();
  });

  window.sentieroTheme = {
    pref: () => pref,
    /** @param {'light'|'dark'|'auto'} next */
    set(next) {
      if (!PREFS.includes(next)) return;
      pref = next;
      try {
        localStorage.setItem(KEY, next);
      } catch { /* vale fino alla chiusura dell'app */ }
      apply();
    },
    onChange: (fn) => listeners.add(fn),
  };

  apply();
})();
