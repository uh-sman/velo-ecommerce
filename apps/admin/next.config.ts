import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // `radix-ui` is one barrel over every primitive; without this a Server
  // Component importing one (Button's Slot) ships all of them to the client.
  experimental: {
    optimizePackageImports: ["radix-ui"],
  },

  // Traced standalone server — what docker/web.Dockerfile ships. Opt-in, because
  // tracing creates symlinks and Windows refuses those without Developer Mode.
  ...(process.env["NEXT_OUTPUT_STANDALONE"] === "1" && { output: "standalone" }),
  outputFileTracingRoot: path.join(__dirname, "../.."),
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
          // The admin is never indexed. It is a back office, not a page.
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default config;
