"use client";

import type { Schema } from "@velo/api-client";
import { MailPlusIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { FormAlert, TextField } from "@/components/forms/fields";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Section,
  Table,
  formatDate,
  td,
  th,
} from "@/components/page";
import { useMe } from "@/components/shell/me-context";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/sonner";
import { callApi, fieldErrors, problemSlug } from "@/lib/api-browser";

import { SelectField, TableSkeleton, fullName, problemMessage, useResource } from "./shared";

type Team = Schema<"TeamView">;
type Member = Schema<"MemberView">;
type Invitation = Schema<"InvitationView">;
type Role = "fulfilment" | "staff" | "admin" | "owner";

export const ROLES: { value: Role; label: string; description: string }[] = [
  {
    value: "fulfilment",
    label: "Fulfilment",
    description: "Sees orders, ships them, and adjusts stock.",
  },
  {
    value: "staff",
    label: "Staff",
    description: "Fulfilment, plus the catalog, discounts, customers and reports.",
  },
  {
    value: "admin",
    label: "Admin",
    description: "Staff, plus refunds, customer notes and the audit log.",
  },
  {
    value: "owner",
    label: "Owner",
    description: "Everything, including the team and store settings.",
  },
];

function roleLabel(role: string): string {
  return ROLES.find((item) => item.value === role)?.label ?? role;
}

/** The message for a failed staff change; `last-owner` reads title and detail together. */
function staffProblem(problem: Parameters<typeof problemSlug>[0]): string {
  if (problemSlug(problem) === "last-owner") {
    return `${problem.title}. ${problem.detail ?? ""}`.trim();
  }
  return problemMessage(problem);
}

