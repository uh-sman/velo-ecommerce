"use client";

import type { Schema } from "@velo/api-client";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { FormAlert, TextField } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/sonner";
import { callApi, fieldErrors, type Outcome } from "@/lib/api-browser";

type Address = Schema<"AddressResponse">;
type Failure = Extract<Outcome<unknown>, { ok: false }>;

const FIELDS = [
  "label",
  "first_name",
  "last_name",
  "company",
  "line1",
  "line2",
  "city",
  "region",
  "postal_code",
  "country_code",
  "phone",
] as const;
type FieldName = (typeof FIELDS)[number];
type Draft = Record<FieldName, string> & {
  is_default_shipping: boolean;
  is_default_billing: boolean;
};

function draftOf(address?: Address): Draft {
  const draft = {
    is_default_shipping: address?.is_default_shipping ?? false,
    is_default_billing: address?.is_default_billing ?? false,
  } as Draft;
  for (const field of FIELDS) {
    draft[field] = address?.[field] ?? (field === "country_code" ? "US" : "");
  }
  return draft;
}

function oneLine(address: Address): string {
  return [address.line1, address.line2, address.city, address.region, address.postal_code]
    .filter(Boolean)
    .join(", ");
}

/*
 * PAGE-SPECS.md §2.5: a card grid, the default badged; add and edit in a
 * dialog; delete confirmed in a dialog that names the address; the default
 * cannot be deleted while another address could take its place.
 */
