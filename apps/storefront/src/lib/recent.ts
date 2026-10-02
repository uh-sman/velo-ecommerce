/**
 * Small per-browser lists kept in localStorage: recent searches, recently
 * viewed products. Conveniences only — storage can be unavailable (private
 * mode, blocked), so every access is guarded and failure means an empty list.
 */

function read(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function write(key: string, values: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // Nothing to do: the list is a convenience.
  }
}

/** Most recent first, without duplicates, capped at ``limit``. */
export function remember(key: string, value: string, limit: number): string[] {
  const trimmed = value.trim();
  if (!trimmed) return read(key);
  const next = [trimmed, ...read(key).filter((v) => v !== trimmed)].slice(0, limit);
  write(key, next);
  return next;
}

export function recall(key: string): string[] {
  return read(key);
}

export function forget(key: string): void {
  write(key, []);
}

export const RECENT_SEARCHES = "velo:recent-searches";
export const RECENTLY_VIEWED = "velo:recently-viewed";
