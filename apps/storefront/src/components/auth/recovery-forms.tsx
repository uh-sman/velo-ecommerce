"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  FormAlert,
  PasswordField,
  PasswordRequirements,
  TextField,
} from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { callApi, describeWait, fieldErrors, problemSlug, type Outcome } from "@/lib/api-browser";

type Failure = Extract<Outcome<unknown>, { ok: false }>;

function RateLimitOrGeneric({ failure }: { failure: Failure }) {
  if (failure.problem.status === 429) {
    return (
      <FormAlert title="Too many requests">
        {failure.retryAfterSeconds
          ? `Try again in ${describeWait(failure.retryAfterSeconds)}.`
          : "Try again later."}
      </FormAlert>
    );
  }
  return <FormAlert title={failure.problem.title}>{failure.problem.detail}</FormAlert>;
}

// ── Forgot password ───────────────────────────────────────────────────────────

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setFailure(null);
    const outcome = await callApi((client) =>
      client.POST("/api/v1/auth/forgot-password", { body: { email } }),
    );
    setLoading(false);
    if (outcome.ok) setSentTo(email);
    else setFailure(outcome);
  }

  if (sentTo) {
    // The same message whether or not the account exists (API-SPEC.md §2).
    return (
      <div className="flex flex-col gap-5">
        <FormAlert tone="success" title="Check your email">
          If an account exists for {sentTo}, we have sent a link to reset its password. The link
          expires in one hour.
        </FormAlert>
        <Link href="/sign-in" className="text-sm underline underline-offset-4">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-5">
      {failure && <RateLimitOrGeneric failure={failure} />}
      <p className="text-text-secondary text-sm">
        Enter the email you signed up with and we will send you a link to choose a new password.
      </p>
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
        error={failure ? fieldErrors(failure.problem)["email"] : undefined}
      />
      <Button type="submit" size="lg" loading={loading}>
        Send reset link
      </Button>
      <Link href="/sign-in" className="text-text-secondary text-center text-sm underline">
        Back to sign in
      </Link>
    </form>
  );
}

// ── Reset password ────────────────────────────────────────────────────────────

export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setFailure(null);
    const outcome = await callApi(
      (client) => client.POST("/api/v1/auth/reset-password", { body: { token, password } }),
      { refreshOnExpiry: false },
    );
    setLoading(false);
    if (outcome.ok) setDone(true);
    else setFailure(outcome);
  }

  if (!token) return <InvalidLink kind="reset" />;
  if (failure && problemSlug(failure.problem) === "invalid-or-expired-link") {
    return <InvalidLink kind="reset" />;
  }
  if (done) {
    return (
      <div className="flex flex-col gap-5">
        <FormAlert tone="success" title="Your password has been changed">
          For your security, every device has been signed out.
        </FormAlert>
        <Button asChild size="lg">
          <Link href="/sign-in">Sign in</Link>
        </Button>
      </div>
    );
  }

  const errors = failure ? fieldErrors(failure.problem) : {};
  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-5">
      {failure && !errors["password"] && <RateLimitOrGeneric failure={failure} />}
      <PasswordField
        label="New password"
        name="password"
        autoComplete="new-password"
        required
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
        }}
        error={errors["password"]}
        before={<PasswordRequirements password={password} email="" />}
      />
      <Button type="submit" size="lg" loading={loading}>
        Set new password
      </Button>
    </form>
  );
}

function InvalidLink({ kind }: { kind: "reset" | "verify" }) {
  return (
    <div className="flex flex-col gap-5">
      <FormAlert title="This link is invalid or has expired">
        {kind === "reset"
          ? "Reset links work once and expire after an hour."
          : "Verification links work once and expire after a day."}
      </FormAlert>
      {kind === "reset" ? (
        <Button asChild size="lg">
          <Link href="/forgot-password">Send a new link</Link>
        </Button>
      ) : (
        <ResendVerification />
      )}
    </div>
  );
}

// ── Email verification ────────────────────────────────────────────────────────

export function VerifyEmail({ token }: { token: string }) {
  const [state, setState] = useState<"verifying" | "verified" | "invalid">(
    token ? "verifying" : "invalid",
  );
  const started = useRef(false);

  // Verification happens on a POST from the page, never on the GET of the
  // link itself — mail scanners that pre-fetch links cannot consume it.
  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    void callApi((client) => client.POST("/api/v1/auth/verify-email", { body: { token } }), {
      refreshOnExpiry: false,
    }).then((outcome) => {
      setState(outcome.ok ? "verified" : "invalid");
    });
  }, [token]);

  if (state === "verifying") {
    return (
      <p role="status" className="text-text-secondary">
        Confirming your email address…
      </p>
    );
  }
  if (state === "invalid") return <InvalidLink kind="verify" />;
  return (
    <div className="flex flex-col gap-5">
      <FormAlert tone="success" title="Email confirmed">
        Thank you — your email address is verified.
      </FormAlert>
      <Button asChild size="lg">
        <Link href="/account">Go to your account</Link>
      </Button>
    </div>
  );
}

export function ResendVerification({ defaultEmail = "" }: { defaultEmail?: string }) {
  const [email, setEmail] = useState(defaultEmail);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setFailure(null);
    const outcome = await callApi((client) =>
      client.POST("/api/v1/auth/resend-verification", { body: { email } }),
    );
    setLoading(false);
    if (outcome.ok) setSent(true);
    else setFailure(outcome);
  }

  if (sent) {
    return (
      <FormAlert tone="success" title="Check your email">
        If {email} still needs verifying, a new link is on its way.
      </FormAlert>
    );
  }
  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-3">
      {failure && <RateLimitOrGeneric failure={failure} />}
      {!defaultEmail && (
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
      )}
      <Button type="submit" variant="outline" loading={loading}>
        Send a new verification link
      </Button>
    </form>
  );
}
