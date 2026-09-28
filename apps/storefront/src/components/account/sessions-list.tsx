"use client";

import type { Schema } from "@velo/api-client";
import { MonitorIcon, SmartphoneIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { FormAlert } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/sonner";
import { callApi } from "@/lib/api-browser";

type Session = Schema<"SessionResponse">;

/** "Chrome on Windows" — enough to recognise a device, no fingerprinting library. */
export function describeDevice(userAgent: string | null): { label: string; mobile: boolean } {
  if (!userAgent) return { label: "Unknown device", mobile: false };
  const browser =
    [
      ["Edg/", "Edge"],
      ["OPR/", "Opera"],
      ["Firefox/", "Firefox"],
      ["Chrome/", "Chrome"],
      ["Safari/", "Safari"],
    ].find(([token]) => token !== undefined && userAgent.includes(token))?.[1] ?? "Browser";
  const os =
    [
      ["iPhone", "iPhone"],
      ["iPad", "iPad"],
      ["Android", "Android"],
      ["Windows", "Windows"],
      ["Mac OS X", "macOS"],
      ["Linux", "Linux"],
    ].find(([token]) => token !== undefined && userAgent.includes(token))?.[1] ??
    "an unknown system";
  return {
    label: `${browser} on ${os}`,
    mobile: /iPhone|Android|Mobile/.test(userAgent),
  };
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function SessionsList() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(false);
    const outcome = await callApi((client) => client.GET("/api/v1/auth/sessions"));
    if (outcome.ok) setSessions(outcome.data);
    else setError(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(session: Session) {
    setRevoking(session.id);
    const outcome = await callApi((client) =>
      client.DELETE("/api/v1/auth/sessions/{session_id}", {
        params: { path: { session_id: session.id } },
      }),
    );
    setRevoking(null);
    if (outcome.ok) {
      notify.success(`Signed out ${describeDevice(session.user_agent).label}`);
      setSessions((current) => current?.filter((item) => item.id !== session.id) ?? null);
    } else {
      notify.error(outcome.problem.title);
    }
  }

  if (error) {
    return (
      <FormAlert title="We could not load your sessions">
        <Button variant="link" className="h-auto p-0" onClick={() => void load()}>
          Try again
        </Button>
      </FormAlert>
    );
  }
  if (!sessions) {
    return (
      <div className="flex flex-col gap-3" aria-busy>
        {[0, 1].map((key) => (
          <Skeleton key={key} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {sessions.map((session) => {
        const device = describeDevice(session.user_agent);
        const Icon = device.mobile ? SmartphoneIcon : MonitorIcon;
        return (
          <li
            key={session.id}
            className="border-border-subtle flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center"
          >
            <Icon className="text-text-secondary size-5 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {device.label}
                {session.is_current && (
                  <span className="bg-success/15 text-success ml-2 rounded-sm px-1.5 py-0.5 text-xs font-medium">
                    This device
                  </span>
                )}
              </p>
              <p className="text-text-secondary text-sm">
                {session.ip_address ?? "Unknown location"} · Signed in{" "}
                {dateTime.format(new Date(session.signed_in_at))} · Last active{" "}
                {dateTime.format(new Date(session.last_active_at))}
              </p>
            </div>
            {session.is_current ? (
              <SignOutButton variant="outline" size="sm" />
            ) : (
              <Button
                variant="outline"
                size="sm"
                loading={revoking === session.id}
                onClick={() => void revoke(session)}
              >
                Sign out
                <span className="sr-only"> {device.label}</span>
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
