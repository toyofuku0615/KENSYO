import { describe, it, expect, vi } from "vitest";
import {
  actionPlanSchema,
  planForm,
  type ActionPlan,
} from "../src/automation/action-planner";
import {
  identifyProfileField,
  type FormSnapshot,
  type ObservedControl,
} from "../src/automation/form-analyzer";
import {
  validateActionPlan,
  validateGenericInput,
  canUseGenericCampaign,
  fulfillPublicRoute,
} from "../src/automation/submission-validator";
import {
  safeGeneratedAnswer,
  safeOptionAnswer,
} from "../src/automation/answer-generator";
import {
  aiCampaign,
  aiProfile,
  aiPreferences,
  planForSnapshot,
  fakeFormAI,
} from "./helpers/ai-fixtures";
import type { Route } from "playwright";
function field(patch: Partial<ObservedControl> = {}): ObservedControl {
  return {
    ref: "f0",
    label: "お名前",
    question: "",
    type: "text",
    required: true,
    maxLength: 100,
    checked: false,
    profileField: "name",
    options: [],
    ...patch,
  };
}
function snapshot(fields = [field()]): FormSnapshot {
  return {
    fields,
    buttons: [{ ref: "b0", label: "入力内容を確認する", kind: "next" }],
    blocked: [],
  };
}
const terminal = { type: "click_next" as const, ref: "b0" };
const quote = "商品の特徴は無糖です。";

