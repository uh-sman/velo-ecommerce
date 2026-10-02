import { Skeleton } from "@/components/ui/skeleton";

/* Loading placeholders at the real dimensions, so nothing jumps on arrival. */

export function TilesSkeleton() {
  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5"
      aria-busy
      aria-label="Loading figures"
    >
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} className="h-[6.5rem] w-full rounded-lg" />
      ))}
    </div>
  );
}

export function ChartSkeleton({
  height = 200,
  label = "Loading chart",
}: {
  height?: number;
  label?: string;
}) {
  return <Skeleton className="w-full" style={{ height }} aria-busy aria-label={label} />;
}

export function ListSkeleton({ rows = 4, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div className="flex flex-col gap-2" aria-busy aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-9 w-full" />
      ))}
    </div>
  );
}
