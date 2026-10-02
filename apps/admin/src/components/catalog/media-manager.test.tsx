import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Schema } from "@velo/api-client";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MediaManager } from "@/components/catalog/media-manager";
import { mediaView, PRODUCT_ID } from "@/test/fixtures/catalog-editor";
import { fail, ok, on, server } from "@/test/server";

type Media = Schema<"MediaView">;

const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  toast: toasts,
}));

vi.setConfig({ testTimeout: 45_000 });

/** Wait for a toast of the given kind with this message. */
async function toasted(kind: keyof typeof toasts, message: string) {
  await waitFor(() => {
    expect(toasts[kind]).toHaveBeenCalledWith(message, expect.anything());
  });
}

const STORAGE = "https://storage.test/velo-media";

const FIRST = mediaView();
const SECOND = mediaView({
  id: "33333333-3333-4333-8333-333333333332",
  alt_text: null,
  url: "https://cdn.test/b.jpg",
  renditions: [],
});

function Harness({ initial, canWrite = true }: { initial: Media[]; canWrite?: boolean }) {
  const [media, setMedia] = useState(initial);
  return (
    <>
      <MediaManager productId={PRODUCT_ID} media={media} canWrite={canWrite} onChange={setMedia} />
      <output aria-label="order">{media.map((m) => m.alt_text ?? m.id).join(" | ")}</output>
    </>
  );
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("no file input");
  return input;
}

function png(name = "shirt.png", bytes = 4): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/png", lastModified: 1 });
}

function presigned(overrides: Partial<Schema<"PresignResponse">> = {}) {
  return ok("post", "/api/v1/admin/media/presign", {
    url: STORAGE,
    key: "products/abc/shirt.png",
    fields: { policy: "p", signature: "s" },
    max_bytes: 10 * 1024 * 1024,
    expires_in: 300,
    ...overrides,
  });
}

beforeEach(() => {
  for (const fn of Object.values(toasts)) fn.mockReset();
  Object.assign(URL, {
    createObjectURL: () => "blob:preview",
    revokeObjectURL: () => undefined,
  });
});

describe("MediaManager — the gallery", () => {
  it("lists images in order with their state", () => {
    render(<Harness initial={[FIRST, SECOND]} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    const first = within(items[0] as HTMLElement);
    expect(first.getByRole("img", { name: "Front view" })).toHaveAttribute(
      "src",
      "https://cdn.test/a-320.webp",
    );
    expect(first.getByText("Main image")).toBeInTheDocument();
    expect(first.getByRole("button", { name: "Move image 1 up" })).toBeDisabled();
    expect(first.getByRole("button", { name: "Move image 1 down" })).toBeEnabled();
    const second = within(items[1] as HTMLElement);
    expect(second.getByText("Alt text missing")).toBeInTheDocument();
    expect(second.getByText("Processing")).toBeInTheDocument();
    expect(second.getByRole("button", { name: "Move image 2 down" })).toBeDisabled();
    expect(items[1]?.querySelector("img")).toHaveAttribute("src", "https://cdn.test/b.jpg");
  });

  it("is read-only without catalog:write", () => {
    const { unmount } = render(<Harness initial={[FIRST]} canWrite={false} />);
    expect(screen.getByLabelText("Alt text")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Move image/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "choose files" })).not.toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveAttribute("draggable", "false");
    unmount();
    render(<Harness initial={[]} canWrite={false} />);
    expect(screen.getByText("No images.")).toBeInTheDocument();
  });
});

describe("MediaManager — alt text", () => {
  it("saves edited alt text", async () => {
    const user = userEvent.setup();
    let sent: unknown;
    server.use(
      on("patch", "/api/v1/admin/media/{media_id}", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ ...FIRST, alt_text: "Back view" });
      }),
    );
    render(<Harness initial={[FIRST]} />);
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    const alt = screen.getByLabelText("Alt text");
    await user.clear(alt);
    await user.type(alt, " Back view ");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await toasted("success", "Alt text saved");
    expect(sent).toEqual({ alt_text: "Back view", detach_variant: false });
    expect(screen.getByRole("status", { name: "order" })).toHaveTextContent("Back view");
  });

  it("requires alt text before saving, and shows the server's refusal", async () => {
    const user = userEvent.setup();
    server.use(
      fail("patch", "/api/v1/admin/media/{media_id}", {
        status: 422,
        title: "Invalid",
        detail: "Alt text is too vague.",
      }),
    );
    render(<Harness initial={[FIRST]} />);
    const alt = screen.getByLabelText("Alt text");
    await user.clear(alt);
    await user.type(alt, "   ");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(alt).toHaveAttribute("aria-invalid", "true");
    expect(alt).toHaveAccessibleDescription("Describe the image for people who cannot see it.");

    await user.type(alt, "img");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(alt).toHaveAccessibleDescription("Alt text is too vague.");
    });
  });
});

