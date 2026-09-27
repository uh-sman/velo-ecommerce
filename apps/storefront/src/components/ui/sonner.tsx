"use client";

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { Toaster as Sonner, toast, type ExternalToast, type ToasterProps } from "sonner";

/*
 * Vendored from shadcn/ui and adapted to DESIGN-SYSTEM.md §4 "Toast":
 * - theme follows Velo's own `data-theme` attribute (no next-themes)
 * - bottom-right on desktop, top on mobile, where bottom toasts collide with
 *   thumbs and the sticky add-to-cart bar
 * - at most three stacked
 * - per-variant durations via `notify`, and errors never auto-dismiss
 */

function subscribeToTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    observer.disconnect();
  };
}

function currentTheme(): "light" | "dark" | "system" {
  const value = document.documentElement.getAttribute("data-theme");
  return value === "light" || value === "dark" ? value : "system";
}

const DESKTOP = "(min-width: 768px)";

function subscribeToViewport(onChange: () => void): () => void {
  const query = window.matchMedia(DESKTOP);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

export function Toaster(props: ToasterProps) {
  const theme = useSyncExternalStore(subscribeToTheme, currentTheme, () => "system" as const);
  const isDesktop = useSyncExternalStore(
    subscribeToViewport,
    () => window.matchMedia(DESKTOP).matches,
    () => true,
  );

  return (
    <Sonner
      theme={theme}
      position={isDesktop ? "bottom-right" : "top-center"}
      visibleToasts={3}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" aria-hidden />,
        info: <InfoIcon className="size-4" aria-hidden />,
        warning: <TriangleAlertIcon className="size-4" aria-hidden />,
        error: <OctagonXIcon className="size-4" aria-hidden />,
        loading: <Loader2Icon className="size-4 animate-spin" aria-hidden />,
      }}
      style={
        {
          "--normal-bg": "var(--surface-raised)",
          "--normal-text": "var(--text-primary)",
          "--normal-border": "var(--border-default)",
          "--border-radius": "var(--radius-md)",
        } as CSSProperties
      }
      {...props}
    />
  );
}

/** Auto-dismiss per variant, in ms. `Infinity` keeps the toast until dismissed. */
export const TOAST_DURATION = {
  success: 4000,
  info: 4000,
  warning: 6000,
  error: Number.POSITIVE_INFINITY,
} as const;

type Options = Omit<ExternalToast, "duration">;

/**
 * The only way the app should raise a toast, so the durations above cannot be
 * overridden call by call. Never for payment outcomes — those are page states.
 */
export const notify = {
  success: (message: ReactNode, options?: Options) =>
    toast.success(message, { ...options, duration: TOAST_DURATION.success }),
  info: (message: ReactNode, options?: Options) =>
    toast.info(message, { ...options, duration: TOAST_DURATION.info }),
  warning: (message: ReactNode, options?: Options) =>
    toast.warning(message, { ...options, duration: TOAST_DURATION.warning }),
  error: (message: ReactNode, options?: Options) =>
    toast.error(message, { ...options, duration: TOAST_DURATION.error, dismissible: true }),
};
