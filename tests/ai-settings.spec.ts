import { test, expect } from "@playwright/test";

const origin = "http://127.0.0.1:3000";
const headers = { Origin: origin };
// Deliberately invalid for Google, but valid for testing encrypted local storage.
const fixtureKey = "TEST_ONLY_NOT_A_REAL_GEMINI_KEY_1234567890";

test("AI settings saves and deletes the encrypted key without returning it to the browser", async ({
  page,
  request,
}) => {
  expect((await request.delete("/api/account", { headers })).ok()).toBe(true);
  await page.goto("/settings/ai");
  await expect(
    page.getByRole("heading", { name: "AI設定", exact: true }),
  ).toBeVisible();
  const keyInput = page.getByLabel("Gemini APIキー", { exact: true });
  await expect(keyInput).toHaveAttribute("type", "password");
  await expect(keyInput).toHaveValue("");
  await keyInput.fill(fixtureKey);
  await page
    .getByRole("button", { name: "APIキーを保存", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("暗号化して保存");
  await expect(keyInput).toHaveValue("");
  await expect(page.locator(".ai-key-meta")).toContainText("設定済み ••••••••");
  await expect(page.locator(".ai-key-meta")).toContainText(
    "Web画面から登録したキーを使用",
  );

  const response = await request.get("/api/settings/ai");
  expect(response.ok()).toBe(true);
  const payload = await response.json();
  expect(payload.keyConfigured).toBe(true);
  expect(payload.keySource).toBe("stored");
  expect(JSON.stringify(payload)).not.toContain(fixtureKey);
  expect(JSON.stringify(payload)).not.toContain("ciphertext");
  expect(payload.usage.monthCalls).toBe(0);
  expect(await page.content()).not.toContain(fixtureKey);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain(fixtureKey);

  await page.reload();
  await expect(keyInput).toHaveValue("");
  await expect(page.locator(".ai-key-meta")).toContainText("設定済み");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "APIキーを削除", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("登録したAPIキーを削除");
  const deleted = await (await request.get("/api/settings/ai")).json();
  expect(deleted.keySource).not.toBe("stored");
  expect(deleted.settings.enabled).toBe(false);
  expect(JSON.stringify(deleted)).not.toContain(fixtureKey);
  await expect(keyInput).toHaveValue("");
});

test("AI settings selects explicitly listed models and persists bounded usage settings", async ({
  page,
  request,
}) => {
  expect((await request.delete("/api/account", { headers })).ok()).toBe(true);
  expect(
    (
      await request.post("/api/settings/ai", {
        headers,
        data: { apiKey: fixtureKey },
      })
    ).ok(),
  ).toBe(true);
  // Mock only this browser's catalog response; no Google request is made.
  await page.route("**/api/settings/ai/models", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        models: [
          { id: "fixture-model-alpha", displayName: "検証モデルA" },
          { id: "fixture-model-beta", displayName: "検証モデルB" },
        ],
      }),
    }),
  );
  await page.goto("/settings/ai");
  await page
    .getByRole("button", { name: "モデル一覧を取得", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "利用可能なモデルを取得",
  );
  await page
    .getByRole("combobox", { name: "使用するモデル", exact: true })
    .selectOption("fixture-model-alpha");
  const tierCheck = page.getByLabel(
    "選択するモデルとプロジェクトの料金・無料枠・利用条件を公式情報で確認しました。",
    { exact: true },
  );
  await tierCheck.check();
  await page.getByRole("switch", { name: "AI機能", exact: true }).click();
  await page.getByLabel("1日のAPI呼び出し上限", { exact: true }).fill("3");
  await page.getByLabel("1か月のAPI呼び出し上限", { exact: true }).fill("7");
  await page.getByLabel("1分あたりの呼び出し上限", { exact: true }).fill("1");
  await page.getByLabel("1か月のトークン上限", { exact: true }).fill("30000");
  await page
    .getByLabel("1リクエストの入力サイズ上限", { exact: true })
    .fill("2000");
  await page.getByLabel("1リクエストの出力上限", { exact: true }).fill("256");
  await page.getByRole("button", { name: "AI設定を保存", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("AI設定を保存しました");
  const status = await (await request.get("/api/settings/ai")).json();
  expect(status.settings).toMatchObject({
    enabled: true,
    model: "fixture-model-alpha",
    freeTierAcknowledged: true,
    dailyLimit: 3,
    monthlyLimit: 7,
    perMinuteLimit: 1,
    monthlyTokenLimit: 30000,
    maxInputChars: 2000,
    maxOutputTokens: 256,
  });
  expect(status.usage.monthCalls).toBe(0);
  await page
    .getByRole("combobox", { name: "使用するモデル", exact: true })
    .selectOption("fixture-model-beta");
  await expect(tierCheck).not.toBeChecked();
  await page.reload();
  await expect(
    page.getByRole("switch", { name: "AI機能", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("combobox", { name: "使用するモデル", exact: true }),
  ).toHaveValue("fixture-model-alpha");
  await expect(
    page.getByLabel("1日のAPI呼び出し上限", { exact: true }),
  ).toHaveValue("3");
});

test("AI key APIs reject cross-origin writes and invalid values without revealing input", async ({
  request,
}) => {
  expect((await request.delete("/api/account", { headers })).ok()).toBe(true);
  const crossOrigin = await request.post("/api/settings/ai", {
    headers: { Origin: "https://attacker.example" },
    data: { apiKey: fixtureKey },
  });
  expect(crossOrigin.status()).toBe(403);
  const invalidKey = "secret key with invalid spaces";
  const invalid = await request.post("/api/settings/ai", {
    headers,
    data: { apiKey: invalidKey },
  });
  expect(invalid.status()).toBe(400);
  expect(await invalid.text()).not.toContain(invalidKey);
  const status = await (await request.get("/api/settings/ai")).json();
  const invalidLimits = await request.put("/api/settings/ai", {
    headers,
    data: { settings: { ...status.settings, dailyLimit: 0 } },
  });
  expect(invalidLimits.status()).toBe(400);
  expect(
    (await (await request.get("/api/settings/ai")).json()).keySource,
  ).not.toBe("stored");
});

test("AI settings is reachable from dashboard and fits a mobile viewport", async ({
  page,
  request,
}) => {
  expect((await request.delete("/api/account", { headers })).ok()).toBe(true);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "メインナビゲーション" })
    .getByRole("button", { name: "設定", exact: true })
    .click();
  await page.getByRole("link", { name: "AI設定を開く", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "AI設定", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByLabel("Gemini APIキー", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("link", { name: "公式の料金・無料枠", exact: true }),
  ).toHaveAttribute("href", "https://ai.google.dev/gemini-api/docs/pricing");
});
