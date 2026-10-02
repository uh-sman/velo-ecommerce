import type { Metadata } from "next";

import { EmailSettings } from "@/components/settings/general-settings";

export const metadata: Metadata = { title: "Email settings" };

export default function EmailSettingsPage() {
  return <EmailSettings />;
}
