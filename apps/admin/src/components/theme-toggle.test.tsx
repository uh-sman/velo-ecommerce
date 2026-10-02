import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeToggle } from "@/components/theme-toggle";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  vi.restoreAllMocks();
});

describe("ThemeToggle", () => {
  it("offers three themes in a labelled group, following the system by default", () => {
    render(<ThemeToggle />);
    const group = screen.getByRole("group", { name: "Colour theme" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["light", "system", "dark"]);
    expect(screen.getByRole("button", { name: "system" })).toHaveAttribute("aria-pressed", "true");
  });

  it("restores a stored choice", () => {
    localStorage.setItem("velo-theme", "dark");
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "dark" })).toHaveAttribute("aria-pressed", "true");
  });

  it("ignores a stored value that is not a theme", () => {
    localStorage.setItem("velo-theme", "sepia");
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "system" })).toHaveAttribute("aria-pressed", "true");
  });

  it("applies and stores a choice, and forgets it for system", async () => {
    render(<ThemeToggle />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "light" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(localStorage.getItem("velo-theme")).toBe("light");
    expect(screen.getByRole("button", { name: "light" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "system" }));
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(localStorage.getItem("velo-theme")).toBeNull();
  });

  it("still applies a theme when storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "system" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.setup().click(screen.getByRole("button", { name: "dark" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(screen.getByRole("button", { name: "dark" })).toHaveAttribute("aria-pressed", "true");
  });
});
