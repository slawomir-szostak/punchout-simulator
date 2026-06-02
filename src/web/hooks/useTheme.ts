import { useSyncExternalStore } from "react";

// A tiny global theme store. The choice is mirrored onto
// document.documentElement[data-theme] (which drives the CSS variables) and
// persisted in localStorage. An inline script in index.html applies it before
// first paint to avoid a flash; this module keeps it in sync at runtime.

export type Theme = "dark" | "light";
const KEY = "pos-theme";

function readInitial(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    /* ignore */
  }
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

let current: Theme = readInitial();
const listeners = new Set<() => void>();

function apply(next: Theme) {
  current = next;
  if (typeof document !== "undefined") document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

// Reflect the resolved value onto the DOM at module load (covers the case where
// the index.html inline guard didn't run, e.g. tests).
if (typeof document !== "undefined") document.documentElement.dataset.theme = current;

export function setTheme(theme: Theme): void {
  apply(theme);
}
export function toggleTheme(): void {
  apply(current === "dark" ? "light" : "dark");
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => current,
  );
}
