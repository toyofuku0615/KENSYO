import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { createLocalStore } from "../src/lib/store";
import { submitWithBrowser } from "../src/automation/browser";
import { runApplications } from "../src/core/runner";
import {
  DEFAULT_PREFERENCES,
  type Campaign,
  type Profile,
} from "../src/core/types";

const profile: Profile = {
  name: "検証 太郎",
  kana: "ケンショウ タロウ",
  email: "fixture@example.invalid",
  phone: "09000000000",
  postalCode: "1000001",
  prefecture: "東京都",
  address: "テスト用住所",
  birthDate: "1990-01-01",
};
const preferences = {
  ...DEFAULT_PREFERENCES,
  autoApply: true,
  consentAt: new Date().toISOString(),
  approvedConsents: ["privacy"],
};
function campaign(): Campaign {
  const now = new Date().toISOString();
  return {
    id: "browser-fixture",
    title: "ブラウザ実送信検証",
    organizer: "ローカルテスト",
    officialUrl: "http://127.0.0.1:3000/test-form",
    entryUrl: "http://127.0.0.1:3000/test-form",
    imageUrl: null,
    prize: "架空の検証用賞品",
    estimatedValue: 0,
    winners: 1,
    startsAt: null,
    deadline: new Date(Date.now() + 86400_000).toISOString(),
    category: "その他",
    conditions: [],
    rules: {
      verdict: "permitted",
      reason: "自作のテストフォーム",
      evidence: [
        {
          url: "http://127.0.0.1:3000/test-form",
          quote: "テスト用応募フォーム",
          fetchedAt: now,
          kind: "campaign",
        },
      ],
      reviewedAllTerms: true,
      japanOnly: true,
      minAge: null,
      purchaseRequired: false,
      membershipRequired: false,
      snsRequired: false,
      captcha: false,
      maxEntries: 1,
      requiredConsents: ["privacy"],
      requiredFields: ["name", "email"],
      technicalAllowed: true,
    },
    sourceId: "test",
    discoveredAt: now,
    checkedAt: now,
    adapterId: "local-test",
    isDemo: true,
  };
}
test("browser fills the local form, confirms and submits, persists receipt, and refuses duplicate", async () => {
  test.setTimeout(60_000);
  const store = createLocalStore(":memory:", randomBytes(32));
  await store.saveProfile("browser-user", profile);
  await store.savePreferences("browser-user", preferences);
  await store.upsertCampaign("browser-user", campaign());
  const run = await runApplications(store, "browser-user");
  expect(run.errors).toEqual([]);
  expect(run.processed).toBe(1);
  const [application] = await store.listApplications("browser-user");
  expect(application.status).toBe("submitted");
  expect(application.receipt).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
  expect((await runApplications(store, "browser-user")).processed).toBe(0);
  store.close();
});
test("stop toggled at the final confirmation prevents the final submission", async () => {
  test.setTimeout(60_000);
  let checks = 0;
  const result = await submitWithBrowser({
    campaign: campaign(),
    profile,
    preferences,
    finalCheck: async () => ++checks === 1,
  });
  expect(checks).toBe(2);
  expect(result).toMatchObject({ status: "blocked", receipt: null });
});
