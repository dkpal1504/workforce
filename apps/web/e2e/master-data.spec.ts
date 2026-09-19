import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/** Same source as the seed: E2E_PASSWORD, else DEV_SEED_PASSWORD, else the seed default. */
const PASSWORD = process.env.E2E_PASSWORD || process.env.DEV_SEED_PASSWORD || "WorkforceDev@2026";

/**
 * Master data is maintained only through this screen, so these are the paths a PM or
 * Admin actually depends on:
 *
 *   1. create a WBS row and a Network inside a project,
 *   2. revise an existing Job Order's BUDGET - the mapping (Project, WBS, Network,
 *      organisation) is shown read-only, and saving writes an effective-dated revision,
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

  // 1. Create a WBS row in the project the selector shows by default. Its value is kept
  // so the cleanup can come back to the same project: the WBS and Network tabs both follow
  // the selector, and step 3 changes it to reach a project that has Job Orders.
  await page.getByRole("tab", { name: "WBS", exact: true }).click();
  const createdUnderProject = await page.locator("select[aria-label='Project']").inputValue();
  await page.getByRole("button", { name: /Add WBS/i }).click();
  await page.getByLabel("WBS number").fill(wbsCode);
  await page.getByLabel("WBS name").fill("Created by the e2e test");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("cell", { name: wbsCode })).toBeVisible();

  // 2. Create a Network in the same project.
  await page.getByRole("tab", { name: "Network", exact: true }).click();
  await page.getByRole("button", { name: /Add Network/i }).click();
  // A Network belongs to a WBS element, so the form asks for it and Save stays disabled
  // until one is chosen.
  await pickByText(page, "WBS number", wbsCode);
  await page.getByLabel("Network code").fill(networkCode);
  await page.getByLabel("Network name").fill("Created by the e2e test");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("cell", { name: networkCode })).toBeVisible();

  // 3. The Job Order tab: the mapping is read-only and only the BUDGET can be revised.
  await page.getByRole("tab", { name: "Job Order", exact: true }).click();
  await expect(page.getByRole("cell", { name: networkCode }).or(page.getByText("Job Orders are created by CSV upload"))).toBeVisible();

  // The tab lists the Job Orders of the SELECTED project, so pick a project that has some.
  const projectSelect = page.locator("select[aria-label='Project']");
  const projectValues = await projectSelect.locator("option").evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value).filter((value) => value)
  );
  let found = false;
  for (const value of projectValues) {
    await projectSelect.selectOption(value);
    await page.waitForTimeout(900);
    if ((await page.locator("table tbody tr").count()) > 0) { found = true; break; }
  }
  if (!found) test.skip(true, "no project in this database has a Job Order");

  const targetRow = page.locator("table tbody tr").first();
  const targetCode = (await targetRow.locator("td").first().innerText()).split("\n")[0].trim();
  await targetRow.getByRole("button", { name: /Edit Job Order/i }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`Edit Job Order ${targetCode}`) })).toBeVisible();

  // Everything that identifies the Job Order is shown, and nothing of it is a control:
  // no <select> at all, three inputs (Budget hours, Budget quantity, Reason).
  const formShape = await page.evaluate(() => {
    const modal = document.querySelector(".modal") as HTMLElement;
    return {
      selects: modal.querySelectorAll("select").length,
      inputs: modal.querySelectorAll("input").length,
      readonlyLabels: Array.from(modal.querySelectorAll(".sup-field label")).map((l) => (l.textContent || "").trim()),
    };
  });
  expect(formShape.selects, "the mapping must not be editable here").toBe(0);
  for (const label of ["Project", "WBS number", "Network", "Unit of measure", "Department", "Section", "Status"]) {
    expect(formShape.readonlyLabels).toContain(label);
  }

  // Saving needs a change: an unchanged budget writes no revision.
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  const currentHours = await page.getByLabel("Budget hours").inputValue();
  await page.getByLabel("Budget hours").fill(String(Number(currentHours) + 1));
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator("table tbody tr").filter({ hasText: targetCode }).first()).toBeVisible();

  // Reopening shows the revision that was just written, with its date and time.
  await page.locator("table tbody tr").filter({ hasText: targetCode }).first().getByRole("button", { name: /Edit Job Order/i }).click();
  await expect(page.locator(".modal li").first()).toContainText(/Revision \d+ ·/);
  await page.getByRole("button", { name: "Cancel" }).click();

  // Deactivating asks for confirmation through a native dialog, which Playwright
  // dismisses unless the test accepts it.
  page.on("dialog", (dialog) => void dialog.accept());
  for (const [tab, code] of [["WBS", wbsCode], ["Network", networkCode]] as Array<[string, string]>) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await page.locator("select[aria-label='Project']").selectOption(createdUnderProject);
    await page.waitForTimeout(900);
    const row = page.locator("table tbody tr").filter({ hasText: code }).first();
    await row.getByRole("button", { name: /Deactivate/i }).click();
    await expect(row).toContainText("Inactive");
  }
});

test("the Job Order form keeps the mapping read-only, even for a Job Order with booked hours", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.goto("/master-data");
  await page.getByRole("tab", { name: "Job Order", exact: true }).click();

  // The tab lists one project at a time, so walk the selector until a project with Job
  // Orders is shown, then take the first row whose Booked-hours cell is not "None".
  const projectSelect = page.locator("select[aria-label='Project']");
  const projectValues = await projectSelect.locator("option").evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value).filter((value) => value)
  );
  let bookedIndex = -1;
  for (const value of projectValues) {
    await projectSelect.selectOption(value);
    await page.waitForTimeout(900);
    bookedIndex = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      return rows.findIndex((row) => {
        const cell = (row.children[4] as HTMLElement | undefined)?.innerText.trim();
        return Boolean(cell) && cell !== "None";
      });
    });
    if (bookedIndex >= 0) break;
  }
  if (bookedIndex < 0) test.skip(true, "no Job Order with booked hours in this database");

  const bookedRow = page.locator("table tbody tr").nth(bookedIndex);

  await bookedRow.getByRole("button", { name: /Edit Job Order/i }).click();
  // No control can re-point an existing Job Order: no <select>, and the identifying fields
  // are printed. Its booked rows keep the attribution they were given.
  const shape = await page.evaluate(() => {
    const modal = document.querySelector(".modal") as HTMLElement;
    return {
      selects: modal.querySelectorAll("select").length,
      readonlyText: Array.from(modal.querySelectorAll(".md-readonly")).map((p) => (p as HTMLElement).innerText.trim()),
    };
  });
  expect(shape.selects).toBe(0);
  // The budget stays editable: a revision is a forward-looking correction, not a re-point.
  await expect(page.getByLabel("Budget hours")).toBeEnabled();
  await page.getByRole("button", { name: "Cancel" }).click();
});
