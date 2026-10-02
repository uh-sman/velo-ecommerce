import type { Metadata } from "next";

import { PageHeader } from "@/components/page";
import { AuditLog } from "@/components/people/audit-log";
import { RequirePermission } from "@/components/people/shared";

export const metadata: Metadata = { title: "Audit log" };

export default function AuditPage() {
  return (
    <RequirePermission permission="audit:read" title="Audit log">
      <PageHeader title="Audit log" description="Who changed what, and when — newest first." />
      <AuditLog />
    </RequirePermission>
  );
}
