import { expect, test } from "@playwright/test";

test("dev sign-out clears session and cached data", async ({ page }) => {
  await page.goto("http://localhost:5173/login");
  await page.getByLabel(/handle/i).fill("repro-user-a");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText("repro-user-a")).toBeVisible();

  await page.getByRole("button", { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel(/handle/i).fill("repro-user-b");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText("repro-user-b")).toBeVisible();
  await expect(page.getByText("repro-user-a")).toHaveCount(0);
});
