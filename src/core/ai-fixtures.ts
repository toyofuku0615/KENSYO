import { createHash } from "node:crypto";
import type { Campaign } from "./types";

export const AI_FIXTURE_SOURCE_ID = "demo-ai-fixture";
/** Local fixtures are explicit opt-in sources, never real prizes or real-site adapters. */
export function aiFixtureCampaigns(
  sourceId: string,
  now = new Date(),
): Campaign[] {
  const variants = [
    "easy",
    "survey",
    "free",
    "quiz",
    "multi",
    "reordered",
    "ambiguous",
    "missing",
    "captcha",
    "prohibited",
  ];
  const names = [
    "基本フォーム",
    "カテゴリのアンケート",
    "自由記述",
    "根拠のあるクイズ",
    "複数ページ",
    "項目順の変更",
    "曖昧な必須項目",
    "回答できない必須項目",
    "CAPTCHAによる停止",
    "自動応募禁止による停止",
  ];
  return variants.map((variant, index) => {
    const url = `http://127.0.0.1:3000/ai-test-form/${variant}`;
    const stamp = now.toISOString();
    const prohibited = variant === "prohibited";
    return {
      id: createHash("sha256")
        .update(`ai-fixture:${variant}`)
        .digest("hex")
        .slice(0, 32),
      title: `【AIテスト】${names[index]}`,
      organizer: "Kensho Lab（架空）",
      officialUrl: url,
      entryUrl: url,
      imageUrl: null,
      prize: "検証用フォーム（実際の賞品はありません）",
      estimatedValue: 0,
      winners: 0,
      startsAt: null,
      deadline: new Date(now.getTime() + 14 * 86400000).toISOString(),
      category: "食品・飲料",
      conditions: [
        "ローカルの検証用フォームです",
        "商品の特徴は無糖です。",
        "実在する懸賞への応募ではありません",
      ],
      rules: {
        verdict: prohibited ? "prohibited" : "permitted",
        reason: prohibited
          ? "この模擬フォームは自動応募禁止を検証します"
          : "自作の検証用フォームで自動入力と応募を許可しています",
        evidence: [
          {
            url,
            kind: "campaign",
            quote: `検証用フォームです。商品の特徴は無糖です。${prohibited ? "自動応募を禁止します。" : "自動応募を許可します。"}個人情報の取扱いへの同意が必要です。`,
            fetchedAt: stamp,
          },
          {
            url,
            kind: "site",
            quote:
              "ローカルの検証サイトです。検証用プロフィールによる自動入力・応募を許可します。",
            fetchedAt: stamp,
          },
        ],
        reviewedAllTerms: true,
        japanOnly: true,
        minAge: null,
        purchaseRequired: false,
        membershipRequired: false,
        snsRequired: false,
        captcha: variant === "captcha",
        maxEntries: 1,
        requiredConsents: ["privacy"],
        requiredFields: ["name", "address", "email"],
        technicalAllowed: !prohibited,
      },
      sourceId,
      discoveredAt: stamp,
      checkedAt: stamp,
      adapterId: "generic-ai",
      isDemo: true,
    };
  });
}
