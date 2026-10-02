"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { FormAlert } from "@/components/forms/fields";
import { callApi } from "@/lib/api-browser";

/** A cart reminder's link: bring the saved cart to this browser, then show it. */
export function RecoverCart() {
  const token = useSearchParams().get("token") ?? "";
  const router = useRouter();
  const [problem, setProblem] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    void callApi((client) => client.POST("/api/v1/cart/recover", { body: { token } })).then(
      (outcome) => {
        if (outcome.ok) {
          router.replace("/cart");
          router.refresh();
        } else {
          setProblem(
            outcome.problem.status === 409
              ? "This cart belongs to an account — sign in to see it."
              : "This cart is no longer available.",
          );
        }
      },
    );
  }, [token, router]);

  if (!token || problem) {
    return (
      <FormAlert title={problem ?? "This link is incomplete"}>
        <Link
          href={problem?.startsWith("This cart belongs") ? "/sign-in?next=/cart" : "/products"}
          className="underline"
        >
          {problem?.startsWith("This cart belongs") ? "Sign in" : "Keep shopping"}
        </Link>
      </FormAlert>
    );
  }
  return (
    <p role="status" className="text-text-secondary">
      Restoring your cart…
    </p>
  );
}
