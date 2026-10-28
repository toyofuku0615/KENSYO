import { test, expect } from "@playwright/test";
test("AI settings registers ten local forms for the dashboard collection workflow", async ({
  page,
  request,
}) => {
  const headers = { Origin: "http://127.0.0.1:3000" };
  expect((await request.delete("/api/account", { headers })).ok()).toBe(true);
  // Initialize the existing two-case demo source too; no external source is fetched.
  await request.get("/api/dashboard");
  await page.goto("/settings/ai");
  await page
    .getByRole("button", { name: "AI模擬フォームの収集先を追加", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("収集先を追加");
  await page.goto("/");
  await page.getByRole("button", { name: "今すぐ収集", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("収集処理が完了");
  const dashboard = await (await request.get("/api/dashboard")).json();
  expect(
    dashboard.campaigns.filter(
      (c: { sourceId: string }) => c.sourceId === "demo-ai-fixture",
    ),
  ).toHaveLength(10);
  expect(dashboard.applications).toEqual([]);
  expect(dashboard.preferences.autoApply).toBe(false);
  await page
    .getByRole("navigation", { name: "メインナビゲーション" })
    .getByRole("button", { name: "懸賞を探す", exact: true })
    .click();
  await expect(page.locator(".campaign-card")).toHaveCount(12);
});
