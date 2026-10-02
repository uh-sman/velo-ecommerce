"use client";

/**
 * The last resort: the root layout itself failed, so nothing of the app's
 * shell or styles can be relied on. Plain HTML, inline styles, one action.
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{ fontFamily: "system-ui, sans-serif", padding: "4rem 1rem", textAlign: "center" }}
      >
        <h1 style={{ fontSize: "1.5rem" }}>Velo is having trouble</h1>
        <p>Please try again in a moment. Your cart is saved.</p>
        <button
          type="button"
          onClick={reset}
          style={{ marginTop: "1rem", padding: "0.75rem 1.5rem", fontSize: "1rem" }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
