import type { Metadata } from "next";
import { Suspense } from "react";

import { AcceptInviteForm } from "@/components/auth/accept-invite-form";

export const metadata: Metadata = { title: "Join the team" };

export default function AcceptInvitePage() {
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4">
      <div>
        <p className="text-lg font-semibold tracking-tight">
          Velo <span className="text-text-secondary font-normal">Admin</span>
        </p>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">Join the team</h1>
        <p className="text-text-secondary mt-1 text-sm">
          New here? Choose a password. Already have a Velo account with this email? Leave the
          password empty — you will sign in with the one you have.
        </p>
      </div>
      <Suspense>
        <AcceptInviteForm />
      </Suspense>
    </main>
  );
}
