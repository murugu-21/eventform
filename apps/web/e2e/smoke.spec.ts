/**
 * Full-stack smoke test.
 *
 * Prerequisites (must be running before executing this test):
 *   - docker compose up -d --wait  (postgres + localstack + kafka + connect)
 *   - pnpm connect:register        (Debezium outbox connector RUNNING)
 *   - PORT=3001 node apps/api/dist/main.js
 *   - node apps/worker/dist/main.js
 *   - The Vite dev server is started automatically by playwright.config.ts webServer.
 *
 * Selector notes:
 *   - Login page: Label "Handle" → getByLabel(/handle/i)
 *   - Dashboard: Button "New form" → getByRole("button", { name: /new form/i })
 *   - New form dialog title input: id="new-form-title" → getByLabel(/title/i)
 *   - New form dialog create button: "Create" → getByRole("button", { name: /create/i })
 *   - Form builder: "Add field" button → getByRole("button", { name: /add field/i })
 *   - Field label input in last row: aria-label="label" → getByLabel(/label/i).last()
 *   - Save fields: "Save fields" → getByRole("button", { name: /save fields/i })
 *   - Publish: "Publish" → getByRole("button", { name: /^publish/i })
 *   - Publish confirm dialog button: "Publish" → getByRole("button", { name: /^publish$/i }).last()
 *   - Public link: data-testid="public-link"
 *   - New endpoint button: "New endpoint" → getByRole("button", { name: /new endpoint/i })
 *   - Secret dialog: shows whsec_ value; data-testid="secret-value"
 *   - Secret close button: data-testid="secret-close" (requires checkbox first)
 *   - Public form field: getByLabel("Name")
 *   - Submit button: getByRole("button", { name: /submit/i })
 *   - Thank you: "Response recorded" text
 *   - Deliveries: green "delivered" badge in StatusBadge component
 */

import { expect, test } from "@playwright/test";

const sub = `smoke-${Date.now()}`;

test("full loop: sign in → build → publish → submit → delivery delivered", async ({ page }) => {
  // A minimal HTTP echo server on :9099 started by the test harness (see smoke
  // prerequisites in the file header). Accepts any POST and returns 200.
  // (POST /health returns 404; the worker POSTs webhook events.)
  const sinkUrl = "http://127.0.0.1:9099/webhook";

  // ── 1. Sign in ──────────────────────────────────────────────────────────────
  await page.goto("/login");
  await page.getByLabel(/handle/i).fill(sub);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/app$/, { timeout: 10_000 });

  // ── 2. Create a new form ────────────────────────────────────────────────────
  await page.getByRole("button", { name: /new form/i }).click();
  // Wait for dialog
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel(/title/i).fill("Smoke Form");
  await page.getByRole("button", { name: /^create$/i }).click();
  // Should navigate to form builder
  await expect(page).toHaveURL(/\/app\/forms\//, { timeout: 10_000 });

  // ── 3. Add a field ──────────────────────────────────────────────────────────
  await page.getByRole("button", { name: /add field/i }).click();
  // The last field label input has aria-label="label"
  await page.getByLabel(/label/i).last().fill("Name");

  // ── 4. Save fields ──────────────────────────────────────────────────────────
  await page.getByRole("button", { name: /save fields/i }).click();
  // Wait for save to complete (button becomes disabled again = not dirty)
  await expect(page.getByRole("button", { name: /save fields/i })).toBeDisabled({ timeout: 10_000 });

  // ── 5. Publish ───────────────────────────────────────────────────────────────
  await page.getByRole("button", { name: /^publish$/i }).click();
  // Confirm dialog appears
  await expect(page.getByRole("dialog")).toBeVisible();
  // Click the "Publish" button inside the confirm dialog (last one)
  await page.getByRole("button", { name: /^publish$/i }).last().click();
  // Wait for public link to appear (data-testid="public-link")
  await expect(page.getByTestId("public-link")).toBeVisible({ timeout: 10_000 });
  const publicLink = await page.getByTestId("public-link").textContent();
  expect(publicLink).toBeTruthy();

  // ── 6. Create endpoint ───────────────────────────────────────────────────────
  await page.goto("/app/endpoints");
  await page.getByRole("button", { name: /new endpoint/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // Fill in name and URL (dialogs have id="ep-name" and id="ep-url")
  await page.locator("#ep-name").fill("smoke sink");
  await page.locator("#ep-url").fill(sinkUrl);
  await page.getByRole("button", { name: /^create$/i }).click();
  // Secret dialog opens — secret value should be visible
  await expect(page.getByTestId("secret-value")).toBeVisible({ timeout: 10_000 });
  // Check the "I've stored it" checkbox to enable close button
  await page.getByRole("checkbox").check();
  // Click close (data-testid="secret-close")
  await page.getByTestId("secret-close").click();
  await expect(page.getByTestId("secret-value")).not.toBeVisible({ timeout: 5_000 });

  // ── 7. Anonymous submit ──────────────────────────────────────────────────────
  const slug = publicLink!.trim().replace(/.*\/forms\//, "");
  await page.goto(`/forms/${slug}`);
  // Fill in the "Name" field (label matches exactly)
  await page.getByLabel("Name").fill("Playwright");
  await page.getByRole("button", { name: /submit/i }).click();
  await expect(page.getByText(/response recorded/i)).toBeVisible({ timeout: 10_000 });

  // ── 8. Deliveries polling — wait for "delivered" ──────────────────────────────
  await page.goto("/app/deliveries");
  // The StatusBadge renders lowercase "delivered" in a Badge component.
  // We poll for the green "delivered" badge to appear (5s interval). Budget is
  // generous: a cold CI consumer-group join + CDC latency beats a warm local run.
  await expect(page.getByText("delivered").first()).toBeVisible({ timeout: 60_000 });
});
