/**
 * Admin shell placeholder.
 *
 * The dashboard is Phase 11; its layout, metric tiles, and the "needs
 * attention" block that sits above the charts are specified in
 * docs/PAGE-SPECS.md §3.1. This page exists so the app builds, deploys, and
 * proves its own link in the chain.
 */
export default function DashboardPage() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Velo Admin</h1>
      <p className="text-text-secondary">
        Scaffolded in Phase 3. The dashboard, product editor, order pipeline, and discount builder
        arrive in Phase 11, built to the specifications in{" "}
        <code className="font-mono">docs/PAGE-SPECS.md</code>.
      </p>
      <ul className="text-text-secondary list-inside list-disc text-sm">
        <li>Storefront: http://localhost:3000</li>
        <li>API: http://localhost:8000</li>
        <li>API docs: http://localhost:8000/docs</li>
      </ul>
    </div>
  );
}
