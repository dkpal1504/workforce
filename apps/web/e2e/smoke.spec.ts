import { test, expect } from "@playwright/test";

test.describe("Workforce happy paths", () => {
  test("login → select team → timesheet → summary", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("r.sharma@company.com");
    await page.getByLabel("Password").fill("password123");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("heading", { name: "Select Team for Today" })).toBeVisible();
    await expect(page.getByText("Department Pool")).toBeVisible();
    await expect(page.getByText("Today's Team")).toBeVisible();
    await expect(page.getByLabel("Section")).toHaveValue("Hull Production");
    const departmentSelect = page.locator(".filter-field").filter({ hasText: "Department" }).locator("select");
    await expect(departmentSelect).toHaveValue(/.+/);
    await expect(departmentSelect).toBeDisabled();

    // Confirm team (may already be carried over)
    await page.getByRole("button", { name: /Confirm Team/i }).click();
    await expect(page.getByRole("heading", { name: "Daily Timesheet" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Filled:")).toBeVisible();

    // Select first empty hour on first row if present and assign
    const hourButtons = page.locator(".hour-cell").first();
    if (await hourButtons.count()) {
      await hourButtons.click();
      const projectSelect = page.locator(".project-select").first();
      await projectSelect.selectOption({ index: 1 });
      const assignBtn = page.locator(".assign-btn").first();
      if (await assignBtn.isEnabled()) {
        await assignBtn.click();
      }
      await page.getByRole("button", { name: "Save Draft" }).click();
      await expect(page.getByText("Draft saved.")).toBeVisible();
    }

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

    await page.goto("/login");
    await page.getByLabel("Email").fill("r.sharma@company.com");
    await page.getByLabel("Password").fill("password123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("link", { name: "My Hours" }).click();

    await expect(page).toHaveURL(/\/allocations$/);
    await expect(page.getByRole("main").getByRole("heading", { name: "My Hours" })).toBeVisible();
    await expect(page.getByLabel("Work slots")).toBeVisible();
    await expect(page.getByRole("button", { name: /AM 1/ })).toBeVisible();

    // Use a future date to avoid colliding with a submitted demo/test day.
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 60);
    await page.getByLabel("Allocation date").fill(date.toISOString().slice(0, 10));
    await page.getByLabel("Project").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Assign 2 Hours" }).click();
    await expect(page.getByText("AM 1 assigned.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove Slot" })).toBeVisible();

    await page.getByRole("button", { name: "Remove Slot" }).click();
    await expect(page.getByText("Slot removed.")).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
});
