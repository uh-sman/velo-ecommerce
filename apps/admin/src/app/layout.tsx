import type { Metadata, Viewport } from "next";

import { ThemeScript } from "@/components/theme-script";
import { Toaster } from "@/components/ui/sonner";

import { fontVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Velo Admin", template: "%s · Velo Admin" },
  description: "Operator dashboard.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-dvh antialiased">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
