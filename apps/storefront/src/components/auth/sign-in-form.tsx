"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { FormAlert, PasswordField, TextField } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import {
  callApi,
  describeWait,
  problemSlug,
  refreshSession,
  type Outcome,
} from "@/lib/api-browser";

type Failure = Extract<Outcome<unknown>, { ok: false }>;

export function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  // Already signed in, with only the access cookie expired? Skip the form.
  useEffect(() => {
    let active = true;
    void refreshSession().then((ok) => {
      if (ok && active) router.replace(next);
    });
    return () => {
      active = false;
    };
  }, [next, router]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setFailure(null);
    const outcome = await callApi(
      (client) => client.POST("/api/v1/auth/login", { body: { email, password } }),
      { refreshOnExpiry: false },
    );
    if (outcome.ok) {
      router.replace(next);
      router.refresh();
      return;
    }
    setFailure(outcome);
    setLoading(false);
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-5">
      {failure && <SignInError failure={failure} />}
      <TextField
        label="Email"
        type="email"
        name="email"
        autoComplete="email"
        required
        value={email}
        onChange={(event) => {
          setEmail(event.target.value);
        }}
      />
      <div className="flex flex-col gap-1.5">
        <PasswordField
          label="Password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        <Link
          href="/forgot-password"
          className="text-text-secondary hover:text-text-primary self-end text-sm underline underline-offset-4"
        >
          Forgot password?
        </Link>
      </div>
      <Button type="submit" size="lg" loading={loading}>
        Sign in
      </Button>
      <div className="text-text-tertiary flex items-center gap-3 text-sm" aria-hidden>
        <span className="bg-border-subtle h-px flex-1" />
        or
        <span className="bg-border-subtle h-px flex-1" />
      </div>
      <Button asChild variant="outline" size="lg">
        <Link href={`/create-account?next=${encodeURIComponent(next)}`}>Create an account</Link>
      </Button>
    </form>
  );
}

function SignInError({ failure }: { failure: Failure }) {
  switch (problemSlug(failure.problem)) {
    case "invalid-credentials":
      // Generic on purpose: never "no account with that email" (PAGE-SPECS.md §2.1).
      return <FormAlert title="Email or password is incorrect" />;
    case "too-many-attempts":
      return (
        <FormAlert title="Too many sign-in attempts">
          {failure.retryAfterSeconds
            ? `Try again in ${describeWait(failure.retryAfterSeconds)}, or `
            : "Try again later, or "}
          <Link href="/forgot-password" className="underline underline-offset-4">
            reset your password
          </Link>
          .
        </FormAlert>
      );
    case "account-suspended":
      return <FormAlert title="This account is suspended">{failure.problem.detail}</FormAlert>;
    default:
      return <FormAlert title={failure.problem.title}>{failure.problem.detail}</FormAlert>;
  }
}
