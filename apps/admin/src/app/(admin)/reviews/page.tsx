import type { Metadata } from "next";

import { ReviewQueue } from "@/components/catalog/review-queue";
import { PageHeader } from "@/components/page";

export const metadata: Metadata = { title: "Reviews" };

export default function ReviewsPage() {
  return (
    <>
      <PageHeader
        title="Reviews"
        description="Approve reviews to show them in the store; rejected ones stay hidden."
      />
      <ReviewQueue />
    </>
  );
}
