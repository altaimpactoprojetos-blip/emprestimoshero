/** Modo escuro opcional, guardado no navegador. */
export type Theme = 'light' | 'dark';
const KEY = 'theme';

export function getTheme(): Theme {
  try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}

export function applyTheme(t: Theme = getTheme()) {
  document.documentElement.setAttribute('data-theme', t);
}

export function setTheme(t: Theme) {
  try { localStorage.setItem(KEY, t); } catch { /* navegação privada */ }
  applyTheme(t);
}
