import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Traced standalone server — what docker/web.Dockerfile ships. Opt-in, because
  // tracing creates symlinks and Windows refuses those without Developer Mode.
  ...(process.env["NEXT_OUTPUT_STANDALONE"] === "1" && { output: "standalone" }),
  outputFileTracingRoot: path.join(__dirname, "../.."),

  // Every image is served AVIF-first with a WebP fallback (DESIGN-SYSTEM.md §7).
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [],
  },

  // A type error must fail the build. Shipping past one is how a response-shape
  // change reaches a customer's browser (ADR-001).
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default config;
