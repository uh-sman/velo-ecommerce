import { formatMoney, type Schema } from "@velo/api-client";
import Link from "next/link";

import { Table, th, td } from "@/components/page";

import { formatCount } from "./format";
import { SERIES } from "./series";

/*
 * Best sellers by revenue. The figures are the table; a thin bar under each
 * title shows its revenue against the top seller — one colour for every row,
 * since products have no order of their own.
 */
export function TopProducts({
  products,
  currency,
}: {
  products: Schema<"TopProductView">[];
  currency: string;
}) {
  const top = Math.max(0, ...products.map((product) => product.revenue));
  return (
    <Table label="Top products by revenue">
      <thead>
        <tr>
          <th scope="col" className={`${th} w-10`}>
            #
          </th>
          <th scope="col" className={th}>
            Product
          </th>
          <th scope="col" className={`${th} text-right`}>
            Units
          </th>
          <th scope="col" className={`${th} text-right`}>
            Revenue
          </th>
        </tr>
      </thead>
      <tbody>
        {products.map((product, index) => (
          <tr key={product.product_id ?? product.title}>
            <td className={`${td} text-text-tertiary tabular-nums`}>{index + 1}</td>
            <td className={td}>
              {product.product_id ? (
                <Link
                  href={`/products/${product.product_id}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {product.title}
                </Link>
              ) : (
                <span className="font-medium">
                  {product.title} <span className="text-text-tertiary font-normal">(deleted)</span>
                </span>
              )}
              <div aria-hidden className="mt-1.5 h-1 w-full max-w-60">
                <div
                  className="h-full rounded-r-[4px]"
                  style={{
                    width: `${String(top > 0 ? Math.max(1, (product.revenue / top) * 100) : 0)}%`,
                    background: SERIES,
                  }}
                />
              </div>
            </td>
            <td className={`${td} text-right tabular-nums`}>{formatCount(product.units)}</td>
            <td className={`${td} text-right tabular-nums`}>
              {formatMoney({ amount: product.revenue, currency })}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
