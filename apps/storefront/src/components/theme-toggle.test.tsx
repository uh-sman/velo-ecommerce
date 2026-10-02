import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeToggle } from "@/components/theme-toggle";

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-theme");
});

function pressed() {
  return screen
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-pressed") === "true")
    .map((button) => button.textContent);
}

describe("ThemeToggle", () => {
  it("offers light, system and dark, following the system by default", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("group", { name: "Colour theme" })).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "light",
      "system",
      "dark",
    ]);
    expect(pressed()).toEqual(["system"]);
  });

  it("starts from the stored choice", () => {
    localStorage.setItem("velo-theme", "dark");
    render(<ThemeToggle />);
    expect(pressed()).toEqual(["dark"]);
  });

  it("ignores a stored value it does not recognise", () => {
    localStorage.setItem("velo-theme", "sepia");
    render(<ThemeToggle />);
    expect(pressed()).toEqual(["system"]);
  });

  it("applies and stores a choice, and forgets it for system", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole("button", { name: "dark" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("velo-theme")).toBe("dark");
    expect(pressed()).toEqual(["dark"]);
    await user.click(screen.getByRole("button", { name: "light" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    await user.click(screen.getByRole("button", { name: "system" }));
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(localStorage.getItem("velo-theme")).toBeNull();
  });

  it("still applies a choice when storage is unavailable", async () => {
    const boom = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(boom);
    const user = userEvent.setup();
    render(<ThemeToggle />);
    expect(pressed()).toEqual(["system"]);
    await user.click(screen.getByRole("button", { name: "dark" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(pressed()).toEqual(["dark"]);
  });
});
