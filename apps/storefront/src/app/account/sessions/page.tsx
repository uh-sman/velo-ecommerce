import type { Metadata } from "next";

import { SessionsList } from "@/components/account/sessions-list";

export const metadata: Metadata = { title: "Sessions" };

export default function SessionsPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
        <p className="text-text-secondary mt-1">
          Devices signed in to your account. Sign out any you do not recognise, then change your
          password.
        </p>
      </header>
      <SessionsList />
    </div>
  );
}
