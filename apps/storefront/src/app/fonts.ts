import { Inter, JetBrains_Mono } from "next/font/google";

/**
 * Downloaded at build time and served from this origin: no request to Google
 * at runtime, subset to Latin, preloaded, `font-display: swap`
 * (DESIGN-SYSTEM.md §7). The CSS variables feed `--font-sans` / `--font-mono`
 * in packages/config/tailwind/tokens.css.
 */
export const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

export const fontVariables = `${inter.variable} ${jetbrainsMono.variable}`;
