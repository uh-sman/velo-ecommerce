import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { JsonLd } from "./json-ld";

describe("JsonLd", () => {
  it("renders the data as an ld+json script", () => {
    const { container } = render(<JsonLd data={{ "@type": "Thing", name: "Tote" }} />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(JSON.parse(script?.innerHTML ?? "")).toEqual({ "@type": "Thing", name: "Tote" });
  });

  it("cannot be closed early by a value containing a script tag", () => {
    const { container } = render(<JsonLd data={{ name: "</script><script>alert(1)</script>" }} />);
    const script = container.querySelector("script");
    expect(script?.innerHTML).not.toContain("</script>");
    expect(JSON.parse(script?.innerHTML ?? "")).toEqual({
      name: "</script><script>alert(1)</script>",
    });
  });
});