describe("MediaManager — ordering", () => {
  it("moves an image with the buttons and writes every position", async () => {
    const user = userEvent.setup();
    const writes: Record<string, unknown> = {};
    server.use(
      on("patch", "/api/v1/admin/media/{media_id}", async ({ request, params }) => {
        writes[String(params["media_id"])] = await request.json();
        return HttpResponse.json(FIRST);
      }),
    );
    render(<Harness initial={[FIRST, SECOND]} />);
    await user.click(screen.getByRole("button", { name: "Move image 1 down" }));
    expect(screen.getByText("Moved to position 2 of 2.")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "order" })).toHaveTextContent(
      `${SECOND.id} | Front view`,
    );
    await toasted("success", "Image order saved");
    expect(writes).toEqual({
      [SECOND.id]: { position: 0, detach_variant: false },
      [FIRST.id]: { position: 1, detach_variant: false },
    });

    await user.click(screen.getByRole("button", { name: "Move image 2 up" }));
    expect(screen.getByRole("status", { name: "order" })).toHaveTextContent(
      `Front view | ${SECOND.id}`,
    );
  });

  it("puts the old order back when a write fails", async () => {
    const user = userEvent.setup();
    server.use(
      fail("patch", "/api/v1/admin/media/{media_id}", {
        status: 409,
        title: "Conflict",
        detail: "Media changed.",
      }),
    );
    render(<Harness initial={[FIRST, SECOND]} />);
    await user.click(screen.getByRole("button", { name: "Move image 2 up" }));
    await toasted("error", "Could not reorder images: Media changed.");
    expect(
      screen.getByText("The new order could not be saved; it was put back."),
    ).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "order" })).toHaveTextContent(
      `Front view | ${SECOND.id}`,
    );
  });

  it("reorders by drag and drop", async () => {
    const order: string[] = [];
    server.use(
      on("patch", "/api/v1/admin/media/{media_id}", async ({ request, params }) => {
        const body = (await request.json()) as { position: number };
        order[body.position] = String(params["media_id"]);
        return HttpResponse.json(FIRST);
      }),
    );
    render(<Harness initial={[FIRST, SECOND]} />);
    const [first, second] = screen.getAllByRole("listitem") as [HTMLElement, HTMLElement];
    const data = { types: [] as string[], setData: () => undefined, effectAllowed: "none" };
    fireEvent.dragStart(first, { dataTransfer: data });
    expect(data.effectAllowed).toBe("move");
    expect(first).toHaveClass("opacity-50");

    // Dropping on itself does nothing.
    fireEvent.drop(first, { dataTransfer: data });
    expect(screen.getByRole("status", { name: "order" })).toHaveTextContent(
      `Front view | ${SECOND.id}`,
    );

    fireEvent.dragStart(first, { dataTransfer: data });
    const over = createEvent.dragOver(second, { dataTransfer: data });
    fireEvent(second, over);
    expect(over.defaultPrevented).toBe(true);
    expect(second).toHaveClass("border-primary");
    fireEvent.dragLeave(second);
    expect(second).not.toHaveClass("border-primary");
    fireEvent.drop(second, { dataTransfer: data });
    fireEvent.dragEnd(first);
    expect(screen.getByRole("status", { name: "order" })).toHaveTextContent(
      `${SECOND.id} | Front view`,
    );
    expect(screen.getByText("Moved to position 2 of 2.")).toBeInTheDocument();
    await waitFor(() => {
      expect(order).toEqual([SECOND.id, FIRST.id]);
    });
  });

  it("ignores files dragged over an image, and drops without a drag source", () => {
    render(<Harness initial={[FIRST, SECOND]} />);
    const [, second] = screen.getAllByRole("listitem") as [HTMLElement, HTMLElement];
    const files = { types: ["Files"], files: [] };
    const over = createEvent.dragOver(second, { dataTransfer: files });
    fireEvent(second, over);
    expect(over.defaultPrevented).toBe(false);
    fireEvent.drop(second, { dataTransfer: files });
    // A drop with nothing being dragged is ignored too.
    fireEvent.drop(second, { dataTransfer: { types: [] } });
    expect(screen.getByRole("status", { name: "order" })).toHaveTextContent(
      `Front view | ${SECOND.id}`,
    );
  });
});

