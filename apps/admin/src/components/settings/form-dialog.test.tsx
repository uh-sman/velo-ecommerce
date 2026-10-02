import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { TextField } from "@/components/forms/fields";
import { FormDialog, type SubmitResult } from "@/components/settings/form-dialog";

function Harness({ onSubmit }: { onSubmit: () => Promise<SubmitResult> }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Reopen
      </button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title="Add a thing"
        description="Things are useful."
        submitLabel="Add thing"
        onSubmit={onSubmit}
      >
        {(errors) => <TextField label="Name" error={errors["name"]} />}
      </FormDialog>
    </>
  );
}

describe("FormDialog", () => {
  it("closes after a successful submit", async () => {
    const onSubmit = vi.fn(() => Promise.resolve<SubmitResult>({ ok: true }));
    render(<Harness onSubmit={onSubmit} />);
    const dialog = screen.getByRole("dialog", { name: "Add a thing" });
    expect(dialog).toHaveAccessibleDescription("Things are useful.");
    await userEvent.setup().click(screen.getByRole("button", { name: "Add thing" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("shows client-side field errors and stays open", async () => {
    render(
      <Harness onSubmit={() => Promise.resolve({ ok: false, errors: { name: "Required" } })} />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Add thing" }));
    expect(await screen.findByText("Required")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("puts API field errors on their fields", async () => {
    render(
      <Harness
        onSubmit={() =>
          Promise.resolve({
            ok: false,
            problem: {
              type: "https://velo.dev/errors/validation-failed",
              title: "Invalid",
              status: 422,
              errors: [{ field: "name", code: "taken", message: "Name is taken" }],
            },
          })
        }
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Add thing" }));
    expect(await screen.findByText("Name is taken")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows any other problem at the top, and forgets it on close", async () => {
    render(
      <Harness
        onSubmit={() =>
          Promise.resolve({
            ok: false,
            problem: {
              type: "https://velo.dev/errors/conflict",
              title: "Conflict",
              status: 409,
              detail: "Someone else changed this.",
            },
          })
        }
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add thing" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Someone else changed this.");

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("closes from Cancel without submitting", async () => {
    const onSubmit = vi.fn(() => Promise.resolve<SubmitResult>({ ok: true }));
    render(<Harness onSubmit={onSubmit} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables submit while saving", async () => {
    let finish: ((result: SubmitResult) => void) | undefined;
    render(
      <Harness
        onSubmit={() =>
          new Promise<SubmitResult>((resolve) => {
            finish = resolve;
          })
        }
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Add thing" }));
    expect(screen.getByRole("button", { name: /Add thing/ })).toBeDisabled();
    finish?.({ ok: true });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
