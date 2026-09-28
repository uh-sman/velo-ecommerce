"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import {
  FormAlert,
  PasswordField,
  PasswordRequirements,
  TextField,
} from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { callApi, fieldErrors, problemSlug, type Outcome } from "@/lib/api-browser";

type Failure = Extract<Outcome<unknown>, { ok: false }>;

/*
 * PAGE-SPECS.md §2.2: email, password, optional name — nothing else. Password
 * requirements visible before typing. Marketing consent is an unchecked box.
 * Success signs the customer in and returns them to where they were.
 */
export function CreateAccountForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [marketing, setMarketing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setFailure(null);
    const outcome = await callApi(
      (client) =>
        client.POST("/api/v1/auth/register", {
          body: {
            email,
            password,
            first_name: firstName.trim() || null,
            marketing_opt_in: marketing,
          },
        }),
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

  const errors = failure ? fieldErrors(failure.problem) : {};
  const slug = failure ? problemSlug(failure.problem) : "";
  const showAlert = failure !== null && slug !== "validation-failed" && slug !== "email-taken";

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-5">
      {showAlert && <FormAlert title={failure.problem.title}>{failure.problem.detail}</FormAlert>}
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
        error={
          slug === "email-taken" ? "An account with this email already exists." : errors["email"]
        }
        hint={
          slug === "email-taken" ? (
            <Link
              href={`/sign-in?next=${encodeURIComponent(next)}`}
              className="underline underline-offset-4"
            >
              Sign in instead
            </Link>
          ) : undefined
        }
      />
      <PasswordField
        label="Password"
        name="password"
        autoComplete="new-password"
        required
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
        }}
        error={errors["password"]}
        before={<PasswordRequirements password={password} email={email} />}
      />
      <TextField
        label="First name"
        optional
        name="given-name"
        autoComplete="given-name"
        value={firstName}
        onChange={(event) => {
          setFirstName(event.target.value);
        }}
        error={errors["first_name"]}
      />
      <label htmlFor="marketing-opt-in" className="flex items-start gap-3 text-sm">
        <Checkbox
          id="marketing-opt-in"
          className="mt-0.5"
          checked={marketing}
          onCheckedChange={(checked) => {
            setMarketing(checked === true);
          }}
        />
        <span>Email me about new products and offers. Unsubscribe any time.</span>
      </label>
      <Button type="submit" size="lg" loading={loading}>
        Create account
      </Button>
      <p className="text-text-secondary text-center text-sm">
        Already have an account?{" "}
        <Link
          href={`/sign-in?next=${encodeURIComponent(next)}`}
          className="text-text-primary underline underline-offset-4"
        >
          Sign in
        </Link>
      </p>
    </form>
  );
}
