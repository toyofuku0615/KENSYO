import { test, expect } from "@playwright/test";

test("dashboard collects, saves profile, submits once, shows receipt, and emergency-stops", async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  const headers = { Origin: "http://127.0.0.1:3000" };
  // Only the isolated demo database selected by playwright.config is used.
  await request.delete("/api/account", { headers });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "ダッシュボード", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "今すぐ収集", exact: true }).click();
  await expect(page.locator(".campaign-card")).toHaveCount(2);
  const collected = await (await request.get("/api/dashboard")).json();
  expect(collected.campaigns.every((c: { isDemo: boolean }) => c.isDemo)).toBe(
    true,
  );
  expect(collected.applications).toEqual([]);
  await page
    .getByRole("navigation", { name: "メインナビゲーション" })
    .getByRole("button", { name: "設定", exact: true })
    .click();
  await page.getByLabel("氏名", { exact: true }).fill("検証 太郎");
  await page.getByLabel("フリガナ", { exact: true }).fill("ケンショウ タロウ");
  await page
    .getByLabel("メールアドレス", { exact: true })
    .fill("dashboard@example.invalid");
  await page.getByLabel("電話番号", { exact: true }).fill("09000000000");
  await page.getByLabel("郵便番号", { exact: true }).fill("1000001");
  await page.getByLabel("都道府県", { exact: true }).selectOption("東京都");
  await page
    .getByLabel("市区町村・番地・建物名", { exact: true })
    .fill("検証用住所");
  await page.getByLabel("生年月日", { exact: true }).fill("1990-01-01");
  await page
    .getByRole("button", { name: "プロフィールを保存", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("暗号化して保存");
  await page.getByLabel("登録した個人情報を、", { exact: false }).check();
  await page
    .getByLabel("応募に必要な個人情報の取り扱いへの同意", { exact: false })
    .check();
  await page
    .getByRole("button", { name: "応募設定を保存", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("保存");
  await page
    .getByRole("switch", { name: "設定の自動応募", exact: true })
    .click();
  await expect(
    page.getByRole("switch", { name: "設定の自動応募", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page
    .getByRole("button", { name: "応募ジョブを今すぐ実行", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("応募ジョブを実行", {
    timeout: 60000,
  });
  const after = await (await request.get("/api/dashboard")).json();
  expect(after.applications).toHaveLength(1);
  expect(after.applications[0].status).toBe("submitted");
  expect(after.applications[0].receipt).toMatch(/^TEST-/);
  await page
    .getByRole("button", { name: "応募ジョブを今すぐ実行", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("応募ジョブを実行");
  expect(
    (await (await request.get("/api/dashboard")).json()).applications,
  ).toHaveLength(1);
  await page.getByRole("button", { name: "緊急停止する", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "緊急停止を解除（自動応募はOFF）" }),
  ).toBeVisible();
  const stopped = await (await request.get("/api/dashboard")).json();
  expect(stopped.preferences.emergencyStop).toBe(true);
  expect(stopped.preferences.autoApply).toBe(false);
  await page
    .getByRole("navigation", { name: "メインナビゲーション" })
    .getByRole("button", { name: "応募履歴", exact: true })
    .click();
  await expect(page.locator(".history-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".history-table")).toContainText(
    `受付番号 ${after.applications[0].receipt}`,
  );
  await expect(page.locator(".history-table")).toContainText("応募完了");
});

test("rejects cross-origin writes and invalid input without leaking profile data", async ({
  request,
}) => {
  const result = await request.put("/api/preferences", {
    headers: { Origin: "https://attacker.example" },
    data: { preferences: { autoApply: true } },
  });
  expect(result.status()).toBe(403);
  const invalid = await request.put("/api/profile", {
    headers: { Origin: "http://127.0.0.1:3000" },
    data: { profile: { email: "secret-profile-data" } },
  });
  expect(invalid.status()).toBe(400);
  expect(await invalid.text()).not.toContain("secret-profile-data");
});

test("mobile dashboard fits the viewport and navigation works", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("navigation", { name: "モバイルナビゲーション" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "モバイルナビゲーション" })
    .getByRole("button", { name: "設定", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "ワークスペース設定", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("manual queue records a local fixture outcome and reports a win in history", async ({
  page,
  request,
}) => {
  const headers = { Origin: "http://127.0.0.1:3000" };
  expect((await request.delete("/api/account", { headers })).ok()).toBe(true);
  // Read once to initialize the demo fixture source, then collect only that source.
  expect((await request.get("/api/dashboard")).ok()).toBe(true);
  const collection = await request.post("/api/run", {
    headers,
    data: { kind: "collect" },
  });
  expect(collection.ok()).toBe(true);
  expect((await collection.json()).run.processed).toBe(2);
  await page.goto("/");
  const navigation = page.getByRole("navigation", {
    name: "メインナビゲーション",
  });
  await navigation.getByRole("button", { name: /^手動応募リスト/ }).click();
  await expect(page.locator(".campaign-card")).toHaveCount(1);
  await expect(page.locator(".campaign-card")).toContainText(
    "【テスト】コーヒーセットが当たる",
  );
  await page.getByRole("button", { name: "詳細を見る", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "キャンペーン詳細" });
  await expect(detail).toContainText(
    "関連規約を確認できないため手動確認が必要",
  );
  await expect(
    detail.getByRole("link", { name: "応募ページを開く", exact: true }),
  ).toHaveAttribute("href", "http://127.0.0.1:3000/test-form");
  // This is a fixture-only result record. No real campaign page is visited.
  page.once("dialog", (dialog) => dialog.accept());
  await detail
    .getByRole("button", { name: "手動で応募済みにする", exact: true })
    .click();
  await expect(detail).not.toBeVisible();
  await expect(page.locator(".campaign-card")).toHaveCount(0);
  await navigation
    .getByRole("button", { name: "応募履歴", exact: true })
    .click();
  const historyRow = page.locator(".history-table tbody tr").filter({
    hasText: "【テスト】コーヒーセットが当たる",
  });
  await expect(historyRow).toContainText("テスト用応募");
  await expect(historyRow).toContainText("応募完了");
  page.once("dialog", (dialog) => dialog.accept("3000"));
  await historyRow.getByRole("button", { name: "当選", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("当選を記録しました");
  await expect(historyRow.locator(".badge")).toHaveText("当選");
  const recorded = await (await request.get("/api/dashboard")).json();
  expect(recorded.applications).toHaveLength(1);
  expect(recorded.applications[0]).toMatchObject({
    status: "won",
    prizeValue: 3000,
  });
  await navigation
    .getByRole("button", { name: "ダッシュボード", exact: true })
    .click();
  await expect(
    page.locator(".bottom-stat").filter({ hasText: "推定総額" }),
  ).toContainText("¥3,000");
});

test("owner profile is loaded only by settings and remains saved after reload", async ({
  page,
  request,
}) => {
  const headers = { Origin: "http://127.0.0.1:3000" };
  expect((await request.delete("/api/account", { headers })).ok()).toBe(true);
  const profile = {
    name: "設定検証 太郎",
    kana: "セッテイケンショウ タロウ",
    postalCode: "1000001",
    prefecture: "東京都",
    address: "設定画面専用の検証住所",
    phone: "09000000000",
    email: "profile-privacy@example.invalid",
    birthDate: "1990-01-01",
  };
  expect(
    (await request.put("/api/profile", { headers, data: { profile } })).ok(),
  ).toBe(true);
  const homeData = await (await request.get("/api/dashboard")).json();
  expect(homeData.hasProfile).toBe(true);
  expect(homeData.profile).toBeNull();
  expect(JSON.stringify(homeData)).not.toContain(profile.email);
  const loadedDashboardUrls: string[] = [];
  page.on("request", (sent) => {
    if (new URL(sent.url()).pathname === "/api/dashboard") {
      loadedDashboardUrls.push(sent.url());
    }
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "今すぐ収集", exact: true }),
  ).toBeEnabled();
  expect(
    loadedDashboardUrls.some((url) => url.includes("includeProfile")),
  ).toBe(false);
  const navigation = page.getByRole("navigation", {
    name: "メインナビゲーション",
  });
  await navigation.getByRole("button", { name: "設定", exact: true }).click();
  await expect(page.getByLabel("氏名", { exact: true })).toHaveValue(
    profile.name,
  );
  await expect(page.getByLabel("メールアドレス", { exact: true })).toHaveValue(
    profile.email,
  );
  expect(
    loadedDashboardUrls.some((url) => url.includes("includeProfile=1")),
  ).toBe(true);
  await navigation
    .getByRole("button", { name: "ダッシュボード", exact: true })
    .click();
  await expect(page.getByLabel("氏名", { exact: true })).toHaveCount(0);
  await page.reload();
  await navigation.getByRole("button", { name: "設定", exact: true }).click();
  await expect(page.getByLabel("氏名", { exact: true })).toHaveValue(
    profile.name,
  );
  await expect(
    page.getByLabel("市区町村・番地・建物名", { exact: true }),
  ).toHaveValue(profile.address);
});

test("source settings can add and delete an approved source without fetching it", async ({
  page,
  request,
}) => {
  const headers = { Origin: "http://127.0.0.1:3000" };
  expect((await request.delete("/api/account", { headers })).ok()).toBe(true);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "メインナビゲーション" })
    .getByRole("button", { name: "設定", exact: true })
    .click();
  const form = page.locator(".source-form");
  const sourceName = "検証専用RSS（取得しません）";
  await form.getByLabel("収集先の名前", { exact: true }).fill(sourceName);
  await form.getByLabel("種類").selectOption("rss");
  await form
    .getByLabel("URL", { exact: true })
    .fill("https://example.invalid/feed.xml");
  await form
    .getByLabel("追加で許可する公式ホスト", { exact: false })
    .fill("campaign.example.invalid");
  await form
    .getByLabel("この収集先の利用条件を確認し、", { exact: false })
    .check();
  await form.getByRole("button", { name: "収集先を追加", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("収集先を追加しました");
  const sourceItem = page
    .locator(".source-item")
    .filter({ hasText: sourceName });
  await expect(sourceItem).toBeVisible();
  const afterAdd = await (await request.get("/api/dashboard")).json();
  expect(
    afterAdd.sources.find(
      (source: { name: string }) => source.name === sourceName,
    ),
  ).toMatchObject({
    kind: "rss",
    url: "https://example.invalid/feed.xml",
    allowedHosts: ["example.invalid", "campaign.example.invalid"],
    termsAccepted: true,
  });
  // No collector or network operation is run for the intentionally invalid test domain.
  expect(afterAdd.runs).toEqual([]);
  await sourceItem
    .getByRole("button", { name: `${sourceName}を削除`, exact: true })
    .click();
  await expect(sourceItem).toHaveCount(0);
  const afterDelete = await (await request.get("/api/dashboard")).json();
  expect(
    afterDelete.sources.some(
      (source: { name: string }) => source.name === sourceName,
    ),
  ).toBe(false);
});
