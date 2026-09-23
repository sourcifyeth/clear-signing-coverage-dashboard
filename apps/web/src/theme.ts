/**
 * Color theme: "light", "dark", or "system" (follow the OS setting; the
 * default). The choice is kept in localStorage; the resolved theme goes on
 * <html data-theme="light|dark">, which the stylesheet's tokens key on.
 * index.html runs the same logic inline before the first paint.
 */
export type ThemePref = "light" | "dark" | "system";

const KEY = "ccd.theme";
const mq = () => window.matchMedia("(prefers-color-scheme: dark)");

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* storage blocked: system */
  }
  return "system";
}

export function resolveTheme(pref: ThemePref): "light" | "dark" {
  if (pref === "system") return mq().matches ? "dark" : "light";
  return pref;
}

export function applyThemePref(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* ignore */
  }
  document.documentElement.dataset.theme = resolveTheme(pref);
}

/** Follow OS changes while the preference is "system". Returns the unsubscribe. */
export function watchSystemTheme(getPref: () => ThemePref): () => void {
  const m = mq();
  const onChange = () => {
    if (getPref() === "system") document.documentElement.dataset.theme = m.matches ? "dark" : "light";
  };
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
}
