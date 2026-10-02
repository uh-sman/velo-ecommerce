"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { FormAlert, PasswordField, TextField } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import {
  callApi,
  describeWait,
  problemSlug,
  refreshSession,
  safeNext,
  type Outcome,
} from "@/lib/api-browser";

type Failure = Extract<Outcome<unknown>, { ok: false }>;

/**
 * Staff sign in with the same accounts and the same API as customers; the
 * admin then checks the role. A password reset goes through the storefront's
 * flow — one way to reset, not two.
 */
export function SignInForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  // An expired access cookie with a live refresh cookie: skip the form.
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

  const storefront = process.env["NEXT_PUBLIC_STOREFRONT_URL"] ?? "http://localhost:3000";

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-5">
      {failure && <SignInError failure={failure} />}
      <TextField
        label="Email"
        type="email"
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
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        <a
          href={`${storefront}/forgot-password`}
          className="text-text-secondary hover:text-text-primary self-end text-sm underline underline-offset-4"
        >
          Forgot password?
        </a>
      </div>
      <Button type="submit" size="lg" loading={loading}>
        Sign in
      </Button>
    </form>
  );
}

function SignInError({ failure }: { failure: Failure }) {
  switch (problemSlug(failure.problem)) {
    case "invalid-credentials":
      return <FormAlert title="Email or password is incorrect" />;
    case "too-many-attempts":
      return (
        <FormAlert title="Too many sign-in attempts">
          {failure.retryAfterSeconds
            ? `Try again in ${describeWait(failure.retryAfterSeconds)}.`
            : "Try again later."}
        </FormAlert>
      );
    default:
      return <FormAlert title={failure.problem.title}>{failure.problem.detail}</FormAlert>;
  }
}
