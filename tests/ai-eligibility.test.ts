import { describe, it, expect } from "vitest";
import {
  analyzeRules,
  hasUnsupportedEligibility,
  decideEligibility,
} from "../src/core/analysis";
import { aiFixtureCampaigns } from "../src/core/ai-fixtures";
import { DEFAULT_PREFERENCES } from "../src/core/types";
describe("unknown eligibility is never inferred from a fluent AI answer", () => {
  it.each([
    "東京都在住の方のみ応募できます",
    "女性限定のキャンペーンです",
    "65歳以下の方が対象です",
    "学生のみ応募可能です",
    "関係者は応募できません",
  ])("requires manual review for %s", (condition) => {
    expect(hasUnsupportedEligibility(condition)).toBe(true);
    const now = new Date().toISOString();
    const rules = analyzeRules(
      [
        {
          kind: "campaign" as const,
          url: "https://example.com/campaign",
          text: `自動応募を許可します。${condition}`,
          fetchedAt: now,
        },
        {
          kind: "site" as const,
          url: "https://example.com/terms",
          text: "このサイトでは自動入力と自動応募を許可します。",
          fetchedAt: now,
        },
      ],
      { technicalAllowed: true },
    );
    expect(rules.eligibilityUnknown).toBe(true);
  });
  it("retains ordinary nationwide age-minimum eligibility", () => {
    expect(
      hasUnsupportedEligibility("日本国内在住・18歳以上の方が応募できます。"),
    ).toBe(false);
  });
  it("blocks a saved campaign whose evidence gained an unsupported condition", () => {
    const campaign = aiFixtureCampaigns("test")[0];
    campaign.conditions.push("東京都在住の方のみ応募できます");
    const profile = {
      name: "検証 太郎",
      kana: "ケンショウ タロウ",
      postalCode: "1000001",
      prefecture: "東京都",
      address: "検証用住所",
      phone: "09000000000",
      email: "test@example.invalid",
      birthDate: "1990-01-01",
    };
    const result = decideEligibility(campaign, profile, {
      ...DEFAULT_PREFERENCES,
      autoApply: true,
      consentAt: new Date().toISOString(),
      approvedConsents: ["privacy"],
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(" ")).toContain("検証できない応募条件");
  });
});
