import { useEffect, useState } from "react";
import { applyThemePref, readThemePref, resolveTheme, watchSystemTheme, type ThemePref } from "./theme.ts";

const OPTIONS: { value: ThemePref; label: string; glyph: string }[] = [
  { value: "light", label: "Light", glyph: "☀" },
  { value: "system", label: "System", glyph: "◐" },
  { value: "dark", label: "Dark", glyph: "☾" },
];

/**
 * One icon in the top bar (the theme in use); hover or click opens a menu with
 * light / system (default) / dark.
 */
export function ThemeSwitch() {
  const [pref, setPref] = useState<ThemePref>(() => readThemePref());
  const [open, setOpen] = useState(false);
  useEffect(() => {
    applyThemePref(pref);
  }, [pref]);
  useEffect(() => watchSystemTheme(readThemePref), []);
  const current = OPTIONS.find((o) => o.value === resolveTheme(pref)) ?? OPTIONS[1];
  return (
    <div className={`themeMenu ${open ? "open" : ""}`} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="themeBtn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Color theme: ${pref}`}
        title="Color theme"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{current.glyph}</span>
      </button>
      <div className="themePop" role="menu">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="menuitemradio"
            aria-checked={pref === o.value}
            className={pref === o.value ? "on" : ""}
            onClick={() => {
              setPref(o.value);
              setOpen(false);
            }}
          >
            <span aria-hidden="true">{o.glyph}</span>
            {o.label}
            {o.value === "system" && <span className="muted"> · default</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
