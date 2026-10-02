import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { Unsubscribe } from "@/components/email/unsubscribe";
import { setNavigation } from "@/test/navigation";
import { fail, on, server } from "@/test/server";

describe("Unsubscribe", () => {
  it("unsubscribes only on the button press, never on load", async () => {
    const tokens: (string | null)[] = [];
    server.use(
      on("post", "/api/v1/email/unsubscribe", ({ request }) => {
        tokens.push(new URL(request.url).searchParams.get("token"));
        return HttpResponse.json({
          email: "ada@example.com",
          kind: "cart_reminders",
          unsubscribed: true,
        });
      }),
    );
    setNavigation({ pathname: "/unsubscribe", search: { token: "unsub-tok" } });
    const user = userEvent.setup();
    render(<Unsubscribe />);
    expect(screen.getByText(/Stop emails reminding you/)).toBeInTheDocument();
    expect(tokens).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Unsubscribe from cart reminders" }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("You are unsubscribed");
    expect(status).toHaveTextContent("ada@example.com will not get cart reminders again.");
    expect(tokens).toEqual(["unsub-tok"]);
  });

  it("explains an incomplete link", () => {
    render(<Unsubscribe />);
    expect(screen.getByRole("alert")).toHaveTextContent("This link is incomplete");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("points to account settings when the token is rejected", async () => {
    server.use(fail("post", "/api/v1/email/unsubscribe", { status: 400, slug: "invalid-token" }));
    setNavigation({ search: { token: "bad" } });
    const user = userEvent.setup();
    render(<Unsubscribe />);
    await user.click(screen.getByRole("button", { name: "Unsubscribe from cart reminders" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This link is not valid");
    expect(screen.getByRole("link", { name: "account" })).toHaveAttribute(
      "href",
      "/account/preferences",
    );
    // The button stays, so a transient failure can be retried.
    expect(screen.getByRole("button", { name: "Unsubscribe from cart reminders" })).toBeEnabled();
  });
});
