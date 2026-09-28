import type { Metadata } from "next";

import { CreateAccountForm } from "@/components/auth/create-account-form";
import { safeNext } from "@/lib/api-browser";

export const metadata: Metadata = { title: "Create an account" };

export default async function CreateAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Create an account</h1>
      <CreateAccountForm next={safeNext(next)} />
    </>
  );
}
