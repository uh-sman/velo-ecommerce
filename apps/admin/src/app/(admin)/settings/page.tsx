import type { Metadata } from "next";

import { StoreSettings } from "@/components/settings/general-settings";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return <StoreSettings />;
}
