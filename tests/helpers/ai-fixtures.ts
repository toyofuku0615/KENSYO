import type { AIStatus } from "../../src/lib/ai/provider";
import { DEFAULT_AI_SETTINGS, type AIPurpose } from "../../src/core/ai-types";
import {
  DEFAULT_PREFERENCES,
  type Campaign,
  type Preferences,
  type Profile,
} from "../../src/core/types";
import type {
  ActionPlan,
  GenerativeAI,
} from "../../src/automation/action-planner";
import type { FormSnapshot } from "../../src/automation/form-analyzer";
import type { z } from "zod";

export const aiProfile: Profile = {
  name: "検証 太郎",
  kana: "ケンショウ タロウ",
  postalCode: "1000001",
  prefecture: "東京都",
  address: "検証専用住所",
  phone: "09000000000",
  email: "ai-fixture@example.invalid",
  birthDate: "1990-01-01",
};
export function aiPreferences(): Preferences {
  return {
    ...DEFAULT_PREFERENCES,
    autoApply: true,
    consentAt: new Date(Date.now() - 1000).toISOString(),
    approvedConsents: ["privacy"],
    categories: ["食品・飲料"],
  };
}
export function aiCampaign(variant = "easy"): Campaign {
  const now = new Date().toISOString(),
    url = `http://127.0.0.1:3000/ai-test-form/${variant}`;
  return {
    id: `ai-browser-${variant}`,
    title: "AIフォーム検証",
    organizer: "架空の検証主催",
    officialUrl: url,
    entryUrl: url,
    imageUrl: null,
    prize: "検証用コーヒー",
    estimatedValue: 0,
    winners: 1,
    startsAt: null,
    deadline: new Date(Date.now() + 86400000).toISOString(),
    category: "食品・飲料",
    conditions: ["商品の特徴は無糖です。"],
    rules: {
      verdict: variant === "prohibited" ? "prohibited" : "permitted",
      reason: "自作フォーム検証用",
      evidence: [
        {
          url,
          quote:
            "商品の特徴は無糖です。自動応募を許可します。個人情報の取り扱いに同意してください。",
          kind: "campaign",
          fetchedAt: now,
        },
        {
          url,
          quote: "この検証サイトは自動入力を許可します。",
          kind: "site",
          fetchedAt: now,
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
      requiredFields: ["name", "address", "email"],
      technicalAllowed: true,
    },
    sourceId: "ai-fixture",
    discoveredAt: now,
    checkedAt: now,
    adapterId: "generic-ai",
    isDemo: true,
  };
}
export function planForSnapshot(snapshot: FormSnapshot): ActionPlan {
  const actions: ActionPlan["actions"] = [];
  let radioChosen = false;
  for (const field of snapshot.fields) {
    if (field.profileField) {
      actions.push({
        type: "fill_profile_field",
        ref: field.ref,
        field: field.profileField,
      });
      continue;
    }
    if (field.type === "checkbox") {
      if (field.required && /個人情報/.test(field.label))
        actions.push({
          type: "check_approved_consent",
          ref: field.ref,
          consent: "privacy",
        });
      else if (field.required)
        return { actions: [], manualReason: "未承認の必須同意です" };
      continue;
    }
    if (field.type === "select") {
      const selected = field.options.find((o) => o.label === "食品・飲料");
      if (selected) {
        actions.push({
          type: "select_option",
          ref: field.ref,
          optionRef: selected.ref,
          evidenceQuote: "",
        });
        continue;
      }
    }
    if (field.type === "textarea") {
      actions.push({
        type: "fill_generated_answer",
        ref: field.ref,
        answer: "無糖の味わいを試してみたいです。",
        evidenceQuote: "商品の特徴は無糖です。",
      });
      continue;
    }
    if (field.type === "radio") {
      if (field.label === "無糖" && !radioChosen) {
        actions.push({
          type: "select_radio",
          ref: field.ref,
          evidenceQuote: "商品の特徴は無糖です。",
        });
        radioChosen = true;
      }
      continue;
    }
    if (field.required)
      return { actions: [], manualReason: "必須項目に回答できません" };
  }
  const button =
    snapshot.buttons.find((b) => b.kind === "next") ??
    snapshot.buttons.find((b) => b.kind === "submit");
  if (!button)
    return { actions: [], manualReason: "確認できる遷移ボタンがありません" };
  actions.push({
    type: button.kind === "next" ? "click_next" : "submit_application",
    ref: button.ref,
  });
  return { actions, manualReason: null };
}
export function fakeFormAI() {
  const inputs: unknown[] = [];
  const service: GenerativeAI & { getStatus: () => Promise<AIStatus> } = {
    async getStatus() {
      return {
        settings: {
          ...DEFAULT_AI_SETTINGS,
          enabled: true,
          model: "mock-public-model",
          freeTierAcknowledged: true,
        },
        connection: {
          status: "success",
          checkedAt: new Date().toISOString(),
          error: null,
        },
        usage: {
          todayCalls: 0,
          monthCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          successes: 0,
          failures: 0,
          analysisSuccesses: 0,
          analysisFailures: 0,
          cachedHits: 0,
          lastError: null,
          estimatedTokens: false,
          cooldownUntil: null,
        },
        keyConfigured: true,
        keySource: "stored",
        provider: "Google Gemini",
      };
    },
    async generate<T>(
      purpose: AIPurpose,
      input: unknown,
      schema: z.ZodType<T>,
    ) {
      if (purpose !== "form") throw new Error("Unexpected mock purpose");
      inputs.push(input);
      return schema.parse(
        planForSnapshot((input as { form: FormSnapshot }).form),
      );
    },
  };
  return { service, inputs };
}
