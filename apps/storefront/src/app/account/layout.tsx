import type { Metadata } from "next";

import { AccountNav } from "@/components/account/account-nav";
import { SessionRecovery } from "@/components/auth/session-recovery";
import { getSessionUser } from "@/lib/api-server";

export const metadata: Metadata = { title: "Your account", robots: { index: false } };

export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) return <SessionRecovery />;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-10 lg:flex-row lg:gap-12">
      <AccountNav />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
