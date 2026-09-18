import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/** Same source as the seed: E2E_PASSWORD, else DEV_SEED_PASSWORD, else the seed default. */
const PASSWORD = process.env.E2E_PASSWORD || process.env.DEV_SEED_PASSWORD || "WorkforceDev@2026";

/**
 * The new master-data screens must be usable on a phone and a tablet.
 *
 * This guards a real regression: every list screen renders `<table class="sup-table">`,
 * and that class was `display: none` below 1024px on the assumption that a page would
 * render `.sup-card` rows instead. No page did, so the lists were invisible on a narrow
 * screen and the data was unreachable. The table now stays visible and scrolls inside
 * its own box, and the screens that DO have a card layout hide their table explicitly.
 *
 * The assertion is "the data is reachable", not "the table exists": a visible table row
 * or a visible card both count, because a card layout is the better answer on a phone.
 */

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
];

const SCREENS: Array<[string, string, string]> = [
  ["Project Master Data", "admin@company.com", "/master-data"],
  ["Job Order Upload", "admin@company.com", "/job-order-upload"],
  ["Quantity Progress", "hod@company.com", "/job-order-progress"],
  ["Summary", "admin@company.com", "/summary"],
];

async function login(page: Page, id: string) {
  await page.goto("/login");
  await page.getByLabel("EC No or email").fill(id);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForLoadState("networkidle");
}

for (const viewport of VIEWPORTS) {
  test.describe(`mobile layout at ${viewport.name} (${viewport.width}px)`, () => {
    for (const [label, loginId, path] of SCREENS) {
      test(`${label} stays usable`, async ({ browser }) => {
        const mobile = viewport.width < 500;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          isMobile: mobile,
          hasTouch: mobile,
        });
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(String(error)));

        await login(page, loginId);
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(600);

        // 1. The page itself never scrolls sideways: any wide content scrolls in its own box.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${label} must not overflow the viewport horizontally`).toBeLessThanOrEqual(1);

        // 2. The data must actually be reachable: a visible row, a visible card, or a
        //    genuine empty/loading state.
        const reachable = await page.evaluate(() => {
          const anyVisible = (selector: string) =>
            Array.from(document.querySelectorAll(selector)).some((element) => {
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });
          return (
            anyVisible("table tbody tr") ||
            anyVisible(".jop-card") ||
            anyVisible(".summary-card") ||
            anyVisible(".empty-state") ||
            anyVisible(".loading-state")
          );
        });
        expect(reachable, `${label} must show rows, cards, or an empty state`).toBe(true);

        // 3. No uncaught error while rendering on a narrow viewport.
        expect(pageErrors, `${label} must not raise a page error`).toEqual([]);

        await context.close();
      });
    }
  });
}