describe("bounded AI form plans", () => {
  it("maps verified Japanese profile labels independently of form order", () => {
    expect(identifyProfileField("お名前")).toBe("name");
    expect(identifyProfileField("ご住所")).toBe("address");
    expect(identifyProfileField("ご連絡先メールアドレス")).toBe("email");
    expect(identifyProfileField("対象番号")).toBeNull();
  });
  it("executes only typed operations with known opaque refs", () => {
    const data = snapshot();
    expect(
      validateActionPlan(
        planForSnapshot(data),
        data,
        aiCampaign(),
        aiProfile,
        aiPreferences(),
      ).actions[0],
    ).toMatchObject({ type: "fill_profile_field", field: "name" });
    expect(() =>
      actionPlanSchema.parse({
        actions: [{ type: "evaluate", code: "alert(1)" }],
        manualReason: null,
      }),
    ).toThrow();
    expect(() =>
      actionPlanSchema.parse({
        actions: [{ type: "navigate", url: "https://evil.invalid" }],
        manualReason: null,
      }),
    ).toThrow();
  });
  it.each(["f99", "b0"])("rejects invented input ref %s", (ref) => {
    expect(() =>
      validateActionPlan(
        {
          actions: [
            { type: "fill_profile_field", ref, field: "name" },
            terminal,
          ],
          manualReason: null,
        },
        snapshot(),
        aiCampaign(),
        aiProfile,
        aiPreferences(),
      ),
    ).toThrow();
  });
  it("rejects duplicate actions, missing fields and ambiguous profile mapping", () => {
    const known = planForSnapshot(snapshot());
    expect(() =>
      validateActionPlan(
        { ...known, actions: [known.actions[0], ...known.actions] },
        snapshot(),
        aiCampaign(),
        aiProfile,
        aiPreferences(),
      ),
    ).toThrow();
    expect(() =>
      validateActionPlan(
        { actions: [terminal], manualReason: null },
        snapshot(),
        aiCampaign(),
        aiProfile,
        aiPreferences(),
      ),
    ).toThrow("unanswered-required");
    expect(() =>
      validateActionPlan(
        {
          actions: [
            { type: "fill_profile_field", ref: "f0", field: "name" },
            terminal,
          ],
          manualReason: null,
        },
        snapshot([field({ profileField: null, label: "番号" })]),
        aiCampaign(),
        aiProfile,
        aiPreferences(),
      ),
    ).toThrow("unverified-profile-mapping");
  });
  it("rejects extra properties and multiple or misplaced transition clicks", () => {
    expect(() =>
      actionPlanSchema.parse({
        actions: [{ ...terminal, url: "https://evil.invalid" }],
        manualReason: null,
      }),
    ).toThrow();
    expect(() =>
      validateActionPlan(
        { actions: [terminal, terminal], manualReason: null },
        snapshot([]),
        aiCampaign(),
        aiProfile,
        aiPreferences(),
      ),
    ).toThrow("invalid-transition");
    expect(() =>
      validateActionPlan(
        { actions: [terminal, { type: "inspect_page" }], manualReason: null },
        snapshot([]),
        aiCampaign(),
        aiProfile,
        aiPreferences(),
      ),
    ).toThrow("invalid-transition");
  });
  it("requires an observed next/submit button of the matching kind", () => {
    expect(() =>
      validateActionPlan(
        {
          actions: [{ type: "submit_application", ref: "b0" }],
          manualReason: null,
        },
        snapshot([]),
        aiCampaign(),
        aiProfile,
        aiPreferences(),
      ),
    ).toThrow("unapproved-button");
  });
  it("blocks CAPTCHA, unknown required controls and unsolicited optional consent", () => {
    expect(() =>
      validateActionPlan(
        planForSnapshot(snapshot()),
        { ...snapshot(), blocked: ["CAPTCHA"] },
        aiCampaign(),
        aiProfile,
        aiPreferences(),
      ),
    ).toThrow("blocked-form");
    expect(() =>
      validateActionPlan(
        { actions: [terminal], manualReason: null },
        snapshot([field({ type: "unsupported", profileField: null })]),
        aiCampaign(),
        aiProfile,
        aiPreferences(),
      ),
    ).toThrow("unsupported-required");
    expect(() =>
      validateActionPlan(
        { actions: [terminal], manualReason: null },
        snapshot([
          field({
            type: "checkbox",
            required: false,
            checked: true,
            profileField: null,
          }),
        ]),
        aiCampaign(),
        aiProfile,
        aiPreferences(),
      ),
    ).toThrow("prechecked-optional-consent");
  });
  it.each([
    "個人情報の取り扱いとメルマガに同意",
    "個人情報の第三者提供に同意",
    "プライバシーとニュースレターに同意",
  ])("never approves combined advertising consent: %s", (label) => {
    const data = snapshot([
      field({ type: "checkbox", label, profileField: null }),
    ]);
    expect(() =>
      validateActionPlan(
        {
          actions: [
            { type: "check_approved_consent", ref: "f0", consent: "privacy" },
            terminal,
          ],
          manualReason: null,
        },
        data,
        aiCampaign(),
        aiProfile,
        aiPreferences(),
      ),
    ).toThrow("unapproved-consent");
  });
  it("requires approved mandatory consent and validates profile length", () => {
    const data = snapshot([
      field({
        type: "checkbox",
        label: "個人情報の取扱いに同意する",
        profileField: null,
      }),
    ]);
    expect(() =>
      validateActionPlan(planForSnapshot(data), data, aiCampaign(), aiProfile, {
        ...aiPreferences(),
        approvedConsents: [],
      }),
    ).toThrow();
    const limited = snapshot([field({ maxLength: 2 })]);
    expect(() =>
      validateActionPlan(
        planForSnapshot(limited),
        limited,
        aiCampaign(),
        aiProfile,
        aiPreferences(),
      ),
    ).toThrow("profile-too-long");
  });
  it("requires a named question and one grounded answer for each required radio group", () => {
    const data = snapshot([
      field({
        type: "radio",
        label: "無糖",
        question: "商品の特徴として正しいもの",
        profileField: null,
      }),
      field({
        ref: "f1",
        type: "radio",
        label: "加糖",
        question: "商品の特徴として正しいもの",
        profileField: null,
      }),
    ]);
    expect(
      validateActionPlan(
        planForSnapshot(data),
        data,
        aiCampaign(),
        aiProfile,
        aiPreferences(),
      ).actions,
    ).toContainEqual({ type: "select_radio", ref: "f0", evidenceQuote: quote });
    expect(() =>
      validateActionPlan(
        { actions: [terminal], manualReason: null },
        data,
        aiCampaign(),
        aiProfile,
        aiPreferences(),
      ),
    ).toThrow("unanswered-radio");
    const unnamed = snapshot([
      field({ type: "radio", label: "無糖", question: "", profileField: null }),
    ]);
    expect(() =>
      validateActionPlan(
        {
          actions: [
            { type: "select_radio", ref: "f0", evidenceQuote: quote },
            terminal,
          ],
          manualReason: null,
        },
        unnamed,
        aiCampaign(),
        aiProfile,
        aiPreferences(),
      ),
    ).toThrow();
  });
  it("sends structural metadata and symbolic profile names without actual private data", async () => {
    const ai = fakeFormAI();
    await planForm(
      ai.service,
      snapshot(),
      aiCampaign(),
      aiPreferences(),
      aiProfile,
    );
    const data = JSON.stringify(ai.inputs);
    for (const value of [
      aiProfile.name,
      aiProfile.address,
      aiProfile.email,
      aiProfile.phone,
      aiProfile.birthDate,
      aiProfile.postalCode,
    ])
      expect(data).not.toContain(value);
    expect(data).toContain("availableFields");
  });
  it("refuses echoed private values even with an injected AI provider", async () => {
    const ai = fakeFormAI();
    await expect(
      planForm(
        ai.service,
        snapshot([field({ label: aiProfile.email })]),
        aiCampaign(),
        aiPreferences(),
        aiProfile,
      ),
    ).rejects.toThrow("個人情報");
    expect(ai.inputs).toHaveLength(0);
  });
});

