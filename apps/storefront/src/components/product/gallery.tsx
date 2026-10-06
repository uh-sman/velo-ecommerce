"use client";

import type { Schema } from "@velo/api-client";
import { ZoomInIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { CatalogImage } from "@/components/commerce/catalog-image";

type Media = Schema<"MediaView">;

/*
 * The product gallery (PLANNING.md 10.3): thumbnails on desktop, a swipeable
 * strip with position dots on phones, and a full-size view to zoom into.
 * Only the first image loads eagerly; the rest wait until they are near.
 * When a variant with its own image is chosen, the gallery moves to it.
 */
export function Gallery({
  media,
  title,
  focusMediaId,
}: {
  media: Media[];
  title: string;
  focusMediaId?: string | null | undefined;
}) {
  const [index, setIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusMediaId) return;
    // Follow the chosen variant only; the media list itself does not change.
    const found = media.findIndex((item) => item.id === focusMediaId);
    if (found >= 0) show(found);
  }, [focusMediaId]);

  function show(next: number) {
    setIndex(next);
    const node = strip.current;
    if (node) node.scrollTo({ left: node.clientWidth * next, behavior: "smooth" });
  }

  if (media.length === 0) {
    return <div className="bg-surface-sunken aspect-[4/5] rounded-lg" aria-hidden />;
  }
  const current = media[index] ?? media[0];

  return (
    <div className="flex flex-col gap-3 lg:sticky lg:top-24">
      <div className="relative">
        <div
          ref={strip}
          className="flex snap-x snap-mandatory overflow-x-auto rounded-lg [scrollbar-width:none] lg:overflow-hidden"
          onScroll={(event) => {
            const node = event.currentTarget;
            const next = Math.round(node.scrollLeft / node.clientWidth);
            if (next !== index) setIndex(next);
          }}
          aria-roledescription="carousel"
          aria-label={`${title} images`}
        >
          {media.map((item, position) => (
            <div
              key={item.id}
              className="bg-surface-sunken relative aspect-[4/5] w-full shrink-0 snap-center"
              aria-roledescription="slide"
              aria-label={`Image ${String(position + 1)} of ${String(media.length)}`}
            >
              <CatalogImage
                media={item}
                alt={item.alt_text ?? title}
                priority={position === 0}
                sizes="(min-width: 1024px) 50vw, 100vw"
                className="object-cover"
              />
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            setZoomed(true);
          }}
          className="bg-surface-raised/90 absolute bottom-3 right-3 flex size-11 items-center justify-center rounded-full shadow"
          aria-label="Zoom image"
        >
          <ZoomInIcon className="size-5" aria-hidden />
        </button>
      </div>

      {media.length > 1 && (
        <>
          <div className="flex justify-center gap-1.5 lg:hidden" aria-hidden>
            {media.map((item, position) => (
              <span
                key={item.id}
                className={cn(
                  "size-2 rounded-full",
                  position === index ? "bg-text-primary" : "bg-border-default",
                )}
              />
            ))}
          </div>
          <ul className="hidden grid-cols-5 gap-2 lg:grid" aria-label="Choose an image">
            {media.map((item, position) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    show(position);
                  }}
                  aria-current={position === index}
                  aria-label={`Show image ${String(position + 1)}`}
                  className={cn(
                    "bg-surface-sunken relative block aspect-square w-full overflow-hidden rounded-md border-2",
                    position === index ? "border-primary" : "border-transparent",
                  )}
                >
                  <CatalogImage media={item} alt="" sizes="96px" className="object-cover" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <Dialog open={zoomed} onOpenChange={setZoomed}>
        <DialogContent className="h-[90vh] max-w-[95vw] p-2 sm:max-w-[95vw]">
          <DialogTitle className="sr-only">{current?.alt_text ?? title}</DialogTitle>
          {current && (
            <div className="relative h-full w-full overflow-auto">
              <CatalogImage
                media={current}
                alt={current.alt_text ?? title}
                sizes="95vw"
                className="object-contain"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
