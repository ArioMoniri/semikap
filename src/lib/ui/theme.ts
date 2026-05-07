/**
 * Theme management. Persists the user's preference in localStorage and
 * applies it as a class on <html>. Defaults to "system" — track the OS
 * preference unless the user explicitly overrides.
 */

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'tamias-theme';

export function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  const v = window.localStorage.getItem(STORAGE_KEY);
  if (v === 'light' || v === 'dark' || v === 'system') return v;
  return 'system';
}

export function storeTheme(theme: Theme): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, theme);
}

export function effectiveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const isDark = effectiveTheme(theme) === 'dark';
  document.documentElement.classList.toggle('dark', isDark);
  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
}

/**
 * Run once at app boot to apply the persisted theme and start tracking the
 * system preference (when the choice is "system"). Returns a teardown function.
 */
export function initTheme(): () => void {
  const stored = readStoredTheme();
  applyTheme(stored);
  if (stored !== 'system' || typeof window === 'undefined') return () => undefined;
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => applyTheme('system');
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}
