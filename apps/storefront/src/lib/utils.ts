import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Join class names; later Tailwind utilities override conflicting earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** An absolute API URL, for things the browser opens directly — PDFs, say. */
export function apiUrl(path: string): string {
  const base = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:8000";
  return `${base}${path}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
