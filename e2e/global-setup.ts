/**
 * Before the journeys: a known store.
 *
 * 1. Create `velo_e2e` if it does not exist, and migrate it to head.
 * 2. Empty the E2E Redis database (queues, sandbox intents, rate limits).
 * 3. Reset and reseed: the demo catalog, the admin and the demo customer.
 * 4. Rebuild the `products_e2e` search index from the new catalog.
 *
 * Playwright starts the webServers before this runs; the API and worker cope
 * with the reset (they hold no catalog state: the catalog cache is off in
 * env.ts). If you keep the servers running between runs
 * (reuseExistingServer), restart the storefront too, or set E2E_SKIP_RESET=1:
 * its server keeps product pages for a minute, and a reseed gives every
 * variant a new id.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

import { apiEnv } from "./env";
import { flushE2eRedis } from "./support/redis";

const apiDir = path.resolve(__dirname, "../apps/api");

function run(what: string, args: string[]): void {
  const started = Date.now();
  const result = spawnSync("uv", ["run", ...args], {
    cwd: apiDir,
    env: { ...process.env, ...apiEnv },
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(
      `global-setup: ${what} failed (exit ${String(result.status)})\n${result.stdout}\n${result.stderr}`,
    );
  }
  console.log(`[e2e] ${what} (${String(Math.round((Date.now() - started) / 1000))} s)`);
}

const CREATE_DATABASE = `
import asyncio, os, asyncpg
from sqlalchemy.engine import make_url

async def main():
    url = make_url(os.environ["VELO_DATABASE_URL"])
    conn = await asyncpg.connect(
        host=url.host, port=url.port, user=url.username, password=url.password, database="postgres"
    )
    try:
        exists = await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", url.database)
        if not exists:
            await conn.execute(f'CREATE DATABASE "{url.database}"')
            print(f"created {url.database}")
    finally:
        await conn.close()

asyncio.run(main())
`;

export default async function globalSetup(): Promise<void> {
  if (process.env["E2E_SKIP_RESET"] === "1") {
    console.log("[e2e] E2E_SKIP_RESET=1: using velo_e2e as it is");
    return;
  }
  const database = apiEnv["VELO_DATABASE_URL"] ?? "";
  if (!database.endsWith("/velo_e2e")) {
    throw new Error(`Refusing to reset ${database}: the suite only ever resets velo_e2e.`);
  }
  run("database exists", ["python", "-c", CREATE_DATABASE]);
  run("migrated", ["alembic", "upgrade", "head"]);
  await flushE2eRedis();
  run("reseeded", ["python", "-m", "velo.scripts.seed", "--reset"]);
  run("search reindexed", ["python", "-m", "velo.scripts.reindex"]);
}
