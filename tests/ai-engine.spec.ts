import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { createLocalStore } from "../src/lib/store";
import { runApplications } from "../src/core/runner";
import {
  submitWithGenericBrowser,
  executeActions,
  readSubmissionEvidence,
} from "../src/automation/executor";
import {
  inspectForm,
  verifyCapturedForm,
} from "../src/automation/form-analyzer";
import { validateActionPlan } from "../src/automation/submission-validator";
import {
  aiProfile,
  aiCampaign,
  aiPreferences,
  fakeFormAI,
  planForSnapshot,
} from "./helpers/ai-fixtures";

test.describe("mocked Gemini plans executed by real Chromium", () => {
  for (const variant of [
    "easy",
    "survey",
    "free",
    "quiz",
    "multi",
    "reordered",
  ]) {
    test(`understands ${variant}, inputs safely, submits and persists a single receipt`, async () => {
      const store = createLocalStore(":memory:", randomBytes(32));
      const mock = fakeFormAI();
      const campaign = aiCampaign(variant);
      try {
        await store.saveProfile("ai-browser", aiProfile);
        await store.savePreferences("ai-browser", aiPreferences());
        await store.upsertCampaign("ai-browser", campaign);
        const run = await runApplications(store, "ai-browser", undefined, {
          aiService: mock.service,
        });
        const [application] = await store.listApplications("ai-browser");
        expect(run.errors).toEqual([]);
        expect(run.processed).toBe(1);
        expect(application).toMatchObject({
          status: "submitted",
          campaignId: campaign.id,
        });
        expect(application.receipt).toMatch(/^AI-TEST-/);
        expect(mock.inputs.length).toBe(variant === "multi" ? 3 : 2);
        const sent = JSON.stringify(mock.inputs);
        for (const value of [
          aiProfile.name,
          aiProfile.address,
          aiProfile.email,
          aiProfile.phone,
          aiProfile.birthDate,
          aiProfile.postalCode,
        ])
          expect(sent).not.toContain(value);
        expect(
          (
            await runApplications(store, "ai-browser", undefined, {
              aiService: mock.service,
            })
          ).processed,
        ).toBe(0);
      } finally {
        store.close();
      }
    });
  }
  for (const variant of ["ambiguous", "missing", "captcha", "prohibited"]) {
    test(`stops ${variant} before submitting the fixture`, async () => {
      const mock = fakeFormAI();
      const result = await submitWithGenericBrowser({
        campaign: aiCampaign(variant),
        profile: aiProfile,
        preferences: aiPreferences(),
        ai: mock.service,
        finalCheck: async () => true,
      });
      expect(result.receipt).toBeNull();
      expect(result.status).toBe(
        variant === "prohibited" ? "blocked" : "manual_required",
      );
      if (["captcha", "prohibited"].includes(variant))
        expect(mock.inputs).toHaveLength(0);
    });
  }
  test("stops final submit when the user enables emergency stop", async () => {
    const mock = fakeFormAI();
    let stopped = false;
    const ai = {
      ...mock.service,
      async generate<T>(...args: Parameters<typeof mock.service.generate<T>>) {
        const result = await mock.service.generate<T>(...args);
        if (mock.inputs.length === 2) stopped = true;
        return result;
      },
    };
    const result = await submitWithGenericBrowser({
      campaign: aiCampaign(),
      profile: aiProfile,
      preferences: aiPreferences(),
      ai,
      finalCheck: async () => !stopped,
    });
    expect(result).toMatchObject({ status: "blocked", receipt: null });
  });
  test("does not accept a completion screen that predates any submit", async ({
    page,
  }) => {
    await page.setContent(
      '<h1>応募を受け付けました</h1><p data-testid="receipt">PREEXISTING-123</p>',
    );
    expect(await readSubmissionEvidence(page, false)).toMatchObject({
      status: "manual_required",
      receipt: null,
    });
    expect(await readSubmissionEvidence(page, false, true)).toMatchObject({
      status: "unknown_result",
      receipt: null,
    });
    expect(await readSubmissionEvidence(page, true, true)).toMatchObject({
      status: "submitted",
      receipt: "PREEXISTING-123",
    });
  });
  test("stores an uncertain result after an interrupted flow and never automatically resends", async () => {
    const store = createLocalStore(":memory:", randomBytes(32)),
      mock = fakeFormAI();
    let calls = 0;
    const ai = {
      ...mock.service,
      async generate<T>(...args: Parameters<typeof mock.service.generate<T>>) {
        calls++;
        if (calls === 2) throw new Error("Injected outage");
        return mock.service.generate<T>(...args);
      },
    };
    try {
      await store.saveProfile("uncertain-user", aiProfile);
      await store.savePreferences("uncertain-user", aiPreferences());
      await store.upsertCampaign("uncertain-user", aiCampaign());
      await runApplications(store, "uncertain-user", undefined, {
        aiService: ai,
      });
      expect((await store.listApplications("uncertain-user"))[0]).toMatchObject(
        { status: "unknown_result", receipt: null },
      );
      expect(
        (
          await runApplications(store, "uncertain-user", undefined, {
            aiService: ai,
          })
        ).processed,
      ).toBe(0);
      expect(calls).toBe(2);
    } finally {
      store.close();
    }
  });
});

test("structural inspection excludes values, hidden inputs and echoed private labels", async ({
  page,
}) => {
  await page.setContent(
    `<form><label>お名前<input value="${aiProfile.name}"></label><input type="hidden" value="secret-token"><label>ご住所<input value="${aiProfile.address}"></label><button>次へ</button></form>`,
  );
  const snapshot = await inspectForm(page, aiProfile);
  const sent = JSON.stringify(snapshot);
  expect(snapshot.fields).toHaveLength(2);
  expect(sent).not.toContain(aiProfile.name);
  expect(sent).not.toContain(aiProfile.address);
  expect(sent).not.toContain("secret-token");
  expect(sent).not.toContain("value");
  await page.setContent(`<label>${aiProfile.email}<input></label>`);
  await expect(inspectForm(page, aiProfile)).rejects.toThrow("個人情報");
});

test("ref and consent mutations after AI analysis are rejected before typing", async ({
  page,
}) => {
  await page.setContent(
    '<form><label>お名前<input></label><label>個人情報の取扱いに同意する<input type="checkbox" required></label><button>入力内容を確認する</button></form>',
  );
  const snapshot = await inspectForm(page, aiProfile);
  const plan = validateActionPlan(
    planForSnapshot(snapshot),
    snapshot,
    aiCampaign(),
    aiProfile,
    aiPreferences(),
  );
  await page
    .locator('[data-kensho-control="f1"]')
    .evaluate((node) => node.parentElement!.append("メールマガジン登録"));
  await expect(verifyCapturedForm(page, snapshot)).rejects.toThrow(
    "Form changed",
  );
  await expect(
    executeActions(page, plan, snapshot, {
      campaign: aiCampaign(),
      profile: aiProfile,
      preferences: aiPreferences(),
      finalCheck: async () => true,
    }),
  ).rejects.toThrow("Form changed");
});
