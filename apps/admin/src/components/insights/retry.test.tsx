import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { router } from "@/test/navigation";

import { LoadError } from "./retry";

describe("LoadError", () => {
  it("says what failed and re-renders the route on 'Try again'", async () => {
    const user = userEvent.setup();
    render(<LoadError what="revenue over time" status={500} />);
    expect(screen.getByRole("alert")).toHaveTextContent("We could not load revenue over time.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("offers a retry when the status is unknown (the API was unreachable)", () => {
    render(<LoadError what="stock levels" />);
    expect(screen.getByRole("alert")).toHaveTextContent("We could not load stock levels.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("explains a 403 without a retry that could never succeed", () => {
    render(<LoadError what="the headline figures" status={403} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You do not have access to the headline figures.",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });
});
