"""Image derivatives: responsive widths in AVIF and WebP, and a blurhash placeholder.

Runs in the worker, never in a request. The uploaded original is decoded here,
which is also the validation: a file Pillow cannot open as an image is refused,
whatever its name or declared type said.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass

from PIL import Image, ImageOps

# Widths the storefront's srcset draws from (DESIGN-SYSTEM.md breakpoints at 1x and 2x).
WIDTHS = (320, 640, 960, 1280, 1920)
FORMATS = (("avif", "image/avif", 55), ("webp", "image/webp", 80))  # name, type, quality
MAX_PIXELS = 40_000_000  # a decompression bomb is refused before it is decoded

_BASE83 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~"


class InvalidImageError(ValueError):
    """The upload is not an image this pipeline can read."""


@dataclass(frozen=True, slots=True)
class Rendition:
    width: int
    height: int
    format: str
    content_type: str
    data: bytes


@dataclass(frozen=True, slots=True)
class ProcessedImage:
    width: int
    height: int
    blurhash: str
    renditions: list[Rendition]


def process(data: bytes) -> ProcessedImage:
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with Image.open(io.BytesIO(data)) as opened:
            opened.verify()  # structural check; the image must be reopened afterwards
        with Image.open(io.BytesIO(data)) as source:
            image = ImageOps.exif_transpose(source)  # phone photos arrive rotated
            image.load()
    except (OSError, SyntaxError, Image.DecompressionBombError) as exc:
        raise InvalidImageError("The file is not a readable image.") from exc

    if image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
    width, height = image.size

    renditions: list[Rendition] = []
    # Every standard width below the original, plus the original width itself.
    targets = sorted({w for w in WIDTHS if w < width} | {min(width, WIDTHS[-1])})
    for target in targets:
        resized = (
            image
            if target == width
            else image.resize(
                (target, max(1, round(height * target / width))), Image.Resampling.LANCZOS
            )
        )
        for name, content_type, quality in FORMATS:
            buffer = io.BytesIO()
            resized.save(buffer, format=name.upper(), quality=quality)
            renditions.append(
                Rendition(
                    width=resized.width,
                    height=resized.height,
                    format=name,
                    content_type=content_type,
                    data=buffer.getvalue(),
                )
            )
    return ProcessedImage(
        width=width, height=height, blurhash=blurhash(image), renditions=renditions
    )


# ── Blurhash (https://github.com/woltapp/blurhash, the reference algorithm) ──


def _srgb_to_linear(value: int) -> float:
    v = value / 255
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def _linear_to_srgb(value: float) -> int:
    v = max(0.0, min(1.0, value))
    return round((v * 12.92 if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055) * 255)


def _base83(value: int, length: int) -> str:
    return "".join(_BASE83[(value // 83 ** (length - i - 1)) % 83] for i in range(length))


def _sign_pow(value: float, exponent: float) -> float:
    return math.copysign(abs(value) ** exponent, value)


def blurhash(image: Image.Image, x_components: int = 4, y_components: int = 3) -> str:
    """A ~30-character placeholder the storefront paints while the image loads."""
    small = image.convert("RGB")
    small.thumbnail((32, 32))
    width, height = small.size
    pixels = [_srgb_to_linear(channel) for channel in small.tobytes()]

    factors: list[tuple[float, float, float]] = []
    for j in range(y_components):
        for i in range(x_components):
            normalisation = 1 if i == 0 and j == 0 else 2
            r = g = b = 0.0
            for y in range(height):
                basis_y = math.cos(math.pi * j * y / height)
                for x in range(width):
                    basis = normalisation * math.cos(math.pi * i * x / width) * basis_y
                    offset = 3 * (y * width + x)
                    r += basis * pixels[offset]
                    g += basis * pixels[offset + 1]
                    b += basis * pixels[offset + 2]
            scale = 1 / (width * height)
            factors.append((r * scale, g * scale, b * scale))

    dc, ac = factors[0], factors[1:]
    result = _base83((x_components - 1) + (y_components - 1) * 9, 1)
    if ac:
        actual_max = max(abs(component) for factor in ac for component in factor)
        quantised_max = max(0, min(82, math.floor(actual_max * 166 - 0.5)))
        maximum = (quantised_max + 1) / 166
        result += _base83(quantised_max, 1)
    else:
        maximum = 1.0
        result += _base83(0, 1)
    result += _base83(
        (_linear_to_srgb(dc[0]) << 16) + (_linear_to_srgb(dc[1]) << 8) + _linear_to_srgb(dc[2]), 4
    )
    for factor in ac:
        quantised = [
            max(0, min(18, math.floor(_sign_pow(component / maximum, 0.5) * 9 + 9.5)))
            for component in factor
        ]
        result += _base83(quantised[0] * 19 * 19 + quantised[1] * 19 + quantised[2], 2)
    return result
