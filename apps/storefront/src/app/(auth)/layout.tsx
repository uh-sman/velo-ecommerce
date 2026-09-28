/*
 * The shared shell for sign-in, create-account, and recovery pages
 * (PAGE-SPECS.md §2.1): a centred card, at most 400px wide.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[calc(100dvh-4rem)] items-start justify-center px-4 py-12 sm:items-center">
      <div className="border-border-subtle bg-surface-raised w-full max-w-[400px] rounded-lg border p-6 shadow-sm sm:p-8">
        {children}
      </div>
    </div>
  );
}
