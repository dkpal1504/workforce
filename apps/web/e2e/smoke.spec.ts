import { test, expect } from "@playwright/test";

test.describe("Workforce happy paths", () => {
  test("login → select team → timesheet → summary", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("EC No or email").fill("EC1001");
    await page.getByLabel("Password").fill("password@SDHI");
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
    await page.getByLabel("EC No or email").fill("ec1001");
    await page.getByLabel("Password").fill("password@SDHI");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("link", { name: "My Hours" }).click();

    await expect(page).toHaveURL(/\/allocations$/);
    await expect(page.getByRole("heading", { name: "My Hours" })).toBeVisible();
    await expect(page.getByLabel("My hours timesheet")).toBeVisible();
    await expect(page.getByLabel("Section")).toBeVisible();

    // Use a future date to avoid colliding with a submitted demo/test day.
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 60);
    await page.getByLabel("Allocation date").fill(date.toISOString().slice(0, 10));
    await page.getByRole("button", { name: /9:00.*11:00: empty/ }).click();
    await page.locator(".alloc-bulk__field select").first().selectOption({ index: 1 });
    await page.getByRole("button", { name: "Assign to Selected (1)" }).click();
    await expect(page.getByText("1 slot saved.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Clear 9:00.*11:00 draft slot/ })).toBeVisible();

    await page.getByRole("button", { name: /Clear 9:00.*11:00 draft slot/ }).click();
    await expect(page.getByText("AM 1 cleared.")).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
});
