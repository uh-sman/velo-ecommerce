import type { Metadata } from "next";

export const metadata: Metadata = { title: "Returns" };

export default function ReturnsHelp() {
  return (
    <article className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-12 leading-relaxed">
      <h1 className="text-3xl font-semibold tracking-tight">Returns</h1>
      <p>You have 30 days from delivery to return anything you bought, for any reason.</p>
      <ol className="flex list-decimal flex-col gap-2 pl-6">
        <li>Open your order — from its email, your account, or the track-an-order page.</li>
        <li>Choose “Request a return”, the items and quantities, and a reason.</li>
        <li>
          Once we approve it (usually within a day) you can print a return label with your RMA
          number. Pack the items with it and send the parcel.
        </li>
        <li>
          When it arrives we check it and refund the items to your original payment method. Refunds
          take 5–10 business days to appear, depending on your bank.
        </li>
      </ol>
      <h2 className="mt-4 text-xl font-semibold">Before it ships</h2>
      <p>
        Changed your mind before we have shipped it? Cancel the order from its page and everything
        you paid is refunded at once.
      </p>
    </article>
  );
}
