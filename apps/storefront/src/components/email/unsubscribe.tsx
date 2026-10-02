"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { FormAlert } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { callApi } from "@/lib/api-browser";

/*
 * The unsubscribe link in a reminder email. One click on the button — not on
 * page load, so a mail scanner that opens links does not unsubscribe anyone.
 * (Mail clients' own one-click unsubscribe posts straight to the API.)
 */
export function Unsubscribe() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<"idle" | "pending" | "done" | "failed">("idle");
  const [email, setEmail] = useState("");

  async function confirm() {
    setState("pending");
    const outcome = await callApi(
      (client) => client.POST("/api/v1/email/unsubscribe", { params: { query: { token } } }),
      { refreshOnExpiry: false },
    );
    if (outcome.ok) {
      setEmail(outcome.data.email);
      setState("done");
    } else {
      setState("failed");
    }
  }

  if (!token) {
    return (
      <FormAlert title="This link is incomplete">Open the link from the email again.</FormAlert>
    );
  }
  if (state === "done") {
    return (
      <FormAlert tone="success" title="You are unsubscribed">
        {email} will not get cart reminders again. Order emails — receipts, shipping, refunds —
        still arrive, because you need them.
      </FormAlert>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {state === "failed" && (
        <FormAlert title="This link is not valid">
          It may be incomplete. Signed-in customers can change email choices in their{" "}
          <Link href="/account/preferences" className="underline">
            account
          </Link>
          .
        </FormAlert>
      )}
      <p className="text-text-secondary">
        Stop emails reminding you about items left in your cart?
      </p>
      <Button
        size="lg"
        loading={state === "pending"}
        onClick={() => void confirm()}
        className="self-start"
      >
        Unsubscribe from cart reminders
      </Button>
    </div>
  );
}
