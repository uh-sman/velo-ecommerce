/**
 * Blurhash → a CSS background, computed on the server.
 *
 * The API stores a blurhash per image (velo/domains/catalog/images.py, the
 * reference algorithm from github.com/woltapp/blurhash). Decoding it to a
 * canvas needs the browser; instead it is decoded here to a handful of colour
 * cells and drawn as a blurred inline SVG, so the placeholder is in the first
 * HTML byte and costs no JavaScript.
 */

const DIGITS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";

function decode83(text: string): number {
  let value = 0;
  for (const char of text) {
    const digit = DIGITS.indexOf(char);
    if (digit < 0) throw new Error("not a blurhash");
    value = value * 83 + digit;
  }
  return value;
}

function toLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function toSrgb(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  return v <= 0.0031308
    ? Math.round(v * 12.92 * 255)
    : Math.round((1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255);
}

function signPow(value: number, exponent: number): number {
  return Math.sign(value) * Math.pow(Math.abs(value), exponent);
}

/** The hash decoded to a `width` × `height` grid of `[r, g, b]`; null if malformed. */
export function decodeBlurhash(hash: string, width: number, height: number): number[][] | null {
  try {
    if (hash.length < 6) return null;
    const size = decode83(hash[0]!);
    const nx = (size % 9) + 1;
    const ny = Math.floor(size / 9) + 1;
    if (hash.length !== 4 + 2 * nx * ny) return null;
    const maximum = (decode83(hash[1]!) + 1) / 166;

    const colours: number[][] = [];
    for (let i = 0; i < nx * ny; i++) {
      if (i === 0) {
        const dc = decode83(hash.slice(2, 6));
        colours.push([toLinear(dc >> 16), toLinear((dc >> 8) & 255), toLinear(dc & 255)]);
      } else {
        const ac = decode83(hash.slice(4 + i * 2, 6 + i * 2));
        colours.push([
          signPow((Math.floor(ac / 361) - 9) / 9, 2) * maximum,
          signPow(((Math.floor(ac / 19) % 19) - 9) / 9, 2) * maximum,
          signPow(((ac % 19) - 9) / 9, 2) * maximum,
        ]);
      }
    }

    const pixels: number[][] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const rgb = [0, 0, 0];
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i < nx; i++) {
            const basis =
              Math.cos((Math.PI * x * i) / width) * Math.cos((Math.PI * y * j) / height);
            const colour = colours[i + j * nx]!;
            rgb[0]! += colour[0]! * basis;
            rgb[1]! += colour[1]! * basis;
            rgb[2]! += colour[2]! * basis;
          }
        }
        pixels.push(rgb.map(toSrgb));
      }
    }
    return pixels;
  } catch {
    return null;
  }
}

const COLUMNS = 6;
const ROWS = 4;

/**
 * A `background-image` value for the hash: a 6 × 4 grid of cells, blurred.
 * Undefined when there is no usable hash — the sunken surface colour shows.
 */
export function blurhashBackground(hash: string | null | undefined): string | undefined {
  if (!hash) return undefined;
  const pixels = decodeBlurhash(hash, COLUMNS, ROWS);
  if (!pixels) return undefined;
  const cells = pixels
    .map((rgb, index) => {
      const x = index % COLUMNS;
      const y = Math.floor(index / COLUMNS);
      return `<rect x='${x}' y='${y}' width='1' height='1' fill='rgb(${rgb.join(",")})'/>`;
    })
    .join("");
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${COLUMNS} ${ROWS}' preserveAspectRatio='none'>` +
    `<filter id='b' x='0' y='0'><feGaussianBlur stdDeviation='0.6' edgeMode='duplicate'/></filter>` +
    `<g filter='url(#b)'>${cells}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
