import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SettingsTabs } from "@/components/settings/settings-tabs";
import { setNavigation } from "@/test/navigation";

describe("SettingsTabs", () => {
  it("links every settings section", () => {
    render(<SettingsTabs />);
    const nav = within(screen.getByRole("navigation", { name: "Settings sections" }));
    expect(
      nav.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["Store", "/settings"],
      ["Emails", "/settings/emails"],
      ["Payments", "/settings/payments"],
      ["Shipping", "/settings/shipping"],
      ["Tax", "/settings/tax"],
    ]);
  });

  it("marks only the current section", () => {
    setNavigation({ pathname: "/settings/tax" });
    render(<SettingsTabs />);
    expect(screen.getByRole("link", { name: "Tax" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Store" })).not.toHaveAttribute("aria-current");
  });
});
