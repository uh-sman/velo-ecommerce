"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { callApi } from "@/lib/api-browser";

export function SignOutButton(props: Omit<ButtonProps, "onClick" | "loading">) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  return (
    <Button
      {...props}
      loading={loading}
      onClick={() => {
        setLoading(true);
        // Revoked server-side, not just forgotten by the browser (API-SPEC.md §2).
        void callApi((client) => client.POST("/api/v1/auth/logout"), {
          refreshOnExpiry: false,
        }).then(() => {
          router.replace("/");
          router.refresh();
        });
      }}
    >
      Sign out
    </Button>
  );
}
