import type { Metadata } from "next";
import Link from "next/link";

import { getCollections } from "@/lib/api-server";

export const metadata: Metadata = {
  title: "Collections",
  alternates: { canonical: "/collections" },
};

export default async function CollectionsPage() {
  const collections = await getCollections();
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">Collections</h1>
      {collections.length === 0 ? (
        <p className="text-text-secondary">No collections yet.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {collections.map((collection) => (
            <li key={collection.id}>
              <Link
                href={`/collections/${collection.slug}`}
                className="border-border-subtle bg-surface-raised hover:border-border-strong flex h-full flex-col gap-2 rounded-lg border p-6"
              >
                <h2 className="text-lg font-semibold">{collection.title}</h2>
                {collection.description && (
                  <p className="text-text-secondary line-clamp-3 text-sm">
                    {collection.description}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
