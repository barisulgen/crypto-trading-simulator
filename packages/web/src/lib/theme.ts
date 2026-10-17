// Dark is the default; the choice is remembered per browser (index.html applies it before paint).
export type Theme = 'dark' | 'light';

const KEY = 'sim-theme';

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // storage unavailable: the choice lasts until reload
  }
}
