/**
 * `Idempotency-Key` for money-moving POSTs (API-SPEC.md §1 "Idempotency").
 *
 * One key per *attempt*, not per click: a retry after a timeout must reuse the
 * key, or a request that did reach the server runs twice. The key is dropped
 * only once the server has given a definitive answer — success, or an error
 * that is not about the network or a request still in flight.
 */

import type { Outcome } from "@/lib/api-browser";

export class AttemptKey {
  private key: string | null = null;

  /** The current attempt's key, minted on first use. */
  get current(): string {
    this.key ??= crypto.randomUUID();
    return this.key;
  }

  /** Keep the key for a retry only when the outcome was not definitive. */
  settle(outcome: Outcome<unknown>): void {
    if (outcome.ok) {
      this.key = null;
      return;
    }
    const { status } = outcome.problem;
    // 0: never reached us. 409 request-in-progress / 5xx: may still complete.
    const retryable = status === 0 || status >= 500 || status === 409;
    if (!retryable) this.key = null;
  }
}
