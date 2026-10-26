export type AppFont = 'rubik' | 'inter' | 'geist';

export const APP_FONTS: readonly { id: AppFont; label: string }[] = [
  { id: 'rubik', label: 'Rubik' },
  { id: 'inter', label: 'Inter' },
  { id: 'geist', label: 'Geist' },
];

const STORAGE_KEY = 'earlybird-font';
const DEFAULT_FONT: AppFont = 'rubik';

function isAppFont(value: unknown): value is AppFont {
  return APP_FONTS.some((font) => font.id === value);
}

export function getFont(): AppFont {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isAppFont(stored) ? stored : DEFAULT_FONT;
  } catch {
    return DEFAULT_FONT;
  }
}

export function applyFont(font: AppFont): void {
  document.documentElement.dataset.font = font;
}

export function setFont(font: AppFont): void {
  try {
    localStorage.setItem(STORAGE_KEY, font);
  } catch {
    // non-fatal: the choice just won't persist
  }
  applyFont(font);
}
