import type { Schema } from "@velo/api-client";

import { blurhashBackground } from "@/lib/blurhash";
import { cn } from "@/lib/utils";

type Media = Schema<"MediaView">;

/** `url 320w, url 640w, …` for one format, narrowest first. */
function srcSet(media: Media, format: string): string {
  return media.renditions
    .filter((r) => r.format === format)
    .sort((a, b) => a.width - b.width)
    .map((r) => `${r.url} ${r.width}w`)
    .join(", ");
}

/**
 * A catalog image from the renditions the API already made: AVIF first, WebP
 * for browsers without it, each at five widths, so the browser picks the
 * smallest file that fills `sizes`. The intrinsic size is declared, so nothing
 * shifts when it loads (CLS), and the blurhash paints underneath until it does.
 *
 * Next's image optimiser is not used: these files are already resized and
 * encoded, and served from the media CDN — a second pass would only add a hop.
 * Fills its positioned parent, as `next/image` with `fill` does.
 */
export function CatalogImage({
  media,
  alt,
  sizes,
  priority = false,
  className,
}: {
  media: Media;
  alt: string;
  sizes: string;
  /** Above the fold: fetched eagerly and early (the LCP image). */
  priority?: boolean;
  className?: string;
}) {
  const avif = srcSet(media, "avif");
  const webp = srcSet(media, "webp");
  const background = blurhashBackground(media.blurhash);
  return (
    <picture>
      {avif && <source type="image/avif" srcSet={avif} sizes={sizes} />}
      {webp && <source type="image/webp" srcSet={webp} sizes={sizes} />}
      <img
        src={media.url}
        alt={alt}
        sizes={sizes}
        {...(media.width && media.height ? { width: media.width, height: media.height } : {})}
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : "auto"}
        decoding={priority ? "sync" : "async"}
        className={cn("absolute inset-0 size-full bg-cover", className)}
        style={background ? { backgroundImage: background } : undefined}
      />
    </picture>
  );
}
