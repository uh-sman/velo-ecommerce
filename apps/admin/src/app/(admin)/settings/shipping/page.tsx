import type { Metadata } from "next";

import { ShippingZones } from "@/components/settings/shipping-zones";

export const metadata: Metadata = { title: "Shipping settings" };

export default function ShippingSettingsPage() {
  return <ShippingZones />;
}
