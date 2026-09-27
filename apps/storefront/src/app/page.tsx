import { createApiClient, type Schema } from "@velo/api-client";

import { ThemeToggle } from "@/components/theme-toggle";

/**
 * The walking skeleton (PLANNING.md Phase 3, M1).
 *
 * A Server Component reads a value the API read from Postgres, and renders it.
 * Trivial in content; it proves every link in the chain — browser, Next.js
 * server, API, database, and the generated client's types — before a single
 * feature depends on them.
 */

async function getSystemInfo(): Promise<Schema<"SystemInfoResponse"> | null> {
  try {
    const { data } = await createApiClient().GET("/api/v1/system/info", {
      // Never cached: this page exists to report the live state of the stack.
      cache: "no-store",
    });
    return data ?? null;
  } catch {
    return null;
  }
}

export default async function HomePage() {
  const info = await getSystemInfo();

  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 px-4 py-16">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Velo Commerce</h1>
          <p className="text-text-secondary mt-2">Walking skeleton — Phase 3, milestone M1.</p>
        </div>
        <ThemeToggle />
      </header>

      <section
        aria-labelledby="stack-heading"
        className="border-border-subtle bg-surface-raised rounded-lg border p-6 shadow-sm"
      >
        <h2 id="stack-heading" className="text-lg font-medium">
          Stack status
        </h2>

        {info ? (
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
            <dt className="text-text-secondary">API version</dt>
            <dd className="tabular">{info.api_version}</dd>

            <dt className="text-text-secondary">Environment</dt>
            <dd>{info.environment}</dd>

            <dt className="text-text-secondary">Database</dt>
            <dd>{info.database_version}</dd>

            <dt className="text-text-secondary">Database time (UTC)</dt>
            <dd className="tabular">{info.database_time}</dd>
          </dl>
        ) : (
          /* An error state, not a blank panel — the rule applies to the
             skeleton as much as to the storefront (DESIGN-SYSTEM.md §4). */
          <div className="border-border-default bg-surface-sunken mt-4 rounded-md border p-4">
            <p className="font-medium">The API is not answering.</p>
            <p className="text-text-secondary mt-1 text-sm">
              Start the containers with <code className="font-mono">pnpm infra:up</code>, then the
              API with <code className="font-mono">uv run uvicorn velo.main:app --reload</code> in{" "}
              <code className="font-mono">apps/api</code>.
            </p>
          </div>
        )}
      </section>

      <footer className="text-text-tertiary text-sm">
        Next: Phase 4 — database and migrations. See <code className="font-mono">PLANNING.md</code>.
      </footer>
    </div>
  );
}
