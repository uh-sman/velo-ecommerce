import type { Metadata } from "next";
import { Suspense } from "react";

import { SignInForm } from "@/components/auth/sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4">
      <div>
        <p className="text-lg font-semibold tracking-tight">
          Velo <span className="text-text-secondary font-normal">Admin</span>
        </p>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-text-secondary mt-1 text-sm">With your staff account.</p>
      </div>
      <Suspense>
        <SignInForm />
      </Suspense>
    </main>
  );
}
