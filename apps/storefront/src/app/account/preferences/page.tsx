import type { Metadata } from "next";

import { EmailPreferences } from "@/components/email/preferences";

export const metadata: Metadata = { title: "Email preferences" };

export default function PreferencesPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Email preferences</h1>
      <EmailPreferences />
    </div>
  );
}
