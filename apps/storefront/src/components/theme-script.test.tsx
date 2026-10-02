import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeScript } from "@/components/theme-script";

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-theme");
});

/** Server-render the tag, as the root layout does, then run it the way the browser would. */
function runThemeScript() {
  const template = document.createElement("template");
  template.innerHTML = renderToStaticMarkup(<ThemeScript />);
  const source = template.content.querySelector("script")?.textContent ?? "";
  const script = document.createElement("script");
  script.textContent = source;
  document.head.append(script);
  script.remove();
  return source;
}

describe("ThemeScript", () => {
  it("is a static inline script", () => {
    expect(runThemeScript()).toContain('localStorage.getItem("velo-theme")');
  });

  it.each(["light", "dark"])("applies a stored %s theme before paint", (theme) => {
    localStorage.setItem("velo-theme", theme);
    runThemeScript();
    expect(document.documentElement).toHaveAttribute("data-theme", theme);
  });

  it("leaves the system preference alone without a valid stored choice", () => {
    localStorage.setItem("velo-theme", "sepia");
    runThemeScript();
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(() => runThemeScript()).not.toThrow();
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });
});
