// A Next.js app as a production server for the E2E run:
//
//   node e2e/servers/web.mjs storefront 3100
//
// Builds first (NEXT_PUBLIC_API_URL is baked in at build time, so a dev build
// would talk to the wrong API) unless E2E_SKIP_BUILD=1, then `next start`.
// The data cache is emptied first: global-setup reseeds the database, and a
// cached product page from the previous run would carry old variant ids.

import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [app, port] = process.argv.slice(2);
if (!app || !port) {
  console.error("usage: node e2e/servers/web.mjs <storefront|admin> <port>");
  process.exit(2);
}

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps", app);
const shell = process.platform === "win32";

rmSync(path.join(appDir, ".next", "cache", "fetch-cache"), { recursive: true, force: true });

if (process.env.E2E_SKIP_BUILD !== "1") {
  const build = spawnSync("pnpm", ["exec", "next", "build"], {
    cwd: appDir,
    stdio: "inherit",
    shell,
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

// Node closes idle keep-alive connections after 5 s by default. WebKit (and
// now and then Chromium) reuses a connection just as the server closes it and
// the request fails outright ("Load failed") — a client-side navigation then
// never completes. The idle timeout outlives any pause in a test.
const server = spawn(
  "pnpm",
  ["exec", "next", "start", "--port", port, "--keepAliveTimeout", "75000"],
  {
    cwd: appDir,
    stdio: "inherit",
    shell,
  },
);
server.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGINT", () => server.kill());
process.on("SIGTERM", () => server.kill());
