import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { STAFF_ID, adminOrder, orderEvent } from "@/test/fixtures/orders";
import { renderWithMe } from "@/test/render";

import { OrderTimeline, payloadSummary } from "./order-timeline";

describe("payloadSummary", () => {
  it("reads money, units, counts, status moves, flags and text", () => {
    expect(
      payloadSummary(
        {
          amount: 1250,
          lines: [{ quantity: 2 }, { quantity: 1 }, { quantity: "x" }],
          one: [{ quantity: 1 }],
          codes: ["A", "B"],
          empty: [],
          status: { from: "paid", to: "processing" },
          other: { nested: true },
          restock: true,
          notify: false,
          carrier: "ups",
          attempts: 2,
          refund_id: "hidden",
          blank: "",
          gone: null,
        },
        "USD",
      ),
    ).toEqual([
      "Amount: $12.50",
      "Lines: 3 units",
      "One: 1 unit",
      "Codes: 2",
      "Status: paid → processing",
      "Restock",
      "Carrier: ups",
      "Attempts: 2",
    ]);
  });

  it("shortens long text and leaves non-numeric money as text", () => {
    const [text, total] = payloadSummary({ reason: "x".repeat(200), total: "n/a" }, "USD");
    expect(text).toBe(`Reason: ${"x".repeat(157)}…`);
    expect(total).toBe("Total: n/a");
  });
});

describe("OrderTimeline", () => {
  it("says when nothing has happened", () => {
    renderWithMe(<OrderTimeline order={adminOrder()} />);
    expect(screen.getByText("Nothing has happened to this order yet.")).toBeInTheDocument();
  });

  it("tells the order's story oldest first, naming who did what", () => {
    renderWithMe(
      <OrderTimeline
        order={adminOrder({
          events: [
            orderEvent({
              id: "e3",
              created_at: "2026-09-01T12:00:00Z",
              event_type: "status_changed",
              actor_type: "staff",
              actor_id: STAFF_ID,
              from_status: "paid",
              to_status: "processing",
            }),
            orderEvent({ id: "e1", created_at: "2026-09-01T10:00:00Z", from_status: null }),
            orderEvent({
              id: "e2",
              created_at: "2026-09-01T11:00:00Z",
              event_type: "paid",
              actor_type: "webhook",
              from_status: "pending",
              to_status: "pending",
              payload: { amount: 5000 },
            }),
            orderEvent({
              id: "e4",
              created_at: "2026-09-01T13:00:00Z",
              event_type: "note_updated",
              actor_type: "staff",
              actor_id: "someone-else",
              to_status: null,
            }),
            orderEvent({
              id: "e5",
              created_at: "2026-09-01T14:00:00Z",
              event_type: "gift_card.applied",
              actor_type: "customer",
              to_status: null,
            }),
            orderEvent({
              id: "e6",
              created_at: "2026-09-01T15:00:00Z",
              event_type: "fulfilled",
              actor_type: "staff",
              actor_id: null,
              from_status: "processing",
              to_status: null,
            }),
          ],
        })}
      />,
    );
    const steps = within(screen.getAllByRole("list")[0] as HTMLElement)
      .getAllByRole("listitem")
      .filter((item) => item.querySelector("time"));
    expect(steps.map((step) => step.querySelector("p")?.textContent)).toEqual([
      "Order placed",
      "Payment captured",
      "Status changed",
      "Internal note updated",
      "Gift card applied",
      "Parcel shipped",
    ]);
    const actor = (index: number) => steps[index]?.querySelectorAll("p")[1]?.textContent;
    expect(actor(0)).toBe("System—Pending");
    expect(actor(1)).toBe("Carrier / provider");
    expect(steps[1]).toHaveTextContent("Amount: $50.00");
    expect(actor(2)).toBe("YouConfirmedPreparing");
    expect(within(steps[2] as HTMLElement).getByRole("img", { name: "to" })).toBeInTheDocument();
    expect(actor(3)).toBe("Staff");
    expect(actor(4)).toBe("Customer");
    expect(actor(5)).toBe("StaffPreparing—");
  });
});