describe("MediaManager — delete", () => {
  it("confirms, deletes, and removes the image", async () => {
    const user = userEvent.setup();
    server.use(ok("delete", "/api/v1/admin/media/{media_id}", null, 204));
    render(<Harness initial={[FIRST, SECOND]} />);
    const firstItem = screen.getAllByRole("listitem")[0] as HTMLElement;
    await user.click(within(firstItem).getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete this image?" });
    expect(dialog).toHaveTextContent("“Front view” is removed from the store.");
    await user.click(within(dialog).getByRole("button", { name: "Delete image" }));
    await toasted("success", "Image deleted");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("keeps the dialog open with the problem when the delete fails, and cancels", async () => {
    const user = userEvent.setup();
    server.use(
      fail("delete", "/api/v1/admin/media/{media_id}", {
        status: 403,
        title: "Forbidden",
        detail: "Not allowed.",
      }),
    );
    render(<Harness initial={[SECOND]} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete this image?" });
    expect(dialog).not.toHaveTextContent("is removed from the store");
    await user.click(within(dialog).getByRole("button", { name: "Delete image" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Not allowed.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});

describe("MediaManager — upload", () => {
  it("presigns, uploads to storage, then attaches with alt text", async () => {
    const user = userEvent.setup();
    let presignBody: unknown;
    let storageHits = 0;
    // jsdom's FormData reaches MSW unserialised ("[object FormData]"), so the
    // multipart fields are observed where they are built.
    const append = vi.spyOn(FormData.prototype, "append");
    let attachBody: unknown;
    server.use(
      on("post", "/api/v1/admin/media/presign", async ({ request }) => {
        presignBody = await request.json();
        return HttpResponse.json({
          url: STORAGE,
          key: "products/abc/shirt.png",
          fields: { policy: "p", signature: "s" },
          max_bytes: 1024,
          expires_in: 300,
        });
      }),
      http.post(STORAGE, () => {
        storageHits += 1;
        return new HttpResponse(null, { status: 204 });
      }),
      on("post", "/api/v1/admin/products/{product_id}/media", async ({ request }) => {
        attachBody = await request.json();
        return HttpResponse.json(mediaView({ id: "new-media", alt_text: "Shirt, folded" }), {
          status: 201,
        });
      }),
    );
    render(<Harness initial={[FIRST]} />);
    await user.click(screen.getByRole("button", { name: "choose files" }));
    await user.upload(fileInput(), png());

    const dialog = await screen.findByRole("dialog", { name: "Add images" });
    expect(dialog).toHaveTextContent("New images go after the existing ones.");
    expect(within(dialog).getByText("shirt.png")).toBeInTheDocument();

    // Alt text is required before anything is sent.
    await user.click(within(dialog).getByRole("button", { name: "Upload image" }));
    const alt = within(dialog).getByLabelText("Alt text");
    expect(alt).toHaveAccessibleDescription("Alt text is required.");
    expect(presignBody).toBeUndefined();

    await user.type(alt, " Shirt, folded ");
    await user.click(within(dialog).getByRole("button", { name: "Upload image" }));
    await toasted("success", "Image added");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(presignBody).toEqual({
      product_id: PRODUCT_ID,
      content_type: "image/png",
      filename: "shirt.png",
    });
    expect(storageHits).toBe(1);
    // The presigned fields first, then the file: storage ignores fields after it.
    expect(append.mock.calls.map(([name]) => name)).toEqual(["policy", "signature", "file"]);
    expect(append.mock.calls[2]?.[1]).toBeInstanceOf(File);
    append.mockRestore();
    expect(attachBody).toEqual({ key: "products/abc/shirt.png", alt_text: "Shirt, folded" });
    expect(screen.getByRole("status", { name: "order" })).toHaveTextContent(
      "Front view | Shirt, folded",
    );
  });

  it("accepts files dropped on the drop zone", async () => {
    render(<Harness initial={[]} />);
    const zone = screen.getByText("JPEG, PNG, WebP or AVIF.").parentElement as HTMLElement;
    const transfer = { types: ["Files"], files: [png("a.png"), png("b.png")] };
    const over = createEvent.dragOver(zone, { dataTransfer: transfer });
    fireEvent(zone, over);
    expect(over.defaultPrevented).toBe(true);
    expect(zone).toHaveClass("border-primary");
    fireEvent.dragLeave(zone);
    expect(zone).not.toHaveClass("border-primary");
    // A drag of something other than files is not a drop target.
    const text = createEvent.dragOver(zone, { dataTransfer: { types: ["text/plain"] } });
    fireEvent(zone, text);
    expect(text.defaultPrevented).toBe(false);
    fireEvent.drop(zone, { dataTransfer: { types: [], files: [] } });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.drop(zone, { dataTransfer: transfer });
    const dialog = await screen.findByRole("dialog", { name: "Add images" });
    expect(dialog).not.toHaveTextContent("New images go after the existing ones.");
    expect(within(dialog).getByRole("button", { name: "Upload 2 images" })).toBeInTheDocument();
  });

  it("rejects unsupported files, and can remove every file", async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<Harness initial={[]} />);
    await user.upload(fileInput(), new File(["x"], "notes.txt", { type: "text/plain" }));
    const dialog = await screen.findByRole("dialog", { name: "Add images" });
    expect(dialog).toHaveTextContent("Not a supported image. Use JPEG, PNG, WebP or AVIF.");
    await user.type(within(dialog).getByLabelText("Alt text"), "Notes");
    await user.click(within(dialog).getByRole("button", { name: "Upload image" }));
    // Nothing was sent: an unhandled presign request would have failed the test.
    expect(within(dialog).getByRole("button", { name: "Upload image" })).toBeEnabled();

    await user.click(within(dialog).getByRole("button", { name: "Remove notes.txt" }));
    expect(within(dialog).getByRole("status")).toHaveTextContent("No files left to upload.");
    expect(within(dialog).getByRole("button", { name: /Upload/ })).toBeDisabled();
    // The footer's Close, not the dialog's corner close button.
    await user.click(within(dialog).getAllByRole("button", { name: "Close" })[0] as HTMLElement);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("reports each failed step on its file and keeps the dialog open", async () => {
    const user = userEvent.setup();
    let presigns = 0;
    server.use(
      on("post", "/api/v1/admin/media/presign", async ({ request }) => {
        presigns += 1;
        const body = (await request.json()) as { filename: string };
        if (body.filename === "denied.png") {
          return HttpResponse.json(
            {
              type: "https://velo.dev/errors/forbidden",
              title: "Forbidden",
              status: 403,
              detail: "Uploads are disabled.",
            },
            { status: 403 },
          );
        }
        return HttpResponse.json({
          url: body.filename === "broken.png" ? `${STORAGE}/broken` : STORAGE,
          key: `k/${body.filename}`,
          fields: {},
          max_bytes: body.filename === "huge.png" ? 2 * 1024 * 1024 : 1024,
          expires_in: 300,
        });
      }),
      http.post(STORAGE, () => new HttpResponse(null, { status: 204 })),
      http.post(`${STORAGE}/broken`, () => new HttpResponse(null, { status: 500 })),
      fail("post", "/api/v1/admin/products/{product_id}/media", {
        status: 422,
        title: "Invalid",
        detail: "Unknown upload key.",
      }),
    );
    render(<Harness initial={[]} />);
    await user.upload(fileInput(), [
      png("denied.png"),
      png("huge.png", 3 * 1024 * 1024),
      png("broken.png"),
      png("orphan.png"),
    ]);
    const dialog = await screen.findByRole("dialog", { name: "Add images" });
    for (const input of within(dialog).getAllByLabelText("Alt text")) {
      await user.type(input, "A shirt");
    }
    await user.click(within(dialog).getByRole("button", { name: "Upload 4 images" }));
    await toasted("warning", "0 added, 4 failed");
    expect(presigns).toBe(4);
    expect(dialog).toHaveTextContent("Uploads are disabled.");
    expect(dialog).toHaveTextContent("Too large. At most 2 MB per image.");
    expect(dialog).toHaveTextContent("The upload to storage failed. Try again.");
    expect(dialog).toHaveTextContent("Unknown upload key.");
    expect(screen.getByRole("dialog", { name: "Add images" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("counts partial success and does not re-upload a file already added", async () => {
    const user = userEvent.setup();
    let attaches = 0;
    server.use(
      on("post", "/api/v1/admin/media/presign", async ({ request }) => {
        const body = (await request.json()) as { filename: string };
        return HttpResponse.json({
          url: body.filename === "bad.png" ? `${STORAGE}/bad` : STORAGE,
          key: `k/${body.filename}`,
          fields: {},
          max_bytes: 1024,
          expires_in: 300,
        });
      }),
      http.post(STORAGE, () => new HttpResponse(null, { status: 204 })),
      http.post(`${STORAGE}/bad`, () => HttpResponse.error()),
      on("post", "/api/v1/admin/products/{product_id}/media", () => {
        attaches += 1;
        return HttpResponse.json(mediaView({ id: `m${String(attaches)}`, alt_text: "Good" }), {
          status: 201,
        });
      }),
    );
    render(<Harness initial={[]} />);
    await user.upload(fileInput(), [png("good.png"), png("bad.png")]);
    const dialog = await screen.findByRole("dialog", { name: "Add images" });
    for (const input of within(dialog).getAllByLabelText("Alt text")) {
      await user.type(input, "Good");
    }
    await user.click(within(dialog).getByRole("button", { name: "Upload 2 images" }));
    await toasted("warning", "1 added, 1 failed");
    expect(within(dialog).getByText("Added")).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "Remove good.png" }),
    ).not.toBeInTheDocument();
    expect(within(dialog).getAllByLabelText("Alt text")[0]).toBeDisabled();

    // Retrying only sends what is left.
    server.use(presigned());
    await user.click(within(dialog).getByRole("button", { name: "Upload image" }));
    await toasted("success", "Image added");
    expect(attaches).toBe(2);
  });
});
