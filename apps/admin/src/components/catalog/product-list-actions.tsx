"use client";

import { DownloadIcon, PlusIcon, UploadIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { downloadCatalogExport } from "@/components/catalog/shared";
import { IfCan } from "@/components/shell/me-context";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/sonner";

/** The product list's header actions: export for anyone who can read, the rest for writers. */
export function ProductListActions() {
  return (
    <>
      <ExportButton />
      <IfCan permission="catalog:write">
        <Button asChild variant="outline">
          <Link href="/products/import">
            <UploadIcon aria-hidden />
            Import CSV
          </Link>
        </Button>
        <Button asChild>
          <Link href="/products/new">
            <PlusIcon aria-hidden />
            New product
          </Link>
        </Button>
      </IfCan>
    </>
  );
}

export function ExportButton({ label = "Export CSV" }: { label?: string }) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="outline"
      loading={pending}
      onClick={() => {
        setPending(true);
        void downloadCatalogExport().then((failure) => {
          setPending(false);
          if (failure) notify.error(`Export failed: ${failure}`);
          else notify.success("Catalog exported");
        });
      }}
    >
      <DownloadIcon aria-hidden />
      {label}
    </Button>
  );
}
