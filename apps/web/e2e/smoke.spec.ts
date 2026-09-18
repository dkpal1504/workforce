import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/**
 * The seeded accounts share one password. It used to be written here as a literal
 * ("password@SDHI"), which went stale when the seed's default changed and broke these
 * tests. Read it from the environment instead, with the same fallback the seed uses
 * (`DEV_SEED_PASSWORD`, default "WorkforceDev@2026"; the seed prints it when it runs).
 */
const PASSWORD = process.env.E2E_PASSWORD || process.env.DEV_SEED_PASSWORD || "WorkforceDev@2026";

/**
 * The booking picker is Department (fixed to the supervisor's own) -> Section ->
 * Project -> Job Order, and a Job Order option is labelled
 * `Job_Order-Job_Description`. This one is seeded in Project A / Hull Production
 * (seed.ts), so both tests book against a real, named Job Order.
 */
const JOB_ORDER_LABEL = "1900000107-Pipe Spool Installation";

async function login(page: Page, id: string) {
  await page.goto("/login");
  await page.getByLabel("EC No or email").fill(id);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/**
 * Pick the option of a <select> whose visible text contains `needle`. The Section
 * selects are keyed by Section id (the option text is "<code> · <name>"), so no
 * Section id may be hard-coded in this file.
 */
async function pickOptionContaining(select: Locator, needle: string) {
  const option = select.locator("option", { hasText: needle });
  await expect(option, `an option containing "${needle}" must be offered`).toHaveCount(1);
  const value = await option.evaluate((element) => (element as HTMLOptionElement).value);
  await select.selectOption(value);
}

test.describe("Workforce happy paths", () => {
  test("login → select team → timesheet → summary", async ({ page }) => {
    await login(page, "EC1001");

    await expect(page.getByRole("heading", { name: "Select Team for Today" })).toBeVisible();
    await expect(page.getByText("Department Pool")).toBeVisible();
    await expect(page.getByText("Today's Team")).toBeVisible();
    // The Section select is keyed by Section id now, and its options read
    // "<code> · <name>", so the name is asserted through the selected option.
    const teamSection = page.getByLabel("Section");
    await expect(teamSection).toHaveValue(/^\d+$/);
    await expect(teamSection.locator("option:checked")).toContainText("Hull Production");
    const departmentSelect = page.locator(".filter-field").filter({ hasText: "Department" }).locator("select");
    await expect(departmentSelect).toHaveValue(/^.+$/);
    await expect(departmentSelect).toBeDisabled();

    // Confirm team (may already be carried over)
    await page.getByRole("button", { name: /Confirm Team/i }).click();
    await expect(page.getByRole("heading", { name: "Daily Timesheet" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Filled:")).toBeVisible();

    const addEmployeeSearch = page.locator(".add-emp-input:visible");
    await addEmployeeSearch.fill("Emp 6");
    const addEmployeeResults = page.locator(".add-dropdown__list:visible");
    await expect(addEmployeeResults).toBeVisible();
    const [searchBox, resultsBox] = await Promise.all([
      addEmployeeSearch.boundingBox(),
      addEmployeeResults.boundingBox(),
    ]);
    expect(searchBox).not.toBeNull();
    expect(resultsBox).not.toBeNull();
    expect(resultsBox!.y + resultsBox!.height).toBeLessThanOrEqual(searchBox!.y + 1);
    await addEmployeeSearch.fill("");

    // Book a slot on the first row that is still editable (a submitted/approved day
    // renders as a locked row with disabled cells), using the real picker:
    // select a bookable slot, then Section -> Project -> Job Order.
    await expect(page.locator("tr.row-summary").first()).toBeVisible();
    // A slot can be locked because the day was submitted, or because another
    // supervisor already booked that cell, so scan the editable rows for the first
    // cell this supervisor may actually use. Rows already over the daily limit are
    // only used as a fallback, so the booked day stays a plain draft.
    const firstBookableRow = async (scope: Locator) => {
      for (let i = 0; i < (await scope.count()); i += 1) {
        if ((await scope.nth(i).locator(".slot-td .slot-cell:enabled").count()) > 0) return scope.nth(i);
      }
      return undefined;
    };
    const bookable =
      (await firstBookableRow(page.locator("tr.row-summary:not(.row-locked):not(.row-over-limit)"))) ??
      (await firstBookableRow(page.locator("tr.row-summary:not(.row-locked)")));
    expect(bookable, "an editable row with a bookable slot must be on the timesheet").toBeDefined();
    const row = bookable as Locator;
    const slot = row.locator(".slot-td .slot-cell:enabled").first();
    await expect(slot).toBeEnabled();
    await slot.click();
    // The slot is booked once it reads "selected" (the click toggles a row-local set).
    await expect(slot).toHaveClass(/selected/);

    await pickOptionContaining(row.locator("select.project-select").first(), "Hull Production");
    await pickOptionContaining(row.locator("select.project-select").nth(1), "Project A");

    // Job Orders are fetched per (section, project) pair, so the select fills in
    // asynchronously and stays disabled until both are chosen.
    const jobOrderSelect = row.locator("select.jo-select");
    await expect(jobOrderSelect).toBeEnabled();
    await expect(jobOrderSelect.locator("option", { hasText: JOB_ORDER_LABEL })).toHaveCount(1);
    await jobOrderSelect.selectOption({ label: JOB_ORDER_LABEL });

    const assignButton = row.locator(".assign-btn");
    await expect(assignButton).toBeEnabled();
    await assignButton.click();
    await expect(page.getByText(/1 regular slot\(s\) for /)).toBeVisible();

    // Save Draft leaves the day editable, which keeps this test repeatable.
    await page.getByRole("button", { name: "Save Draft" }).click();
    await expect(page.getByText("Draft saved.")).toBeVisible();

    await page.getByRole("link", { name: "Summary" }).click();
    await expect(page.getByText("Summary").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Hours View" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Group by Supervisor" })).toBeVisible();
  });
});

test.describe("Supervisor My Hours", () => {
  test("loads the slot page and can assign then remove a slot", async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    await login(page, "ec1001");
    await page.getByRole("link", { name: "My Hours" }).click();

    await expect(page).toHaveURL(/\/allocations$/);
    await expect(page.getByRole("heading", { name: "My Hours" })).toBeVisible();
    await expect(page.getByLabel("My hours timesheet")).toBeVisible();

    // Same picker on the slot page: the Department is fixed to the supervisor's own,
    // while Section -> Project -> Job Order are chosen.
    await expect(page.getByLabel("Department")).not.toHaveValue("");
    const sectionSelect = page.getByLabel("Section");
    const projectSelect = page.getByLabel("Project");
    const jobOrderSelect = page.getByLabel("Job Order");
    await expect(sectionSelect).toBeVisible();
    await expect(projectSelect).toBeVisible();
    await expect(jobOrderSelect).toBeDisabled();

    // Use a future date to avoid colliding with a submitted demo/test day.
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 60);
    await page.getByLabel("Allocation date").fill(date.toISOString().slice(0, 10));

    // Wait for both asynchronous loads before touching the sheet. Reloading a day
    // that is already stored re-seeds the slot selection, so a click that lands
    // while the day list is still in flight is silently lost.
    await expect(sectionSelect.locator("option", { hasText: "Hull Production" })).toHaveCount(1);
    await expect(page.locator(".loading-state")).toHaveCount(0);

    await pickOptionContaining(sectionSelect, "Hull Production");
    await pickOptionContaining(projectSelect, "Project A");
    await expect(jobOrderSelect).toBeEnabled();
    await jobOrderSelect.selectOption({ label: JOB_ORDER_LABEL });

    await page.getByRole("button", { name: /9:00.*11:00: empty/ }).click();
    await expect(page.getByRole("button", { name: /9:00.*11:00: selected/ })).toBeVisible();

    await page.getByRole("button", { name: "Assign to Selected (1)" }).click();
    await expect(page.getByText("1 slot saved.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Clear 9:00.*11:00 draft slot/ })).toBeVisible();

    await page.getByRole("button", { name: /Clear 9:00.*11:00 draft slot/ }).click();
    await expect(page.getByText("AM 1 cleared.")).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
});
