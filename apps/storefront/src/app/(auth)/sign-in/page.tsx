import type { Metadata } from "next";

import { SignInForm } from "@/components/auth/sign-in-form";
import { safeNext } from "@/lib/api-browser";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Sign in</h1>
      <SignInForm next={safeNext(next)} />
    </>
  );
}
