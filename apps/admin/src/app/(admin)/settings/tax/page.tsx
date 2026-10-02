import type { Metadata } from "next";

import { TaxRates } from "@/components/settings/tax-rates";

export const metadata: Metadata = { title: "Tax settings" };

export default function TaxSettingsPage() {
  return <TaxRates />;
}
