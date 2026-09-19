
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Mobile guard for the desktop shell refresh.
 *
 * The refresh added a left navigation rail at >=1200px only. This spec pins the other
 * half of that contract, at the widths the supervisors actually use: below 1200px the
 * rail must not be visible, the top bar (with the hamburger) must still be the
 * navigation, there must be exactly one visible page heading, and the page must never
 * scroll sideways.
 *
 * It is deliberately small: apps/web/e2e/mobile-screens.spec.ts already proves the data
 * is reachable at these widths; this file proves the new shell did not leak into them.
 */

const PASSWORD = process.env.E2E_PASSWORD || process.env.DEV_SEED_PASSWORD || "WorkforceDev@2026";
const ADMIN = process.env.E2E_EMAIL || "admin@company.com";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
];

const ROUTES = ["/master-data", "/timesheet", "/summary", "/approvals", "/select-team", "/allocations"];

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("EC No or email").fill(ADMIN);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForLoadState("networkidle");
}

for (const viewport of VIEWPORTS) {
  test.describe(`mobile shell guard at ${viewport.name} (${viewport.width}px)`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const route of ROUTES) {
      test(`${route} keeps the top bar and hides the rail`, async ({ page }) => {
        await login(page);
        await page.goto(route);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(400);

        const state = await page.evaluate(() => {
          const visible = (selector: string) => {
            const el = document.querySelector(selector);
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && getComputedStyle(el).display !== "none";
          };
          const headings = Array.from(document.querySelectorAll("h1")).filter((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && getComputedStyle(el).display !== "none";
          });
          return {
            railVisible: visible(".app-rail"),
            railHandleVisible: visible(".app-rail-handle"),
            pageHeadVisible: visible(".page-head"),
            headerVisible: visible("header.app-header"),
            headingCount: headings.length,
            overflow: document.documentElement.scrollWidth - window.innerWidth,
          };
        });

        expect(state.railVisible, `${route}: the desktop rail must not be visible below 1200px`).toBe(false);
        expect(state.railHandleVisible, `${route}: the rail re-open handle must not be visible below 1200px`).toBe(false);
        expect(state.pageHeadVisible, `${route}: the desktop page head must not be visible below 1200px`).toBe(false);
        expect(state.headerVisible, `${route}: the top bar must stay the navigation below 1200px`).toBe(true);
        expect(state.headingCount, `${route}: exactly one visible page heading`).toBe(1);
        expect(state.overflow, `${route}: no horizontal page overflow`).toBeLessThanOrEqual(1);
      });
    }
  });
}
