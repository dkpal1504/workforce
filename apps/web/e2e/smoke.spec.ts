import { test, expect } from "@playwright/test";

test.describe("Workforce happy paths", () => {
  test("login → select team → timesheet → summary", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("r.sharma@company.com");
    await page.getByLabel("Password").fill("password123");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByText("Select Team for Today.")).toBeVisible();
    await expect(page.getByText("Department Pool")).toBeVisible();
    await expect(page.getByText("Today's Team")).toBeVisible();

    // Confirm team (may already be carried over)
    await page.getByRole("button", { name: /Confirm Team/i }).click();
    await expect(page.getByText("Daily Timesheet — Entry Screen")).toBeVisible({ timeout: 15000 });
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
