import Link from "next/link";

import { AdminShell } from "@/components/shell/admin-shell";
import { MeProvider } from "@/components/shell/me-context";
import { SessionGate } from "@/components/shell/session-gate";
import { getMe } from "@/lib/api-server";

/** Every admin page: signed in, with admin access, inside the shell. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const me = await getMe();
  if (me === null) return <SessionGate />;
  if (me === "forbidden") {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 px-4 py-24 text-center">
        <h1 className="text-2xl font-semibold">This account has no admin access</h1>
        <p className="text-text-secondary">
          Ask an owner to invite you, or sign in with your staff account.
        </p>
        <Link href="/sign-in" className="underline underline-offset-4">
          Sign in with another account
        </Link>
      </div>
    );
  }
  return (
    <MeProvider me={me}>
      <AdminShell>{children}</AdminShell>
    </MeProvider>
  );
}
