// The API and its worker, as one webServer for Playwright (e2e/playwright.config.ts).
//
// One process, so that "reuse the running API" also means "reuse its worker":
// orders are created by the worker from the payment event, and a run without
// one would wait on every confirmation page. If either child dies, both go.
//
// The environment (database, Redis, sandbox payments) comes from env.ts via
// the webServer's `env`.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/api");
const port = process.env.E2E_API_PORT ?? "8100";

// Logs go to e2e/.logs/, the first place to look when a journey fails server-side.
const logDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.logs");
mkdirSync(logDir, { recursive: true });

const children = [
  // Idle keep-alive connections outlive a test's pauses (uvicorn's default is
  // 5 s, and a browser that reuses a connection as it closes sees a failed fetch).
  [
    "api",
    [
      "run",
      "uvicorn",
      "velo.main:app",
      "--host",
      "127.0.0.1",
      "--port",
      port,
      "--timeout-keep-alive",
      "75",
    ],
  ],
  ["worker", ["run", "arq", "velo.worker.WorkerSettings"]],
].map(([name, args]) => {
  const log = openSync(path.join(logDir, `${name}.log`), "w");
  return spawn("uv", args, { cwd: apiDir, stdio: ["ignore", log, log] });
});

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    // On Windows `kill` stops uv but not the Python process under it: take the tree.
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else child.kill();
  }
  process.exit(code);
}

for (const child of children) {
  child.on("exit", (code) => {
    stop(code ?? 1);
  });
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
