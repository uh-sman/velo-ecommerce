import type { Metadata } from "next";

import { VerifyEmail } from "@/components/auth/recovery-forms";

export const metadata: Metadata = { title: "Confirm your email", referrer: "no-referrer" };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Confirm your email</h1>
      <VerifyEmail token={token ?? ""} />
    </>
  );
}
