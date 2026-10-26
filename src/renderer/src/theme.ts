export type AppTheme = 'light' | 'dark' | 'system';
export function getTheme(): AppTheme {
  try {
    const value = localStorage.getItem('earlybird-theme');
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch { /* Preferences can still apply for this session. */ }
  return 'system';
}
export function applyTheme(theme: AppTheme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark' ||
    (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches));
}
export function setTheme(theme: AppTheme): void {
  try { localStorage.setItem('earlybird-theme', theme); } catch { /* non-fatal */ }
  applyTheme(theme);
}
export function initializeTheme(): void {
  applyTheme(getTheme());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getTheme() === 'system') applyTheme('system');
  });
}
