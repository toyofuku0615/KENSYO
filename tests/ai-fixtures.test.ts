import { describe, it, expect, afterEach, vi } from "vitest";
import { createLocalStore, type LocalStore } from "../src/lib/local-store";
import { AI_FIXTURE_SOURCE_ID } from "../src/core/ai-fixtures";
import { runCollection, runApplications } from "../src/core/runner";
import { DEFAULT_PREFERENCES, type Source } from "../src/core/types";
const stores: LocalStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  vi.unstubAllEnvs();
});
const source: Source = {
  id: AI_FIXTURE_SOURCE_ID,
  name: "AI模擬フォーム",
  url: "https://example.com/demo/ai",
  kind: "fixture",
  enabled: true,
  termsAccepted: true,
  allowedHosts: ["example.com"],
};
describe("opt-in AI fixture source uses the real collection/application pipeline", () => {
  it("collects ten distinct labelled local cases without duplicates", async () => {
    vi.stubEnv("KENSHO_MODE", "demo");
    const store = createLocalStore(":memory:");
    stores.push(store);
    await store.saveSource("fixture-user", source);
    expect((await runCollection(store, "fixture-user")).processed).toBe(10);
    expect((await runCollection(store, "fixture-user")).processed).toBe(10);
    const campaigns = await store.listCampaigns("fixture-user");
    expect(campaigns).toHaveLength(10);
    expect(
      campaigns.every(
        (c) =>
          c.isDemo &&
          c.title.startsWith("【AIテスト】") &&
          c.entryUrl.startsWith("http://127.0.0.1:3000/ai-test-form/"),
      ),
    ).toBe(true);
    expect(campaigns.some((c) => c.rules.captcha)).toBe(true);
    expect(campaigns.some((c) => c.rules.verdict === "prohibited")).toBe(true);
  });
  it("records AI-required fixtures as manual when Gemini is unavailable without invoking a browser", async () => {
    vi.stubEnv("KENSHO_MODE", "demo");
    vi.stubEnv("GEMINI_API_KEY", "");
    const store = createLocalStore(":memory:");
    stores.push(store);
    await store.saveSource("fixture-user", source);
    await runCollection(store, "fixture-user");
    await store.saveProfile("fixture-user", {
      name: "検証 太郎",
      kana: "ケンショウ タロウ",
      postalCode: "1000001",
      prefecture: "東京都",
      address: "検証用住所",
      phone: "09000000000",
      email: "fixture@example.invalid",
      birthDate: "1990-01-01",
    });
    await store.savePreferences("fixture-user", {
      ...DEFAULT_PREFERENCES,
      autoApply: true,
      consentAt: new Date().toISOString(),
      approvedConsents: ["privacy"],
    });
    const submit = vi.fn();
    const run = await runApplications(store, "fixture-user", submit);
    expect(run.processed).toBe(8);
    expect(submit).not.toHaveBeenCalled();
    const applications = await store.listApplications("fixture-user");
    expect(applications).toHaveLength(8);
    expect(applications.every((a) => a.status === "manual_required")).toBe(
      true,
    );
    expect((await store.ai.getUsage("fixture-user")).monthCalls).toBe(0);
  });
  it("never collects the local fixture source in Supabase mode", async () => {
    vi.stubEnv("KENSHO_MODE", "supabase");
    const store = createLocalStore(":memory:");
    stores.push(store);
    await store.saveSource("fixture-user", source);
    expect((await runCollection(store, "fixture-user")).processed).toBe(0);
    expect(await store.listCampaigns("fixture-user")).toEqual([]);
  });
});
