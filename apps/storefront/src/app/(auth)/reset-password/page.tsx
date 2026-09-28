import type { Metadata } from "next";

import { ResetPasswordForm } from "@/components/auth/recovery-forms";

export const metadata: Metadata = {
  title: "Choose a new password",
  // The token is in the URL: keep it out of other sites' Referer headers.
  referrer: "no-referrer",
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Choose a new password</h1>
      <ResetPasswordForm token={token ?? ""} />
    </>
  );
}
