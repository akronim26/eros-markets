"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export type ThemePreference = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";
const STORAGE_KEY = "eros-theme";
const isPreference = (value: unknown): value is ThemePreference => value === "light" || value === "dark" || value === "system";
const ThemeContext = createContext<{ preference: ThemePreference; resolved: ResolvedTheme; setPreference: (value: ThemePreference) => void } | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // The bootstrap script paints the saved theme; stable initial state keeps hydration consistent.
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [resolved, setResolved] = useState<ResolvedTheme>("light");
  const current = useRef<ThemePreference>("system");
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const apply = useCallback((value: ThemePreference, animate = true) => {
    current.current = value;
    const next = value === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : value;
    const root = document.documentElement;
    clearTimeout(transitionTimer.current);
    if (animate && root.dataset.theme !== next && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      root.dataset.themeTransition = "";
      transitionTimer.current = setTimeout(() => delete root.dataset.themeTransition, 240);
    } else {
      delete root.dataset.themeTransition;
    }
    root.dataset.theme = next;
    root.style.colorScheme = next;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "dark" ? "#101112" : "#F2F1EC");
    setPreferenceState(value);
    setResolved(next);
  }, []);

  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* Theme still works when storage is unavailable. */ }
    apply(isPreference(saved) ? saved : "system", false);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => { if (current.current === "system") apply("system"); };
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) apply(isPreference(event.newValue) ? event.newValue : "system");
    };
    media.addEventListener("change", onSystemChange);
    window.addEventListener("storage", onStorage);
    return () => {
      media.removeEventListener("change", onSystemChange);
      window.removeEventListener("storage", onStorage);
      clearTimeout(transitionTimer.current);
      delete document.documentElement.dataset.themeTransition;
    };
  }, [apply]);

  const setPreference = useCallback((value: ThemePreference) => {
    try { localStorage.setItem(STORAGE_KEY, value); } catch { /* Keep the choice for this session. */ }
    apply(value);
  }, [apply]);

  return <ThemeContext.Provider value={{ preference, resolved, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("useTheme requires ThemeProvider");
  return theme;
}
