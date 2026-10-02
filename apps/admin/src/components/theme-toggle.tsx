"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "velo-theme";

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }
}

/**
 * Three states, not two. A binary toggle strands anyone who wants to follow
 * their system setting once they have touched it.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "light" || stored === "dark") setTheme(stored);
    } catch {
      // Storage unavailable: the system preference stands.
    }
  }, []);

  function choose(next: Theme): void {
    setTheme(next);
    applyTheme(next);
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice still applies for this page view.
    }
  }

  return (
    <fieldset className="border-border-subtle flex items-center gap-1 rounded-full border p-1">
      <legend className="sr-only">Colour theme</legend>
      {(["light", "system", "dark"] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => {
            choose(option);
          }}
          aria-pressed={theme === option}
          className={[
            "rounded-full px-3 py-1 text-sm capitalize transition-colors",
            "focus-visible:outline-border-focus focus-visible:outline-2 focus-visible:outline-offset-2",
            theme === option
              ? "bg-brand text-text-on-brand"
              : "text-text-secondary hover:bg-surface-sunken",
          ].join(" ")}
        >
          {option}
        </button>
      ))}
    </fieldset>
  );
}
