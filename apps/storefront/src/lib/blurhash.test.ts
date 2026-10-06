import { describe, expect, it } from "vitest";

import { blurhashBackground, decodeBlurhash } from "./blurhash";

// Encoded by the API (velo/domains/catalog/images.py), so the two sides agree.
const SOLID_RED = "L7M_9,]TfQ]T|^o1fQo1fQfQfQfQ"; // 64×48 of rgb(200, 40, 30)
const BLACK_THEN_WHITE = "L~Lg^Z00Rj-;t7WBayj[fQfQfQfQ"; // left half black, right half white

describe("decodeBlurhash", () => {
  it("decodes a solid colour back to that colour", () => {
    const pixels = decodeBlurhash(SOLID_RED, 4, 3)!;
    expect(pixels).toHaveLength(12);
    // Lossy: the components are quantised, so allow a little drift.
    for (const [r = 0, g = 0, b = 0] of pixels) {
      expect(Math.abs(r - 200)).toBeLessThan(25);
      expect(Math.abs(g - 40)).toBeLessThan(10);
      expect(Math.abs(b - 30)).toBeLessThan(10);
    }
  });

  it("keeps the shape of the image: dark on the left, light on the right", () => {
    const pixels = decodeBlurhash(BLACK_THEN_WHITE, 6, 1)!;
    const brightness = pixels.map(([r = 0]) => r);
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    // A hard edge rings a little in a few cosine terms; the halves still read clearly.
    expect(mean(brightness.slice(0, 3))).toBeLessThan(110);
    expect(mean(brightness.slice(3))).toBeGreaterThan(220);
  });

  it("refuses malformed hashes", () => {
    expect(decodeBlurhash("abc", 4, 3)).toBeNull();
    expect(decodeBlurhash(SOLID_RED.slice(0, -2), 4, 3)).toBeNull(); // wrong length
    expect(decodeBlurhash("L7M_9,]TfQ]T|^o1fQo1fQfQfQfé", 4, 3)).toBeNull(); // bad digit
  });
});

describe("blurhashBackground", () => {
  it("is a blurred SVG of the colours", () => {
    const background = blurhashBackground(SOLID_RED)!;
    expect(background.startsWith('url("data:image/svg+xml,')).toBe(true);
    const svg = decodeURIComponent(background.slice('url("data:image/svg+xml,'.length, -2));
    expect(svg).toContain("feGaussianBlur");
    expect(svg.match(/<rect /g)).toHaveLength(24);
  });

  it("is nothing without a usable hash", () => {
    expect(blurhashBackground(null)).toBeUndefined();
    expect(blurhashBackground("")).toBeUndefined();
    expect(blurhashBackground("nope")).toBeUndefined();
  });
});
