import type { Metadata } from "next";

import { PageHeader } from "@/components/page";
import { RequirePermission } from "@/components/people/shared";
import { StaffTeam } from "@/components/people/staff-team";

export const metadata: Metadata = { title: "Staff" };

export default function StaffPage() {
  return (
    <RequirePermission permission="staff:manage" title="Staff">
      <PageHeader title="Staff" description="Who can sign in to the admin, and what each may do." />
      <StaffTeam />
    </RequirePermission>
  );
}
