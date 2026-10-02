"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

import { FormAlert, PasswordField, TextField } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { callApi, fieldErrors } from "@/lib/api-browser";

export function AcceptInviteForm() {
  const token = useSearchParams().get("token") ?? "";
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  if (!token) {
    return (
      <FormAlert title="This link is incomplete">Open the link from your email again.</FormAlert>
    );
  }
  if (done) {
    return (
      <FormAlert tone="success" title="You are on the team">
        <Link href="/sign-in" className="underline underline-offset-4">
          Sign in to the admin
        </Link>
      </FormAlert>
    );
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setProblem(null);
    const outcome = await callApi(
      (client) =>
        client.POST("/api/v1/staff-invitations/accept", {
          body: {
            token,
            password: password || null,
            first_name: firstName || null,
            last_name: lastName || null,
          },
        }),
      { refreshOnExpiry: false },
    );
    setLoading(false);
    if (outcome.ok) {
      setDone(true);
      return;
    }
    const fields = fieldErrors(outcome.problem);
    setErrors(fields);
    if (Object.keys(fields).length === 0) {
      setProblem(outcome.problem.detail ?? outcome.problem.title);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
      {problem && <FormAlert title={problem} />}
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label="First name"
          autoComplete="given-name"
          value={firstName}
          onChange={(event) => {
            setFirstName(event.target.value);
          }}
        />
        <TextField
          label="Last name"
          autoComplete="family-name"
          value={lastName}
          onChange={(event) => {
            setLastName(event.target.value);
          }}
        />
      </div>
      <PasswordField
        label="Password"
        autoComplete="new-password"
        hint="At least 10 characters. Leave empty if you already have an account."
        error={errors["password"]}
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
        }}
      />
      <Button type="submit" size="lg" loading={loading}>
        Accept invitation
      </Button>
    </form>
  );
}
