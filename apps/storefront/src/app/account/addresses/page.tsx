import type { Metadata } from "next";

import { AddressBook } from "@/components/account/address-book";

export const metadata: Metadata = { title: "Addresses" };

export default function AddressesPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Addresses</h1>
      <AddressBook />
    </div>
  );
}
