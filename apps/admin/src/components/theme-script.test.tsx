import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeScript } from "@/components/theme-script";

function scriptSource(): string {
  const { container } = render(<ThemeScript />);
  const script = container.querySelector("script");
  if (!script) throw new Error("ThemeScript rendered no <script>");
  return script.innerHTML;
}

/** Run the inline script as the browser would, before React. */
function runScript(): void {
  // React never runs a <script> it renders; insert a fresh one so jsdom executes it.
  const script = document.createElement("script");
  script.textContent = scriptSource();
  document.head.append(script);
  script.remove();
}

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  vi.restoreAllMocks();
});

describe("ThemeScript", () => {
  it.each(["light", "dark"])("applies a stored %s theme before paint", (theme) => {
    localStorage.setItem("velo-theme", theme);
    runScript();
    expect(document.documentElement).toHaveAttribute("data-theme", theme);
  });

  it("leaves the system preference alone without a valid stored choice", () => {
    localStorage.setItem("velo-theme", "sepia");
    runScript();
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });

  it("survives blocked storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(runScript).not.toThrow();
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });
});
