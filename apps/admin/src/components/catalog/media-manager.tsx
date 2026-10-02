"use client";

import type { Schema } from "@velo/api-client";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  GripVerticalIcon,
  ImagePlusIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type DragEvent,
  type SetStateAction,
} from "react";

import { Badge, problemMessage } from "@/components/catalog/shared";
import { FieldError, FormAlert } from "@/components/forms/fields";
import { ConfirmDialog } from "@/components/page";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { notify } from "@/components/ui/sonner";
import { callApi } from "@/lib/api-browser";
import { cn } from "@/lib/utils";

type Media = Schema<"MediaView">;
type ImageType = Schema<"PresignRequest">["content_type"];

const IMAGE_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp", "image/avif"];

/*
 * Product images (PAGE-SPECS.md §3.3, API-SPEC.md "Media upload"). Changes
 * here save at once — they are their own API resources, not part of the
 * product form. Upload is three steps and the bytes never touch the API:
 * presign → the browser POSTs the file straight to storage → attach the key
 * with its alt text, which is required, because a store's images are its
 * content. Reorder by drag, or by the move buttons from the keyboard.
 */
export function MediaManager({
  productId,
  media,
  canWrite,
  onChange,
}: {
  productId: string;
  media: Media[];
  canWrite: boolean;
  onChange: Dispatch<SetStateAction<Media[]>>;
}) {
  const [queue, setQueue] = useState<File[] | null>(null);
  const [deleting, setDeleting] = useState<Media | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * Optimistic: the new order shows at once. Every image's position is
   * written, because the API's positions need not start at 0 or be
   * contiguous. If any write fails the old order is shown again and written
   * back, best effort.
   */
  const reorder = async (next: Media[], focusId?: string) => {
    const before = media;
    onChange(next);
    if (focusId) {
      const position = next.findIndex((item) => item.id === focusId) + 1;
      setAnnouncement(`Moved to position ${String(position)} of ${String(next.length)}.`);
    }
    setSaving(true);
    const failure = (await writeOrder(next)).find((outcome) => !outcome.ok);
    if (failure && !failure.ok) {
      onChange(before);
      void writeOrder(before);
      setAnnouncement("The new order could not be saved; it was put back.");
      notify.error(`Could not reorder images: ${problemMessage(failure.problem)}`);
    } else {
      notify.success("Image order saved");
    }
    setSaving(false);
  };

  const move = (id: string, by: number) => {
    const from = media.findIndex((item) => item.id === id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= media.length) return;
    const next = [...media];
    const [item] = next.splice(from, 1);
    if (!item) return;
    next.splice(to, 0, item);
    void reorder(next, id);
  };

  const dropOn = (targetId: string) => {
    if (!dragging || dragging === targetId) return;
    const from = media.findIndex((item) => item.id === dragging);
    const to = media.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...media];
    const [item] = next.splice(from, 1);
    if (!item) return;
    next.splice(to, 0, item);
    void reorder(next, item.id);
  };

  const pickFiles = (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (list.length) setQueue(list);
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {media.length > 0 && (
        <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-busy={saving}>
          {media.map((item, index) => (
            <MediaCard
              key={item.id}
              item={item}
              index={index}
              count={media.length}
              canWrite={canWrite}
              dragging={dragging === item.id}
              onDragStart={() => {
                setDragging(item.id);
              }}
              onDragEnd={() => {
                setDragging(null);
              }}
              onDrop={() => {
                dropOn(item.id);
                setDragging(null);
              }}
              onMove={(by) => {
                move(item.id, by);
              }}
              onDelete={() => {
                setDeleting(item);
              }}
              onSaved={(updated) => {
                onChange((current) => current.map((m) => (m.id === updated.id ? updated : m)));
              }}
            />
          ))}
        </ol>
      )}

      {canWrite && (
        <div
          onDragOver={(event: DragEvent) => {
            if (event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
              setDropActive(true);
            }
          }}
          onDragLeave={() => {
            setDropActive(false);
          }}
          onDrop={(event: DragEvent) => {
            if (!event.dataTransfer.files.length) return;
            event.preventDefault();
            setDropActive(false);
            pickFiles(event.dataTransfer.files);
          }}
          className={cn(
            "border-border-default flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center",
            dropActive && "border-primary bg-primary/5",
          )}
        >
          <ImagePlusIcon className="text-text-tertiary size-6" aria-hidden />
          <p className="text-sm">
            Drop images here, or{" "}
            <Button
              type="button"
              variant="link"
              className="h-auto p-0"
              onClick={() => fileInput.current?.click()}
            >
              choose files
            </Button>
          </p>
          <p className="text-text-tertiary text-xs">JPEG, PNG, WebP or AVIF.</p>
          <input
            ref={fileInput}
            type="file"
            accept={IMAGE_TYPES.join(",")}
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              pickFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </div>
      )}
      {!canWrite && media.length === 0 && <p className="text-text-secondary text-sm">No images.</p>}

      <UploadDialog
        productId={productId}
        files={queue}
        startPosition={media.length}
        onClose={() => {
          setQueue(null);
        }}
        onAttached={(item) => {
          onChange((current) => [...current, item]);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this image?"
        description={
          deleting?.alt_text ? `“${deleting.alt_text}” is removed from the store.` : undefined
        }
        confirmLabel="Delete image"
        tone="danger"
        onConfirm={async () => {
          if (!deleting) return null;
          const target = deleting;
          const outcome = await callApi((client) =>
            client.DELETE("/api/v1/admin/media/{media_id}", {
              params: { path: { media_id: target.id } },
            }),
          );
          if (!outcome.ok) return problemMessage(outcome.problem);
          onChange((current) => current.filter((item) => item.id !== target.id));
          notify.success("Image deleted");
          return null;
        }}
      />
    </div>
  );
}

function MediaCard({
  item,
  index,
  count,
  canWrite,
  dragging,
  onDragStart,
  onDragEnd,
  onDrop,
  onMove,
  onDelete,
  onSaved,
}: {
  item: Media;
  index: number;
  count: number;
  canWrite: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
  onMove: (by: number) => void;
  onDelete: () => void;
  onSaved: (media: Media) => void;
}) {
  const id = useId();
  const [alt, setAlt] = useState(item.alt_text ?? "");
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [over, setOver] = useState(false);

  useEffect(() => {
    setAlt(item.alt_text ?? "");
  }, [item.alt_text]);

  const saveAlt = async () => {
    const value = alt.trim();
    if (!value) {
      setError("Describe the image for people who cannot see it.");
      return;
    }
    setPending(true);
    setError(undefined);
    const outcome = await callApi((client) =>
      client.PATCH("/api/v1/admin/media/{media_id}", {
        params: { path: { media_id: item.id } },
        body: { alt_text: value, detach_variant: false },
      }),
    );
    setPending(false);
    if (outcome.ok) {
      onSaved(outcome.data);
      notify.success("Alt text saved");
    } else {
      setError(problemMessage(outcome.problem));
    }
  };

  const thumb = item.renditions.find((r) => r.width >= 320) ?? null;
  return (
    <li
      draggable={canWrite}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", item.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
      }}
      onDrop={(event) => {
        if (event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setOver(false);
        onDrop();
      }}
      className={cn(
        "border-border-subtle bg-surface-raised flex gap-3 rounded-lg border p-3",
        dragging && "opacity-50",
        over && "border-primary",
      )}
    >
      {canWrite && (
        <div className="flex flex-col items-center gap-1">
          <GripVerticalIcon className="text-text-tertiary size-4 cursor-grab" aria-hidden />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-11 px-0"
            disabled={index === 0}
            aria-label={`Move image ${String(index + 1)} up`}
            onClick={() => {
              onMove(-1);
            }}
          >
            <ArrowUpIcon aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-11 px-0"
            disabled={index === count - 1}
            aria-label={`Move image ${String(index + 1)} down`}
            onClick={() => {
              onMove(1);
            }}
          >
            <ArrowDownIcon aria-hidden />
          </Button>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- storage URLs are not in next/image's allowlist */}
          <img
            src={thumb?.url ?? item.url}
            alt={item.alt_text ?? ""}
            width={96}
            height={96}
            className="bg-surface-sunken size-24 shrink-0 rounded-md object-cover"
          />
          <div className="flex flex-col gap-1 text-xs">
            <span className="text-text-secondary">Image {index + 1}</span>
            {index === 0 && <Badge tone="info">Main image</Badge>}
            {!item.alt_text && <Badge tone="warning">Alt text missing</Badge>}
            {item.renditions.length === 0 && <Badge>Processing</Badge>}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-alt`} className="text-sm font-medium">
            Alt text
          </label>
          <div className="flex gap-2">
            <Input
              id={`${id}-alt`}
              value={alt}
              maxLength={300}
              disabled={!canWrite}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-alt-error` : undefined}
              onChange={(event) => {
                setAlt(event.target.value);
              }}
            />
            {canWrite && alt !== (item.alt_text ?? "") && (
              <Button
                type="button"
                variant="outline"
                loading={pending}
                onClick={() => void saveAlt()}
              >
                Save
              </Button>
            )}
          </div>
          <FieldError id={`${id}-alt-error`} message={error} />
        </div>
        {canWrite && (
          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-danger"
              onClick={onDelete}
            >
              <Trash2Icon aria-hidden />
              Delete
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

function writeOrder(order: Media[]) {
  return Promise.all(
    order.map((item, position) =>
      callApi((client) =>
        client.PATCH("/api/v1/admin/media/{media_id}", {
          params: { path: { media_id: item.id } },
          body: { position, detach_variant: false },
        }),
      ),
    ),
  );
}

// ── Upload ────────────────────────────────────────────────────────────────

interface Pending {
  key: string;
  file: File;
  preview: string;
  alt: string;
  progress: number | null;
  state: "ready" | "uploading" | "attaching" | "done" | "failed";
  error: string | null;
}

/** POST the file to storage with the presigned form fields, reporting progress. */
function uploadToStorage(
  presign: Schema<"PresignResponse">,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(presign.fields)) form.append(name, value);
    form.append("file", file); // last: storage ignores fields after the file
    const request = new XMLHttpRequest();
    request.open("POST", presign.url);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      resolve(request.status >= 200 && request.status < 300);
    };
    request.onerror = () => {
      resolve(false);
    };
    request.send(form);
  });
}

function UploadDialog({
  productId,
  files,
  startPosition,
  onClose,
  onAttached,
}: {
  productId: string;
  files: File[] | null;
  startPosition: number;
  onClose: () => void;
  onAttached: (media: Media) => void;
}) {
  const [items, setItems] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    if (!files) return;
    const next = files.map((file, index) => ({
      key: `${file.name}-${String(index)}-${String(file.lastModified)}`,
      file,
      preview: URL.createObjectURL(file),
      alt: "",
      progress: null,
      state: "ready" as const,
      error: IMAGE_TYPES.includes(file.type)
        ? null
        : "Not a supported image. Use JPEG, PNG, WebP or AVIF.",
    }));
    setItems(next);
    setShowErrors(false);
    return () => {
      for (const item of next) URL.revokeObjectURL(item.preview);
    };
  }, [files]);

  const patch = (key: string, change: Partial<Pending>) => {
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, ...change } : item)),
    );
  };

  const fail = (key: string, error: string) => {
    patch(key, { state: "failed", error, progress: null });
  };

  const uploadOne = async (item: Pending): Promise<boolean> => {
    patch(item.key, { state: "uploading", progress: 0, error: null });
    const presign = await callApi((client) =>
      client.POST("/api/v1/admin/media/presign", {
        body: {
          product_id: productId,
          content_type: item.file.type as ImageType,
          filename: item.file.name.slice(0, 200),
        },
      }),
    );
    if (!presign.ok) {
      fail(item.key, problemMessage(presign.problem));
      return false;
    }
    if (item.file.size > presign.data.max_bytes) {
      const mb = Math.floor(presign.data.max_bytes / (1024 * 1024));
      fail(item.key, `Too large. At most ${String(mb)} MB per image.`);
      return false;
    }
    const uploaded = await uploadToStorage(presign.data, item.file, (fraction) => {
      patch(item.key, { progress: fraction });
    });
    if (!uploaded) {
      fail(item.key, "The upload to storage failed. Try again.");
      return false;
    }
    patch(item.key, { state: "attaching", progress: 1 });
    const attached = await callApi((client) =>
      client.POST("/api/v1/admin/products/{product_id}/media", {
        params: { path: { product_id: productId } },
        body: { key: presign.data.key, alt_text: item.alt.trim() },
      }),
    );
    if (!attached.ok) {
      fail(item.key, problemMessage(attached.problem));
      return false;
    }
    patch(item.key, { state: "done" });
    onAttached(attached.data);
    return true;
  };

  const start = async () => {
    setShowErrors(true);
    const todo = items.filter((item) => item.state !== "done");
    if (todo.some((item) => !item.alt.trim() || !IMAGE_TYPES.includes(item.file.type))) return;
    setBusy(true);
    let done = 0;
    for (const item of todo) {
      if (await uploadOne(item)) done += 1;
    }
    setBusy(false);
    if (done === todo.length) {
      notify.success(done === 1 ? "Image added" : `${String(done)} images added`);
      onClose();
    } else {
      notify.warning(`${String(done)} added, ${String(todo.length - done)} failed`);
    }
  };

  const remaining = items.filter((item) => item.state !== "done");
  return (
    <Dialog
      open={files !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add images</DialogTitle>
          <DialogDescription>
            Every image needs alt text: what a shopper who cannot see it should know.
            {startPosition > 0 && " New images go after the existing ones."}
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <UploadRow
              key={item.key}
              item={item}
              showErrors={showErrors}
              disabled={busy || item.state === "done"}
              onAlt={(alt) => {
                patch(item.key, { alt });
              }}
              onRemove={() => {
                setItems((current) => current.filter((i) => i.key !== item.key));
              }}
            />
          ))}
        </ul>
        {items.length === 0 && <FormAlert tone="info" title="No files left to upload." />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {remaining.length ? "Cancel" : "Close"}
          </Button>
          <Button onClick={() => void start()} loading={busy} disabled={remaining.length === 0}>
            <UploadIcon aria-hidden />
            Upload {remaining.length === 1 ? "image" : `${String(remaining.length)} images`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UploadRow({
  item,
  showErrors,
  disabled,
  onAlt,
  onRemove,
}: {
  item: Pending;
  showErrors: boolean;
  disabled: boolean;
  onAlt: (alt: string) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const altError = showErrors && !item.alt.trim() ? "Alt text is required." : undefined;
  const status =
    item.state === "uploading"
      ? `Uploading ${String(Math.round((item.progress ?? 0) * 100))}%`
      : item.state === "attaching"
        ? "Attaching…"
        : item.state === "done"
          ? "Added"
          : null;
  return (
    <li className="border-border-subtle flex gap-3 rounded-md border p-3">
      {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL preview */}
      <img src={item.preview} alt="" className="size-20 shrink-0 rounded-md object-cover" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="truncate text-sm font-medium">{item.file.name}</p>
        <label htmlFor={`${id}-alt`} className="text-sm">
          Alt text
        </label>
        <Input
          id={`${id}-alt`}
          value={item.alt}
          maxLength={300}
          disabled={disabled}
          placeholder="Black linen shirt, front view"
          aria-invalid={altError ? true : undefined}
          aria-describedby={altError ? `${id}-alt-error` : undefined}
          onChange={(event) => {
            onAlt(event.target.value);
          }}
        />
        <FieldError id={`${id}-alt-error`} message={altError} />
        {item.progress !== null && item.state !== "done" && (
          <progress
            className="h-2 w-full"
            max={1}
            value={item.progress}
            aria-label={`Upload progress for ${item.file.name}`}
          />
        )}
        {status && (
          <p className="text-text-secondary text-xs" aria-live="polite">
            {status}
          </p>
        )}
        <FieldError id={`${id}-error`} message={item.error ?? undefined} />
      </div>
      {item.state !== "done" && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-11 px-0"
          disabled={disabled}
          aria-label={`Remove ${item.file.name}`}
          onClick={onRemove}
        >
          <Trash2Icon aria-hidden />
        </Button>
      )}
    </li>
  );
}
