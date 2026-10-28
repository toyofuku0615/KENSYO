import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { buildGenericPlan, formPlanSchema } from "../src/automation/plan";
import {
  fixtureRequestAllowed,
  submitWithBrowser,
  supportsCampaign,
} from "../src/automation/browser";
import { createLocalStore } from "../src/lib/store";
import { runApplications } from "../src/core/runner";
import {
  DEFAULT_PREFERENCES,
  type Campaign,
  type Preferences,
  type Profile,
} from "../src/core/types";

const profile: Profile = {
  name: "テスト 太郎",
  kana: "テスト タロウ",
  email: "test@example.invalid",
  phone: "09000000000",
  postalCode: "1000001",
  prefecture: "東京都",
  address: "テスト住所",
  birthDate: "1990-01-01",
};
const preferences: Preferences = {
  ...DEFAULT_PREFERENCES,
  autoApply: true,
  consentAt: new Date(Date.now() - 1000).toISOString(),
  approvedConsents: ["privacy"],
};
function fixture(): Campaign {
  const now = new Date().toISOString();
  return {
    id: "fixture-1",
    title: "テスト応募",
    organizer: "テスト主催",
    officialUrl: "http://127.0.0.1:3000/test-form",
    entryUrl: "http://127.0.0.1:3000/test-form",
    imageUrl: null,
    prize: "テスト品",
    estimatedValue: 0,
    winners: 1,
    startsAt: null,
    deadline: new Date(Date.now() + 86400_000).toISOString(),
    category: "その他",
    conditions: [],
    rules: {
      verdict: "permitted",
      reason: "自作テスト",
      evidence: [
        {
          url: "http://127.0.0.1:3000/test-form",
          quote: "自作テストフォーム",
          fetchedAt: now,
          kind: "campaign",
        },
      ],
      reviewedAllTerms: true,
      japanOnly: true,
      minAge: 18,
      purchaseRequired: false,
      membershipRequired: false,
      snsRequired: false,
      captcha: false,
      maxEntries: 1,
      requiredConsents: ["privacy"],
      requiredFields: ["name", "email"],
      technicalAllowed: true,
    },
    sourceId: "fixture-source",
    discoveredAt: now,
    checkedAt: now,
    adapterId: "local-test",
    isDemo: true,
  };
}
async function setup() {
  const store = createLocalStore(":memory:", randomBytes(32));
  await store.saveProfile("user", profile);
  await store.savePreferences("user", structuredClone(preferences));
  await store.upsertCampaign("user", fixture());
  return store;
}
describe("typed form operations", () => {
  it("maps only known profile fields and explicitly approved required consents", () => {
    const result = buildGenericPlan(
      [
        { label: "氏名", type: "text", required: true },
        { label: "都道府県", type: "select", required: true },
        {
          label: "個人情報の取扱いに同意する",
          type: "checkbox",
          required: true,
        },
      ],
      profile,
      ["privacy"],
    );
    expect(result.reasons).toEqual([]);
    expect(result.plan?.operations).toEqual([
      { type: "fill", label: "氏名", field: "name" },
      { type: "select", label: "都道府県", field: "prefecture" },
      {
        type: "consent",
        label: "個人情報の取扱いに同意する",
        consent: "privacy",
      },
    ]);
  });
  it("never invents answers or checks advertising consent", () => {
    expect(
      buildGenericPlan(
        [{ label: "好きなブランドは？", type: "text", required: true }],
        profile,
        [],
      ).plan,
    ).toBeNull();
    expect(
      buildGenericPlan(
        [{ label: "メルマガに同意", type: "checkbox", required: true }],
        profile,
        ["privacy"],
      ).plan,
    ).toBeNull();
    expect(
      buildGenericPlan(
        [
          {
            label: "広告を受け取る",
            type: "checkbox",
            required: false,
            checked: true,
          },
        ],
        profile,
        [],
      ).plan,
    ).toBeNull();
    expect(
      buildGenericPlan(
        [{ label: "広告を受け取る", type: "checkbox", required: false }],
        profile,
        [],
      ).plan?.operations,
    ).toEqual([]);
  });
  it("rejects arbitrary browser/AI instruction operations", () => {
    expect(
      formPlanSchema.safeParse({
        operations: [{ type: "evaluate", script: "steal()" }],
        confirmLabel: "確認",
        submitLabel: "送信",
      }).success,
    ).toBe(false);
  });
  it("limits the demo exception to exact loopback fixture routes", () => {
    expect(fixtureRequestAllowed("http://127.0.0.1:3000/test-form")).toBe(true);
    for (const url of [
      "https://evil.example/test-form",
      "http://127.0.0.1:3000/api/profile",
      "http://127.0.0.2:3000/test-form",
      "http://127.0.0.1:3000/test-form-other",
    ])
      expect(fixtureRequestAllowed(url)).toBe(false);
    expect(supportsCampaign({ ...fixture(), isDemo: false })).toBe(false);
  });
});
describe("application runner", () => {
  it("records verified completion in the DB and prevents duplicate concurrent runs", async () => {
    const store = await setup();
    const submit = vi.fn(async () => ({
      status: "submitted" as const,
      receipt: "TEST-123",
      error: null,
    }));
    await Promise.all([
      runApplications(store, "user", submit),
      runApplications(store, "user", submit),
    ]);
    expect(submit).toHaveBeenCalledTimes(1);
    expect((await store.listApplications("user"))[0]).toMatchObject({
      status: "submitted",
      receipt: "TEST-123",
    });
    store.close();
  });
  it("does not retry uncertain outcomes on later scheduled runs", async () => {
    const store = await setup();
    const submit = vi.fn(async () => ({
      status: "unknown_result" as const,
      receipt: null,
      error: "結果不明",
    }));
    await runApplications(store, "user", submit);
    await runApplications(store, "user", submit);
    expect(submit).toHaveBeenCalledTimes(1);
    expect((await store.listApplications("user"))[0].status).toBe(
      "unknown_result",
    );
    store.close();
  });
  it.each(["prohibited", "unknown"] as const)(
    "never launches browser for %s rules",
    async (verdict) => {
      const store = await setup();
      const campaign = fixture();
      campaign.rules.verdict = verdict;
      await store.upsertCampaign("user", campaign);
      const submit = vi.fn();
      await runApplications(store, "user", submit);
      expect(submit).not.toHaveBeenCalled();
      expect(await store.listApplications("user")).toEqual([]);
      store.close();
    },
  );
  it.each(["off", "stop", "age", "unapproved"])(
    "blocks unsafe condition %s",
    async (condition) => {
      const store = await setup();
      if (condition === "off")
        await store.savePreferences("user", {
          ...preferences,
          autoApply: false,
        });
      if (condition === "stop")
        await store.savePreferences("user", {
          ...preferences,
          emergencyStop: true,
        });
      if (condition === "unapproved")
        await store.savePreferences("user", {
          ...preferences,
          approvedConsents: [],
        });
      if (condition === "age")
        await store.saveProfile("user", {
          ...profile,
          birthDate: new Date().toISOString().slice(0, 10),
        });
      const submit = vi.fn();
      await runApplications(store, "user", submit);
      expect(submit).not.toHaveBeenCalled();
      store.close();
    },
  );
  it("rechecks emergency stop immediately before submitting", async () => {
    const store = await setup();
    await runApplications(store, "user", async ({ finalCheck }) => {
      await store.savePreferences("user", {
        ...preferences,
        emergencyStop: true,
      });
      expect(await finalCheck()).toBe(false);
      return { status: "blocked", receipt: null, error: "停止" };
    });
    expect((await store.listApplications("user"))[0].status).toBe("blocked");
    store.close();
  });
  it("writes only controlled status data to audit logs, never profile/page error", async () => {
    const store = await setup();
    const audit = vi.spyOn(store, "audit");
    await runApplications(store, "user", async () => {
      throw new Error(JSON.stringify(profile));
    });
    expect(JSON.stringify(audit.mock.calls)).not.toContain(profile.email);
    const [application] = await store.listApplications("user");
    expect(application.error).not.toContain(profile.phone);
    store.close();
  });
  it("rejects a non-fixture site even if supplied a demo adapter id", async () => {
    const campaign = {
      ...fixture(),
      entryUrl: "https://evil.example/test-form",
    };
    const result = await submitWithBrowser({
      campaign,
      profile,
      preferences,
      finalCheck: async () => true,
    });
    expect(result.status).toBe("blocked");
  });
});
export { fixture, profile, preferences };