describe("answers require public evidence or explicit local preferences", () => {
  const answerField = field({
    profileField: null,
    type: "textarea",
    label: "この商品を試してみたい理由",
    maxLength: 100,
  });
  it("accepts a bounded future wish grounded in supplied product facts", () => {
    expect(
      safeGeneratedAnswer(
        "無糖の味わいを試してみたいです。",
        quote,
        answerField,
        aiCampaign(),
        aiProfile,
      ),
    ).toBe(true);
  });
  it.each([
    "以前購入しました。今後も試してみたいです。",
    "10年愛飲していました。期待します。",
    "毎日飲んでいます。試してみたいです。",
    "検証 太郎として試してみたいです。",
  ])("rejects experience or identity claims: %s", (answer) => {
    expect(
      safeGeneratedAnswer(answer, quote, answerField, aiCampaign(), aiProfile),
    ).toBe(false);
  });
  it("rejects unsupported evidence, overlong answers and questions about purchase history", () => {
    expect(
      safeGeneratedAnswer(
        "無糖を試してみたいです。",
        "存在しない事実",
        answerField,
        aiCampaign(),
        aiProfile,
      ),
    ).toBe(false);
    expect(
      safeGeneratedAnswer(
        "無糖を試してみたいです。",
        quote,
        { ...answerField, maxLength: 5 },
        aiCampaign(),
        aiProfile,
      ),
    ).toBe(false);
    expect(
      safeGeneratedAnswer(
        "試してみたいです。",
        quote,
        { ...answerField, label: "過去の購入歴と経験を記入" },
        aiCampaign(),
        aiProfile,
      ),
    ).toBe(false);
  });
  it("accepts quiz choice only when quoted evidence actually contains the option", () => {
    const quiz = field({
      profileField: null,
      type: "radio",
      label: "無糖",
      question: "商品の特徴として正しいもの",
    });
    expect(
      safeOptionAnswer("無糖", quote, quiz, aiCampaign(), aiPreferences()),
    ).toBe(true);
    expect(
      safeOptionAnswer("加糖", quote, quiz, aiCampaign(), aiPreferences()),
    ).toBe(false);
    expect(
      safeOptionAnswer("無糖", "", quiz, aiCampaign(), aiPreferences()),
    ).toBe(false);
  });
  it("matches preferences exactly and rejects advertising disguised as a category", () => {
    const choice = field({
      profileField: null,
      type: "select",
      label: "応募したいカテゴリ",
    });
    expect(
      safeOptionAnswer("食品・飲料", "", choice, aiCampaign(), aiPreferences()),
    ).toBe(true);
    expect(
      safeOptionAnswer(
        "食品・飲料の広告配信に同意する",
        "",
        choice,
        aiCampaign(),
        aiPreferences(),
      ),
    ).toBe(false);
    expect(
      safeOptionAnswer("食品", "", choice, aiCampaign(), aiPreferences()),
    ).toBe(false);
  });
});

