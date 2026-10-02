import type { Metadata } from "next";

import { PaymentProviders } from "@/components/settings/general-settings";

export const metadata: Metadata = { title: "Payment settings" };

export default function PaymentSettingsPage() {
  return <PaymentProviders />;
}
