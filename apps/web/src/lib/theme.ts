// App theme state: "light" | "dark" | "system", persisted in localStorage
// under the `theme` key. public/theme.js applies the same logic pre-paint;
// this module owns everything after hydration. Keep the two in sync.

import { useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "theme";

// Cross-component change notifications (multiple useTheme() instances).
const listeners = new Set<() => void>();

export function getTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    /* localStorage unavailable */
  }
  return "system";
}

function prefersDark(): MediaQueryList {
  return window.matchMedia("(prefers-color-scheme: dark)");
}

/** Applies the resolved theme to <html>: `dark` class + native color-scheme. */
function applyTheme(theme: Theme): void {
  const dark =
    theme === "dark" || (theme === "system" && prefersDark().matches);
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* persistence is best-effort */
  }
  applyTheme(theme);
  for (const notify of listeners) notify();
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void } {
  const [theme, setLocal] = useState<Theme>(getTheme);

  // Stay in sync when another component (or tab focusing later) changes it.
  useEffect(() => {
    const onChange = () => setLocal(getTheme());
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  // In system mode, follow OS-level scheme changes live.
  useEffect(() => {
    if (theme !== "system") return;
    const mq = prefersDark();
    const onMq = () => applyTheme("system");
    mq.addEventListener("change", onMq);
    return () => mq.removeEventListener("change", onMq);
  }, [theme]);

  return { theme, setTheme };
}
