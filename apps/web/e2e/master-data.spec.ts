import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/** Same source as the seed: E2E_PASSWORD, else DEV_SEED_PASSWORD, else the seed default. */
const PASSWORD = process.env.E2E_PASSWORD || process.env.DEV_SEED_PASSWORD || "WorkforceDev@2026";

/**
 * Master data is maintained only through this screen, so these are the paths a PM or
 * Admin actually depends on:
 *
 *   1. create a WBS row and a Network inside a project,
 *   2. correct an existing Job Order's WBS and Network (the CSV import creates a Job
 *      Order and then skips it, so this is the only way to fix a wrong one),
 *   3. refuse a WBS change once hours are booked.
 *
 * The test cleans up after itself: it restores the Job Order it touched and deactivates
 * the two rows it created, so the development database is left as it was found.
 */

async function login(page: Page, id = "admin@company.com") {
  await page.goto("/login");
  await page.getByLabel("EC No or email").fill(id);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForLoadState("networkidle");
}

/** Pick a <select> option whose visible text contains `needle`. */
async function pickByText(page: Page, label: string, needle: string) {
  const value = await page.getByLabel(label).locator("option").evaluateAll((options, text) => {
    const hit = options.find((option) => (option as HTMLOptionElement).textContent?.includes(text as string));
    return hit ? (hit as HTMLOptionElement).value : null;
  }, needle);
  expect(value, `an option containing "${needle}" must exist in ${label}`).not.toBeNull();
  await page.getByLabel(label).selectOption(value as string);
}

test("a Project Head can create a WBS and a Network, and correct a Job Order", async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = String(Date.now()).slice(-6);
  const wbsCode = `A.E2E.${stamp}.001`;
  const networkCode = `NW-E2E-${stamp}`;

  await login(page);
  await page.goto("/master-data");
  await expect(page.getByRole("tab", { name: "Project", exact: true })).toBeVisible();

  // 1. Create a WBS row in the first project of the selector.
  await page.getByRole("tab", { name: "WBS", exact: true }).click();
  await page.getByRole("button", { name: /Add WBS/i }).click();
  await page.getByLabel("WBS number").fill(wbsCode);
  await page.getByLabel("WBS name").fill("Created by the e2e test");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("cell", { name: wbsCode })).toBeVisible();

  // 2. Create a Network in the same project.
  await page.getByRole("tab", { name: "Network", exact: true }).click();
  await page.getByRole("button", { name: /Add Network/i }).click();
  await page.getByLabel("Network code").fill(networkCode);
  await page.getByLabel("Network name").fill("Created by the e2e test");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("cell", { name: networkCode })).toBeVisible();

  // 3. The Job Order tab offers only that project's rows and Networks in the mapping form.
  await page.getByRole("tab", { name: "Job Order", exact: true }).click();
  await expect(page.getByRole("cell", { name: networkCode }).or(page.getByText("Job Orders are created by CSV upload"))).toBeVisible();

  // Pick a Job Order with no booked hours, so the WBS may move.
  const targetRow = page.locator("table tbody tr").filter({ hasText: "None" }).first();
  const targetCode = (await targetRow.locator("td").first().innerText()).split("\n")[0].trim();
  const originalWbs = (await targetRow.locator("td").nth(2).innerText()).trim();
  const originalNetwork = (await targetRow.locator("td").nth(3).innerText()).trim();

  await targetRow.getByRole("button", { name: /Edit WBS/i }).click();
  await pickByText(page, "WBS number", wbsCode);
  await pickByText(page, "Network", networkCode);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("table tbody tr").filter({ hasText: targetCode }).first()).toContainText(wbsCode);

  // 4. Put it back and deactivate the two rows this test created.
  const movedRow = page.locator("table tbody tr").filter({ hasText: targetCode }).first();
  await movedRow.getByRole("button", { name: /Edit WBS/i }).click();
  await pickByText(page, "WBS number", originalWbs);
  await pickByText(page, "Network", originalNetwork);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("table tbody tr").filter({ hasText: targetCode }).first()).toContainText(originalWbs);

  // Deactivating asks for confirmation through a native dialog, which Playwright
  // dismisses unless the test accepts it.
  page.on("dialog", (dialog) => void dialog.accept());
  for (const [tab, code] of [["WBS", wbsCode], ["Network", networkCode]] as Array<[string, string]>) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    const row = page.locator("table tbody tr").filter({ hasText: code }).first();
    await row.getByRole("button", { name: /Deactivate/i }).click();
    await expect(row).toContainText("Inactive");
  }
});

test("a WBS cannot change once the Job Order has booked hours", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.goto("/master-data");
  await page.getByRole("tab", { name: "Job Order", exact: true }).click();

  const bookedRow = page.locator("table tbody tr").filter({ hasNotText: "None" }).first();
  if (!(await bookedRow.count())) test.skip(true, "no Job Order with booked hours in this database");

  await bookedRow.getByRole("button", { name: /Edit WBS/i }).click();
  const current = await page.getByLabel("WBS number").inputValue();
  const other = await page.getByLabel("WBS number").locator("option").evaluateAll((options, value) => {
    const hit = options.find((option) => (option as HTMLOptionElement).value !== value);
    return hit ? (hit as HTMLOptionElement).value : null;
  }, current);
  if (!other) test.skip(true, "this Job Order has only one WBS row to choose from");

  await page.getByLabel("WBS number").selectOption(other as string);
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute("title", /booked hours/i);
  await page.getByRole("button", { name: "Cancel" }).click();
});
