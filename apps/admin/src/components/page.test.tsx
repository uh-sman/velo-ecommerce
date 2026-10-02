import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  MoneyText,
  PageHeader,
  Section,
  Table,
  formatDate,
  formatDateTime,
  toMajor,
  toMinor,
} from "@/components/page";

describe("PageHeader", () => {
  it("renders the title as the page heading with description and actions", () => {
    render(
      <PageHeader title="Orders" description="All orders" actions={<button>Export</button>} />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Orders" })).toBeInTheDocument();
    expect(screen.getByText("All orders")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
  });

  it("omits the optional parts", () => {
    render(<PageHeader title="Orders" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("heading").parentElement?.children).toHaveLength(1);
  });
});

describe("Section", () => {
  it("shows a heading and actions when given", () => {
    render(
      <Section title="Items" actions={<button>Add</button>}>
        body
      </Section>,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Items" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  it("renders only its body without a title or actions", () => {
    render(<Section>just body</Section>);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByText("just body")).toBeInTheDocument();
  });

  it("renders actions alone", () => {
    render(<Section actions={<button>Only</button>}>x</Section>);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Only" })).toBeInTheDocument();
  });
});

describe("EmptyState", () => {
  it("shows a title and optional guidance", () => {
    const { rerender } = render(<EmptyState title="No orders">Share your store.</EmptyState>);
    expect(screen.getByText("No orders")).toBeInTheDocument();
    expect(screen.getByText("Share your store.")).toBeInTheDocument();
    rerender(<EmptyState title="Nothing" />);
    expect(screen.queryByText("Share your store.")).not.toBeInTheDocument();
  });
});

describe("ErrorState", () => {
  it("announces the error and retries on request", async () => {
    const onRetry = vi.fn();
    render(<ErrorState title="Could not load" onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load");
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("offers no retry without a handler", () => {
    render(<ErrorState title="Gone" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("MoneyText", () => {
  it("formats money and shows a dash for none", () => {
    const { rerender } = render(<MoneyText money={{ amount: 1250, currency: "USD" }} />);
    expect(screen.getByText("$12.50")).toBeInTheDocument();
    rerender(<MoneyText money={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("date formatting", () => {
  it("shows a dash for a missing date", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("")).toBe("—");
  });

  it("formats dates and times", () => {
    expect(formatDate("2026-03-05T12:00:00Z")).toMatch(/2026/);
    expect(formatDateTime("2026-03-05T12:00:00Z")).toMatch(/2026/);
    expect(formatDateTime("2026-03-05T12:00:00Z").length).toBeGreaterThan(
      formatDate("2026-03-05T12:00:00Z").length,
    );
  });
});

describe("toMajor / toMinor", () => {
  it("converts minor units to a two-decimal string", () => {
    expect(toMajor(1250)).toBe("12.50");
    expect(toMajor(0)).toBe("0.00");
    expect(toMajor(null)).toBe("");
    expect(toMajor(undefined)).toBe("");
  });

  it("parses what an operator types into minor units", () => {
    expect(toMinor("12.50")).toBe(1250);
    expect(toMinor("$1,000.10")).toBe(100010);
    expect(toMinor("0.105")).toBe(11);
    expect(toMinor("abc")).toBeNull();
    expect(toMinor("")).toBeNull();
  });
});

describe("Table", () => {
  it("labels the table", () => {
    render(
      <Table label="Orders">
        <tbody>
          <tr>
            <td>1</td>
          </tr>
        </tbody>
      </Table>,
    );
    expect(screen.getByRole("table", { name: "Orders" })).toBeInTheDocument();
  });
});

function Harness({ onConfirm }: { onConfirm: () => Promise<string | null> }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <p>{open ? "open" : "closed"}</p>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Cancel order?"
        description="The customer is refunded."
        confirmLabel="Cancel order"
        tone="danger"
        onConfirm={onConfirm}
      >
        <p>Extra details</p>
      </ConfirmDialog>
    </>
  );
}

describe("ConfirmDialog", () => {
  it("closes after a successful confirmation", async () => {
    const onConfirm = vi.fn(() => Promise.resolve(null));
    render(<Harness onConfirm={onConfirm} />);
    const dialog = screen.getByRole("dialog", { name: "Cancel order?" });
    expect(dialog).toHaveAccessibleDescription("The customer is refunded.");
    expect(screen.getByText("Extra details")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Cancel order" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.getByText("closed")).toBeInTheDocument();
    });
  });

  it("stays open and shows the failure message", async () => {
    render(<Harness onConfirm={() => Promise.resolve("Payment provider refused")} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Cancel order" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Payment provider refused");
    expect(screen.getByText("open")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel order" })).toBeEnabled();
  });

  it("closes on Escape after a failure", async () => {
    const onConfirm = vi.fn(() => Promise.resolve("nope"));
    render(<Harness onConfirm={onConfirm} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Cancel order" }));
    await screen.findByRole("alert");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.getByText("closed")).toBeInTheDocument();
    });
  });

  it("closes from the Cancel button", async () => {
    const onConfirm = vi.fn(() => Promise.resolve(null));
    render(<Harness onConfirm={onConfirm} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("closed")).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("renders without a description", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Publish?"
        confirmLabel="Publish"
        onConfirm={() => Promise.resolve(null)}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Publish?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
  });
});