export function StaffTeam() {
  const me = useMe();
  const { load, reload, mutate } = useResource(
    () => callApi((client) => client.GET("/api/v1/admin/staff")),
    "team",
  );
  const [revoking, setRevoking] = useState<Member | null>(null);
  const [withdrawing, setWithdrawing] = useState<Invitation | null>(null);
  const [roleProblem, setRoleProblem] = useState<string | null>(null);
  const [changing, setChanging] = useState<string | null>(null);

  async function changeRole(member: Member, role: Role) {
    const before = member.role;
    setRoleProblem(null);
    setChanging(member.id);
    // Optimistic: the select shows the new role at once, and rolls back on refusal.
    mutate((team) => ({
      ...team,
      members: team.members.map((item) => (item.id === member.id ? { ...item, role } : item)),
    }));
    const outcome = await callApi((client) =>
      client.PATCH("/api/v1/admin/staff/{user_id}", {
        params: { path: { user_id: member.id } },
        body: { role },
      }),
    );
    setChanging(null);
    if (!outcome.ok) {
      mutate((team) => ({
        ...team,
        members: team.members.map((item) =>
          item.id === member.id ? { ...item, role: before } : item,
        ),
      }));
      const message = staffProblem(outcome.problem);
      setRoleProblem(message);
      notify.error(message);
      return;
    }
    notify.success(
      `${fullName(member) || member.email} is now ${roleLabel(role).toLowerCase()}. Their sessions were signed out so it takes effect.`,
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <InviteForm
        onInvited={(invitation) => {
          mutate((team: Team) => ({
            ...team,
            invitations: [
              invitation,
              ...team.invitations.filter((item) => item.email !== invitation.email),
            ],
          }));
        }}
      />

      <Section title="Roles">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          {ROLES.map((role) => (
            <div key={role.value}>
              <dt className="font-medium">{role.label}</dt>
              <dd className="text-text-secondary">{role.description}</dd>
            </div>
          ))}
        </dl>
      </Section>

      {load.state === "loading" && <TableSkeleton rows={4} label="Loading the team" />}
      {load.state === "error" && <ErrorState title={load.message} onRetry={reload} />}
      {load.state === "ready" && (
        <>
          <Section title={`Team (${String(load.data.members.length)})`}>
            {roleProblem && (
              <div className="mb-3">
                <FormAlert title={roleProblem} />
              </div>
            )}
            <Table label="Team members">
              <thead>
                <tr>
                  <th scope="col" className={th}>
                    Name
                  </th>
                  <th scope="col" className={th}>
                    Role
                  </th>
                  <th scope="col" className={th}>
                    Since
                  </th>
                  <th scope="col" className={th}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {load.data.members.map((member) => {
                  const name = fullName(member);
                  const isMe = member.id === me.id;
                  return (
                    <tr key={member.id}>
                      <td className={td}>
                        <span className="block font-medium">
                          {name || member.email}
                          {isMe && <span className="text-text-secondary font-normal"> (you)</span>}
                        </span>
                        {name && (
                          <span className="text-text-secondary block break-all text-xs">
                            {member.email}
                          </span>
                        )}
                        {member.status !== "active" && (
                          <span className="text-warning text-xs">{member.status}</span>
                        )}
                      </td>
                      <td className={td}>
                        <SelectField
                          label={`Role for ${name || member.email}`}
                          hideLabel
                          className="w-40"
                          value={member.role}
                          disabled={changing === member.id}
                          onChange={(event) => {
                            void changeRole(member, event.target.value as Role);
                          }}
                        >
                          {ROLES.map((role) => (
                            <option key={role.value} value={role.value}>
                              {role.label}
                            </option>
                          ))}
                        </SelectField>
                      </td>
                      <td className={td}>{formatDate(member.created_at)}</td>
                      <td className={`${td} text-right`}>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-danger"
                          onClick={() => {
                            setRevoking(member);
                          }}
                        >
                          Revoke access
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </Section>

          <Section title="Open invitations">
            {load.data.invitations.length === 0 ? (
              <EmptyState title="No open invitations">
                Invitations you send appear here until they are accepted or expire.
              </EmptyState>
            ) : (
              <Table label="Open invitations">
                <thead>
                  <tr>
                    <th scope="col" className={th}>
                      Email
                    </th>
                    <th scope="col" className={th}>
                      Role
                    </th>
                    <th scope="col" className={th}>
                      Expires
                    </th>
                    <th scope="col" className={th}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {load.data.invitations.map((invitation) => (
                    <tr key={invitation.id}>
                      <td className={`${td} break-all`}>{invitation.email}</td>
                      <td className={td}>{roleLabel(invitation.role)}</td>
                      <td className={td}>{formatDate(invitation.expires_at)}</td>
                      <td className={`${td} text-right`}>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setWithdrawing(invitation);
                          }}
                        >
                          Withdraw
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Section>
        </>
      )}

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={`Revoke admin access for ${revoking ? fullName(revoking) || revoking.email : ""}?`}
        description="Their account becomes a customer account. Every session they have open ends now, and they can no longer sign in to the admin. Their history in the audit log stays."
        confirmLabel="Revoke access"
        tone="danger"
        onConfirm={async () => {
          if (!revoking) return null;
          const member = revoking;
          const outcome = await callApi((client) =>
            client.PATCH("/api/v1/admin/staff/{user_id}", {
              params: { path: { user_id: member.id } },
              body: { role: "customer" },
            }),
          );
          if (!outcome.ok) return staffProblem(outcome.problem);
          mutate((team) => ({
            ...team,
            members: team.members.filter((item) => item.id !== member.id),
          }));
          notify.success(`${fullName(member) || member.email} no longer has admin access`);
          return null;
        }}
      />
      <ConfirmDialog
        open={withdrawing !== null}
        onOpenChange={(open) => {
          if (!open) setWithdrawing(null);
        }}
        title="Withdraw this invitation?"
        description={`The link sent to ${withdrawing?.email ?? ""} stops working. You can invite them again later.`}
        confirmLabel="Withdraw"
        tone="danger"
        onConfirm={async () => {
          if (!withdrawing) return null;
          const invitation = withdrawing;
          const outcome = await callApi((client) =>
            client.DELETE("/api/v1/admin/staff/invitations/{invitation_id}", {
              params: { path: { invitation_id: invitation.id } },
            }),
          );
          if (!outcome.ok) return problemMessage(outcome.problem);
          mutate((team) => ({
            ...team,
            invitations: team.invitations.filter((item) => item.id !== invitation.id),
          }));
          notify.success(`Invitation to ${invitation.email} withdrawn`);
          return null;
        }}
      />
    </div>
  );
}

function InviteForm({ onInvited }: { onInvited: (invitation: Invitation) => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("staff");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim()) {
      setErrors({ email: "Enter the email address to invite." });
      return;
    }
    setSending(true);
    setProblem(null);
    setErrors({});
    const outcome = await callApi((client) =>
      client.POST("/api/v1/admin/staff/invite", { body: { email: email.trim(), role } }),
    );
    setSending(false);
    if (!outcome.ok) {
      const fields = fieldErrors(outcome.problem);
      setErrors(fields);
      if (Object.keys(fields).length === 0) setProblem(problemMessage(outcome.problem));
      return;
    }
    onInvited(outcome.data);
    setEmail("");
    notify.success(`Invitation sent to ${outcome.data.email}`);
  }

  const selected = ROLES.find((item) => item.value === role);
  return (
    <Section title="Invite someone">
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-3">
        {problem && <FormAlert title={problem} />}
        <div className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-start">
          <TextField
            label="Email"
            type="email"
            autoComplete="off"
            value={email}
            error={errors["email"]}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
          <SelectField
            label="Role"
            value={role}
            error={errors["role"]}
            onChange={(event) => {
              setRole(event.target.value as Role);
            }}
          >
            {ROLES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </SelectField>
          <Button type="submit" loading={sending} className="sm:mt-7">
            <MailPlusIcon aria-hidden />
            Send invitation
          </Button>
        </div>
        {selected && <p className="text-text-secondary text-sm">{selected.description}</p>}
      </form>
    </Section>
  );
}
