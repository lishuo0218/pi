// Theme management (M4): light/dark with system default. Persisted choice in
// localStorage; applied to <html data-theme> before first paint via the
// inline call in main.tsx.

const STORAGE_KEY = "pi-web-theme";

export type Theme = "light" | "dark";

export function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function currentTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return systemTheme();
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** Set initial theme. Returns the effective theme for the toggle button. */
export function initTheme(): Theme {
  const theme = currentTheme();
  applyTheme(theme);
  return theme;
}

/** Cycle light -> dark -> system default? No: toggle binary, persist it. */
export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  localStorage.setItem(STORAGE_KEY, next);
  applyTheme(next);
  return next;
}

/** Follow system when no explicit choice exists; called once at mount. */
export function watchSystemTheme(onChange: (theme: Theme) => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = (): void => {
    if (localStorage.getItem(STORAGE_KEY) === null) {
      applyTheme(systemTheme());
      onChange(systemTheme());
    }
  };
  mq.addEventListener("change", listener);
  return () => mq.removeEventListener("change", listener);
}
