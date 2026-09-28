"use client";

import type { Schema } from "@velo/api-client";
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
import { notify } from "@/components/ui/sonner";
import { callApi, fieldErrors, type Outcome } from "@/lib/api-browser";

type Failure = Extract<Outcome<unknown>, { ok: false }>;
type User = Schema<"UserResponse">;

export function ProfileForm({ user }: { user: User }) {
  const router = useRouter();
  const [firstName, setFirstName] = useState(user.first_name ?? "");
  const [lastName, setLastName] = useState(user.last_name ?? "");
  const [phone, setPhone] = useState(user.phone ?? "");
  const [marketing, setMarketing] = useState(user.marketing_opt_in);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setFailure(null);
    const outcome = await callApi((client) =>
      client.PATCH("/api/v1/auth/me", {
        body: {
          first_name: firstName.trim() || null,
          last_name: lastName.trim() || null,
          phone: phone.trim() || null,
          marketing_opt_in: marketing,
        },
      }),
    );
    setLoading(false);
    if (outcome.ok) {
      notify.success("Details saved");
      router.refresh();
    } else {
      setFailure(outcome);
    }
  }

  const errors = failure ? fieldErrors(failure.problem) : {};
  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-5">
      {failure && !failure.problem.errors && (
        <FormAlert title={failure.problem.title}>{failure.problem.detail}</FormAlert>
      )}
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          label="First name"
          optional
          autoComplete="given-name"
          value={firstName}
          onChange={(event) => {
            setFirstName(event.target.value);
          }}
          error={errors["first_name"]}
        />
        <TextField
          label="Last name"
          optional
          autoComplete="family-name"
          value={lastName}
          onChange={(event) => {
            setLastName(event.target.value);
          }}
          error={errors["last_name"]}
        />
      </div>
      <TextField
        label="Phone"
        optional
        type="tel"
        autoComplete="tel"
        value={phone}
        onChange={(event) => {
          setPhone(event.target.value);
        }}
        error={errors["phone"]}
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
        <span>Email me about new products and offers.</span>
      </label>
      <Button type="submit" className="self-start" loading={loading}>
        Save details
      </Button>
    </form>
  );
}

export function ChangePasswordForm({ email }: { email: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setFailure(null);
    const outcome = await callApi((client) =>
      client.POST("/api/v1/auth/change-password", {
        body: { current_password: current, new_password: next },
      }),
    );
    setLoading(false);
    if (outcome.ok) {
      setCurrent("");
      setNext("");
      notify.success("Password changed. Your other devices have been signed out.");
    } else {
      setFailure(outcome);
    }
  }

  const errors = failure ? fieldErrors(failure.problem) : {};
  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-5">
      {failure && !failure.problem.errors && (
        <FormAlert title={failure.problem.title}>{failure.problem.detail}</FormAlert>
      )}
      <PasswordField
        label="Current password"
        autoComplete="current-password"
        value={current}
        onChange={(event) => {
          setCurrent(event.target.value);
        }}
        error={errors["current_password"]}
      />
      <PasswordField
        label="New password"
        autoComplete="new-password"
        value={next}
        onChange={(event) => {
          setNext(event.target.value);
        }}
        error={errors["password"]}
        before={<PasswordRequirements password={next} email={email} />}
      />
      <Button type="submit" variant="secondary" className="self-start" loading={loading}>
        Change password
      </Button>
    </form>
  );
}
