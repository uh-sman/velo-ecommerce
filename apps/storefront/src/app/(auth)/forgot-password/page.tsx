import type { Metadata } from "next";

import { ForgotPasswordForm } from "@/components/auth/recovery-forms";

export const metadata: Metadata = { title: "Reset your password" };

export default function ForgotPasswordPage() {
  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Reset your password</h1>
      <ForgotPasswordForm />
    </>
  );
}
