"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { FormAlert, TextField } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { callApi, describeWait } from "@/lib/api-browser";

export function OrderLookupForm() {
  const router = useRouter();
  const [number, setNumber] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!number.trim() || !email.trim()) {
      setError("Enter both your order number and your email.");
      return;
    }
    setPending(true);
    setError(null);
    const outcome = await callApi((client) =>
      client.POST("/api/v1/orders/lookup", {
        body: { number: number.trim().toUpperCase(), email: email.trim() },
      }),
    );
    setPending(false);
    if (outcome.ok) {
      router.push(`/orders/${outcome.data.number}?token=${outcome.data.access_token ?? ""}`);
      return;
    }
    setError(
      outcome.problem.status === 429
        ? `Too many attempts. Try again in ${describeWait(outcome.retryAfterSeconds ?? 3600)}.`
        : outcome.problem.status === 404
          ? "No order matches that number and email. Check both, including the VLO- prefix."
          : outcome.problem.title,
    );
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
      {error && <FormAlert title={error} />}
      <TextField
        label="Order number"
        placeholder="VLO-XXXXXX"
        autoCapitalize="characters"
        autoComplete="off"
        value={number}
        onChange={(event) => {
          setNumber(event.target.value);
        }}
      />
      <TextField
        label="Email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(event) => {
          setEmail(event.target.value);
        }}
      />
      <Button type="submit" size="lg" loading={pending}>
        Find my order
      </Button>
    </form>
  );
}
