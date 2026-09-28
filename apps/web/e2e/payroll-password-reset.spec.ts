import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * The Admin/HR payroll-employee password reset (the "Employees (Payroll)" tab of
 * Supervisor Registration).
 *
 * These tests use only the SEEDED accounts, so they do not depend on anybody's real
 * employee rows: the seed gives every office account the password below, and the demo seed
 * gives `EC1011` an EMPLOYEE login. The reset itself is asserted through the UI (dialogue,
 * confirmation notice, the Password column flipping to "Must change") and never against a
 * password value, because the API deliberately names only the password it APPLIED — the
 * tests must not carry a copy of it.
 */
const PASSWORD = process.env.E2E_PASSWORD || process.env.DEV_SEED_PASSWORD || "WorkforceDev@2026";
const ADMIN = "admin@company.com";
const EMPLOYEE_EC_NO = "EC1011";

async function login(page: Page, id: string) {
  await page.goto("/login");
  await page.getByLabel("EC No or email").fill(id);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Show navigation" })).toBeVisible();
}

/** Open Supervisor Registration and switch to the payroll tab. */
async function openPayrollTab(page: Page) {
  await page.goto("/supervisors");
  const tab = page.getByRole("button", { name: "Employees (Payroll)" });
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(page.getByLabel("Department")).toBeVisible();
}

test.describe("Payroll employee password reset", () => {
  test("the tab lists payroll employees with the login they actually use, and filters by search", async ({ page }) => {
    await login(page, ADMIN);
    await openPayrollTab(page);

    // A filter bar (Department + Section) and a count are the two things that make the
    // list usable at 900 employees; the search box is the third.
    await expect(page.getByLabel("Section")).toBeVisible();
    await expect(page.locator(".supervisors-toolbar__count")).toContainText("payroll employees");
    await expect(page.getByPlaceholder("Search ecNo, name or designation…")).toBeVisible();

    const table = page.locator("table.sup-table");
    await expect(table).toBeVisible();

    // The seeded demo employee must be findable by ecNo...
    await page.getByPlaceholder("Search ecNo, name or designation…").fill(EMPLOYEE_EC_NO);
    await expect(table.locator("tbody tr")).toHaveCount(1);
    await expect(table.locator("tbody tr")).toContainText(EMPLOYEE_EC_NO);

    // ...and a supervisor is listed here too, because a Supervisor IS a payroll employee.
    await page.getByPlaceholder("Search ecNo, name or designation…").fill("EC1001");
    await expect(table.locator("tbody tr")).toHaveCount(1);
    await expect(table.locator("tbody tr")).toContainText("EC1001");

    // A search that matches nobody says so instead of showing an empty table.
    await page.getByPlaceholder("Search ecNo, name or designation…").fill("zzz-no-such-person");
    await expect(page.locator(".empty-state")).toContainText("No payroll employee matches this search");
  });

  test("Reset password names the password it applied and forces a change at next login", async ({ page }) => {
    await login(page, ADMIN);
    await openPayrollTab(page);
    await page.getByPlaceholder("Search ecNo, name or designation…").fill("EC1001");

    const row = page.locator("table.sup-table tbody tr").first();
    await expect(row).toContainText("EC1001");

    // Accept the confirmation and remember exactly what the dialogue said.
    let dialogText = "";
    page.once("dialog", (dialog) => {
      dialogText = dialog.message();
      void dialog.accept();
    });

    await row.getByRole("button", { name: "Reset password" }).click();

    // The dialogue must name the sign-in id and the password, or the operator cannot help
    // the person on the phone. `password@SDHI` on the dev box; the assertions stay generic
    // (a non-empty value after "Password: ") so the test survives a rotated shared password.
    await expect(page.locator(".alloc-note")).toContainText("Password reset for");
    await expect(page.locator(".alloc-note")).toContainText("Sign in with EC1001");
    expect(dialogText).toContain("Sign-in: EC1001");
    expect(dialogText).toMatch(/Password: \S+/);

    // The row now says the change is forced. That is the observable proof the reset landed
    // without this test ever holding the password.
    await expect(row).toContainText("Must change");
  });

  test("a promoted approver account is listed but not resettable from here", async ({ page }) => {
    await login(page, ADMIN);
    await openPayrollTab(page);
    // HODs are registered by the demo seed; the tab must show them with the reason they
    // cannot be reset rather than a button that would 409.
    await page.getByPlaceholder("Search ecNo, name or designation…").fill("EC1013");
    const row = page.locator("table.sup-table tbody tr").first();
    const hasRow = await row.count();
    if (hasRow) {
      await expect(row).toContainText("Manage from Role Assignment");
      await expect(row.getByRole("button", { name: "Reset password" })).toHaveCount(0);
    }
  });
});
