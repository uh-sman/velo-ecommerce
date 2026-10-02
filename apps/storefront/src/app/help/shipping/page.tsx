import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Shipping" };

export default function ShippingHelp() {
  return (
    <article className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-12 leading-relaxed">
      <h1 className="text-3xl font-semibold tracking-tight">Shipping</h1>
      <p>
        Standard shipping is free on orders over $75, and $5.99 below that. Express options, where
        available, are shown with their prices and delivery estimates at checkout — before you pay.
      </p>
      <h2 className="mt-4 text-xl font-semibold">When it ships</h2>
      <p>
        Most orders leave within 1–2 business days. You get an email with a tracking link the moment
        your parcel is on its way; if an order ships in more than one parcel, each gets its own
        email and link.
      </p>
      <h2 className="mt-4 text-xl font-semibold">Following your order</h2>
      <p>
        Every email links to your order page, which shows each parcel and where it is. No account is
        needed — or find it any time with your order number and email on the{" "}
        <Link href="/orders/lookup" className="underline">
          track an order
        </Link>{" "}
        page.
      </p>
    </article>
  );
}