describe("generic browser safety gates", () => {
  it("blocks prohibited, unknown, disabled, stopped and not-yet-approved campaigns", () => {
    const campaign = aiCampaign();
    const preferences = aiPreferences();
    expect(validateGenericInput(campaign, aiProfile, preferences)).toBe(true);
    for (const verdict of ["prohibited", "unknown"] as const)
      expect(
        validateGenericInput(
          { ...campaign, rules: { ...campaign.rules, verdict } },
          aiProfile,
          preferences,
        ),
      ).toBe(false);
    expect(
      validateGenericInput(campaign, aiProfile, {
        ...preferences,
        autoApply: false,
      }),
    ).toBe(false);
    expect(
      validateGenericInput(campaign, aiProfile, {
        ...preferences,
        emergencyStop: true,
      }),
    ).toBe(false);
    expect(
      validateGenericInput(campaign, aiProfile, {
        ...preferences,
        consentAt: null,
      }),
    ).toBe(false);
    expect(
      canUseGenericCampaign({
        ...campaign,
        entryUrl: "http://127.0.0.1:3000/api/private",
      }),
    ).toBe(false);
    expect(
      canUseGenericCampaign({
        ...campaign,
        isDemo: false,
        entryUrl: "https://example.com/form",
      }),
    ).toBe(false);
  });
  it("freezes all requests after private typing until an approved transition", async () => {
    const abort = vi.fn().mockResolvedValue(undefined),
      check = vi.fn().mockResolvedValue(true);
    const route = {
      request: () => ({
        url: () => "https://example.com/collect/LWVuY29kZWQtcHJpdmF0ZS12YWx1ZQ",
        method: () => "GET",
        postData: () => null,
      }),
      abort,
    } as unknown as Route;
    await fulfillPublicRoute(
      route,
      "https://example.com",
      false,
      check,
      aiProfile,
      true,
    );
    expect(abort).toHaveBeenCalledWith("blockedbyclient");
    expect(check).not.toHaveBeenCalled();
  });
  it("rechecks emergency controls for GET requests even in an approved transition", async () => {
    const abort = vi.fn().mockResolvedValue(undefined),
      check = vi.fn().mockResolvedValue(false);
    const route = {
      request: () => ({
        url: () => "https://example.com/next",
        method: () => "GET",
        postData: () => null,
      }),
      abort,
    } as unknown as Route;
    await fulfillPublicRoute(
      route,
      "https://example.com",
      true,
      check,
      aiProfile,
      true,
    );
    expect(abort).toHaveBeenCalledWith("blockedbyclient");
    expect(check).toHaveBeenCalledOnce();
  });
  it("rejects third-party destinations regardless of the transition window", async () => {
    const abort = vi.fn().mockResolvedValue(undefined),
      check = vi.fn().mockResolvedValue(true);
    const route = {
      request: () => ({
        url: () => "https://evil.invalid/collect",
        method: () => "GET",
        postData: () => null,
      }),
      abort,
    } as unknown as Route;
    await fulfillPublicRoute(
      route,
      "https://example.com",
      true,
      check,
      aiProfile,
      true,
    );
    expect(abort).toHaveBeenCalledWith("blockedbyclient");
  });
});

describe("negative or conflicting evidence is never a quiz answer", () => {
  it.each([
    "商品の特徴は無糖ではありません。",
    "無糖ではない商品です。",
    "無糖かもしれません。",
    "無糖ですとは言えません。",
  ])("refuses negated or uncertain source: %s", (quote) => {
    const campaign = aiCampaign();
    campaign.rules.evidence[0].quote = quote;
    expect(
      safeOptionAnswer(
        "無糖",
        quote,
        field({
          type: "radio",
          profileField: null,
          label: "無糖",
          question: "商品の特徴として正しいもの",
        }),
        campaign,
        aiPreferences(),
      ),
    ).toBe(false);
  });
  it("rejects contradictory verified alternatives even if the model cites one", () => {
    const campaign = aiCampaign();
    campaign.rules.evidence[1].quote = "商品の特徴は加糖です。";
    const data = snapshot([
      field({
        type: "radio",
        profileField: null,
        label: "無糖",
        question: "商品の特徴として正しいもの",
      }),
      field({
        ref: "f1",
        type: "radio",
        profileField: null,
        label: "加糖",
        question: "商品の特徴として正しいもの",
      }),
    ]);
    expect(() =>
      validateActionPlan(
        planForSnapshot(data),
        data,
        campaign,
        aiProfile,
        aiPreferences(),
      ),
    ).toThrow("conflicting-quiz-evidence");
  });
  it.each([
    "いつもこの商品を飲んでいます。試してみたいです。",
    "以前は毎週飲みました。期待します。",
    "この味が好きです。試してみたいです。",
  ])("refuses invented habitual preference: %s", (answer) => {
    expect(
      safeGeneratedAnswer(
        answer,
        "商品の特徴は無糖です。",
        field({
          type: "textarea",
          profileField: null,
          label: "試してみたい理由",
          maxLength: 100,
        }),
        aiCampaign(),
        aiProfile,
      ),
    ).toBe(false);
  });
});

describe("encoded private labels never reach the model", () => {
  it.each([
    encodeURIComponent(aiProfile.email),
    Buffer.from(aiProfile.name).toString("base64"),
    Buffer.from(aiProfile.address).toString("base64url"),
    "1990年1月1日",
    "1990/01/01",
    "090-0000-0000",
    "100-0001",
    "検証太郎",
  ])("rejects label %s before calling AI", async (label) => {
    const mock = fakeFormAI();
    await expect(
      planForm(
        mock.service,
        snapshot([field({ label })]),
        aiCampaign(),
        aiPreferences(),
        aiProfile,
      ),
    ).rejects.toThrow("個人情報");
    expect(mock.inputs).toHaveLength(0);
  });
});