export function AddressBook() {
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState<Address | "new" | null>(null);
  const [deleting, setDeleting] = useState<Address | null>(null);

  const load = useCallback(async () => {
    setLoadFailed(false);
    const outcome = await callApi((client) => client.GET("/api/v1/account/addresses"));
    if (outcome.ok) setAddresses(outcome.data);
    else setLoadFailed(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadFailed) {
    return (
      <FormAlert title="We could not load your addresses">
        <Button variant="link" className="h-auto p-0" onClick={() => void load()}>
          Try again
        </Button>
      </FormAlert>
    );
  }
  if (!addresses) {
    return (
      <div className="grid gap-4 lg:grid-cols-2" aria-busy>
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Button
        className="self-start"
        onClick={() => {
          setEditing("new");
        }}
      >
        Add an address
      </Button>

      {addresses.length === 0 ? (
        <p className="text-text-secondary">
          No saved addresses — they are saved automatically at checkout.
        </p>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {addresses.map((address) => (
            <li
              key={address.id}
              className="border-border-subtle flex flex-col gap-3 rounded-lg border p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">
                  {address.label ?? `${address.first_name} ${address.last_name}`}
                </p>
                {address.is_default_shipping && <Badge>Default shipping</Badge>}
                {address.is_default_billing && <Badge>Default billing</Badge>}
              </div>
              <address className="text-text-secondary text-sm not-italic">
                {address.first_name} {address.last_name}
                <br />
                {oneLine(address)}
                <br />
                {address.country_code}
              </address>
              <div className="mt-auto flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditing(address);
                  }}
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDeleting(address);
                  }}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <AddressDialog
          address={editing === "new" ? undefined : editing}
          onClose={() => {
            setEditing(null);
          }}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {deleting && (
        <DeleteDialog
          address={deleting}
          onClose={() => {
            setDeleting(null);
          }}
          onDeleted={() => {
            setDeleting(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="bg-surface-sunken text-text-secondary rounded-sm px-1.5 py-0.5 text-xs font-medium">
      {children}
    </span>
  );
}

function AddressDialog({
  address,
  onClose,
  onSaved,
}: {
  address: Address | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(address));
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  function set(field: FieldName) {
    return (event: { target: { value: string } }) => {
      setDraft((current) => ({ ...current, [field]: event.target.value }));
    };
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setFailure(null);
    const optional = (value: string) => value.trim() || null;
    const body = {
      label: optional(draft.label),
      first_name: draft.first_name.trim(),
      last_name: draft.last_name.trim(),
      company: optional(draft.company),
      line1: draft.line1.trim(),
      line2: optional(draft.line2),
      city: draft.city.trim(),
      region: optional(draft.region),
      postal_code: optional(draft.postal_code),
      country_code: draft.country_code.trim().toUpperCase(),
      phone: optional(draft.phone),
      is_default_shipping: draft.is_default_shipping,
      is_default_billing: draft.is_default_billing,
    };
    const outcome = address
      ? await callApi((client) =>
          client.PATCH("/api/v1/account/addresses/{address_id}", {
            params: { path: { address_id: address.id } },
            // A default is moved by setting it elsewhere, never by unsetting it here.
            body: {
              ...body,
              is_default_shipping: body.is_default_shipping || null,
              is_default_billing: body.is_default_billing || null,
            },
          }),
        )
      : await callApi((client) => client.POST("/api/v1/account/addresses", { body }));
    setLoading(false);
    if (outcome.ok) {
      notify.success(address ? "Address updated" : "Address added");
      onSaved();
    } else {
      setFailure(outcome);
    }
  }

  const errors = failure ? fieldErrors(failure.problem) : {};
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{address ? "Edit address" : "Add an address"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
          {failure && !failure.problem.errors && (
            <FormAlert title={failure.problem.title}>{failure.problem.detail}</FormAlert>
          )}
          <TextField
            label="Label"
            optional
            placeholder="Home, Work"
            value={draft.label}
            onChange={set("label")}
            error={errors["label"]}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="First name"
              autoComplete="given-name"
              required
              value={draft.first_name}
              onChange={set("first_name")}
              error={errors["first_name"]}
            />
            <TextField
              label="Last name"
              autoComplete="family-name"
              required
              value={draft.last_name}
              onChange={set("last_name")}
              error={errors["last_name"]}
            />
          </div>
          <TextField
            label="Address"
            autoComplete="address-line1"
            required
            value={draft.line1}
            onChange={set("line1")}
            error={errors["line1"]}
          />
          <TextField
            label="Apartment, suite, etc."
            optional
            autoComplete="address-line2"
            value={draft.line2}
            onChange={set("line2")}
            error={errors["line2"]}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="City"
              autoComplete="address-level2"
              required
              value={draft.city}
              onChange={set("city")}
              error={errors["city"]}
            />
            <TextField
              label="State / region"
              optional
              autoComplete="address-level1"
              value={draft.region}
              onChange={set("region")}
              error={errors["region"]}
            />
            <TextField
              label="Postal code"
              optional
              autoComplete="postal-code"
              value={draft.postal_code}
              onChange={set("postal_code")}
              error={errors["postal_code"]}
            />
            <TextField
              label="Country code"
              hint="Two letters, e.g. US, GB, NG"
              autoComplete="country"
              maxLength={2}
              required
              value={draft.country_code}
              onChange={set("country_code")}
              error={errors["country_code"]}
            />
          </div>
          <TextField
            label="Phone"
            optional
            type="tel"
            autoComplete="tel"
            value={draft.phone}
            onChange={set("phone")}
            error={errors["phone"]}
          />
          {(["is_default_shipping", "is_default_billing"] as const).map((flag) => (
            <label key={flag} className="flex items-center gap-3 text-sm">
              <Checkbox
                checked={draft[flag]}
                // Unchecking the current default is not how a default moves.
                disabled={address?.[flag] === true}
                onCheckedChange={(checked) => {
                  setDraft((current) => ({ ...current, [flag]: checked === true }));
                }}
              />
              {flag === "is_default_shipping"
                ? "Use as my default shipping address"
                : "Use as my default billing address"}
            </label>
          ))}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={loading}>
              Save address
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  address,
  onClose,
  onDeleted,
}: {
  address: Address;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const name = address.label ?? oneLine(address);

  async function confirm() {
    setLoading(true);
    const outcome = await callApi((client) =>
      client.DELETE("/api/v1/account/addresses/{address_id}", {
        params: { path: { address_id: address.id } },
      }),
    );
    setLoading(false);
    if (outcome.ok) {
      notify.success("Address deleted");
      onDeleted();
    } else {
      setFailure(outcome);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Delete {name}?</DialogTitle>
          <DialogDescription>This cannot be undone.</DialogDescription>
        </DialogHeader>
        {failure && <FormAlert title={failure.problem.title}>{failure.problem.detail}</FormAlert>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="danger" loading={loading} onClick={() => void confirm()}>
            Delete address
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
