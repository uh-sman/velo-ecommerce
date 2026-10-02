/**
 * axe-core on every page the suite visits (PLANNING.md Phase 13): zero
 * violations of the WCAG 2.0/2.1 A and AA rules. A violation fails the test
 * with the rule, the impact, and the offending elements.
 *
 * The fixture also keeps the promise honest: every path a test's pages land
 * on must have been checked at least once before the test ends.
 */

import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;

function describe(violations: AxeResults["violations"]): string {
  return violations
    .map((violation) => {
      const nodes = violation.nodes
        .slice(0, 5)
        .map((node) => `    ${node.target.join(" ")}\n      ${node.failureSummary ?? ""}`)
        .join("\n");
      return `[${violation.impact ?? "?"}] ${violation.id}: ${violation.help}\n${nodes}`;
    })
    .join("\n\n");
}

function pathOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol.startsWith("http") ? `${parsed.host}${parsed.pathname}` : null;
  } catch {
    return null;
  }
}

export class A11yAudit {
  private readonly visited = new Set<string>();
  private readonly checked = new Set<string>();

  /** Record every main-frame navigation of `page`. */
  watch(page: Page): void {
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const path = pathOf(frame.url());
      if (path) this.visited.add(path);
    });
  }

  /** Run axe on the page as it is now; `state` names it in the failure message. */
  async check(page: Page, state: string): Promise<void> {
    // Let pending renders settle so axe sees the state the customer sees.
    await page.waitForLoadState("domcontentloaded");
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    const path = pathOf(page.url());
    if (path) this.checked.add(path);
    // E2E_A11Y_SOFT=1 reports every violation of a run instead of stopping at the first.
    const assert = process.env["E2E_A11Y_SOFT"] === "1" ? expect.soft : expect;
    assert(
      results.violations.map((violation) => violation.id),
      `axe found violations on ${page.url()} (${state}):\n\n${describe(results.violations)}`,
    ).toEqual([]);
  }

  /** Paths a page landed on that were never checked. */
  unchecked(): string[] {
    return [...this.visited].filter((path) => !this.checked.has(path));
  }
}
