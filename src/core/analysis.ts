import type {
  Campaign,
  CampaignRules,
  Preferences,
  Profile,
  RuleEvidence,
} from "./types";
export interface TermsDocument {
  url: string;
  text: string;
  kind: RuleEvidence["kind"];
  fetchedAt: string;
}
export function hasUnsupportedEligibility(text: string): boolean {
  return /(?:東京都|北海道|大阪府|京都府|[一-龥]{2,5}[県市区町村])(?:に|内に)?(?:在住|居住|お住まい)[^。\n]{0,20}(?:限定|のみ|対象|限ります|方)|(?:女性|男性|学生|会社員|公務員|医療従事者|既婚者|未婚者)(?:の方)?(?:を)?(?:のみ|限定|対象)|\d{1,3}\s*歳(?:以下|未満|まで)|(?:従業員|関係者)[^。\n]{0,25}(?:応募できません|対象外|応募不可)/.test(
    text,
  );
}
export function analyzeRules(
  documents: TermsDocument[],
  options: {
    technicalAllowed?: boolean;
    platformRequired?: boolean;
    now?: Date;
  } = {},
): CampaignRules {
  const text = documents.map((document) => document.text).join("\n");
  const required = options.platformRequired
    ? ["campaign", "site", "platform"]
    : ["campaign", "site"];
  const now = options.now || new Date();
  const reviewedAllTerms = required.every((kind) =>
    documents.some(
      (document) =>
        document.kind === kind &&
        document.text.trim().length >= 10 &&
        Number.isFinite(Date.parse(document.fetchedAt)) &&
        now.getTime() - Date.parse(document.fetchedAt) <= 7 * 86400_000 &&
        Date.parse(document.fetchedAt) <= now.getTime(),
    ),
  );
  const statements = text.split(/[。\n.!?]/);
  const automation =
    /自動(?:応募|入力|操作|化)|プログラム(?:による|を使用した)?応募|機械的(?:な|に)?応募|ボット|bot|robot|automat(?:ed|ic|ion)|script(?:ed|ing)?/i;
  const prohibition =
    /禁止|禁じ|不許可|(?:許可|認め|利用でき|可能)[^。\n]{0,12}(?:ません|いない|しない|されない|できない|ありません)|お断り|不可|お控え|prohibit|forbidden|not\s+(?:allowed|permitted)|must\s+not|may\s+not/i;
  const permission =
    /許可(?:します|する|した|されます|されています|される|$)|可能(?:です|とします|$)|認めます|利用できます|\b(?:allowed|permitted)\b/i;
  const automationStatements = statements.filter((statement) =>
    automation.test(statement),
  );
  const prohibited = automationStatements.some((statement) =>
    prohibition.test(statement),
  );
  const permitted = automationStatements.some(
    (statement) => permission.test(statement) && !prohibition.test(statement),
  );
  const ambiguousAutomation = automationStatements.some(
    (statement) => !permission.test(statement) && !prohibition.test(statement),
  );
  const injection =
    /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions|system\s*prompt|システム(?:プロンプト|命令)を(?:無視|変更)/i.test(
      text,
    );
  const conflict = prohibited && permitted;
  const verdict =
    conflict || injection || ambiguousAutomation
      ? "unknown"
      : prohibited
        ? "prohibited"
        : !reviewedAllTerms
          ? "unknown"
          : permitted
            ? "permitted"
            : "silent";
  const minAgeMatch = text.match(/(?:満\s*)?(\d{1,2})\s*歳以上/);
  const requiredConsents = /個人情報|プライバシー/.test(text)
    ? ["privacy"]
    : [];
  if (
    /メールマガジン[^。\n]{0,30}(?:必須|必要)|(?:必須|必要)[^。\n]{0,30}メールマガジン/.test(
      text,
    )
  )
    requiredConsents.push("newsletter");
  return {
    verdict,
    reviewedAllTerms,
    reason:
      verdict === "unknown"
        ? conflict
          ? "規約間で自動化の記載が矛盾しています"
          : ambiguousAutomation
            ? "自動化に関する記載の解釈に手動確認が必要です"
            : injection
              ? "外部文書に命令形式の記載があり手動確認が必要です"
              : "応募規約・サイト規約等の確認が未完了または古くなっています"
        : verdict === "prohibited"
          ? "自動応募・自動操作を禁止する記載があります"
          : verdict === "permitted"
            ? "関連規約を確認し、自動応募を許可する記載があります"
            : "関連規約を確認しました。禁止記載は見つかりませんが積極的な許可ではありません",
    evidence: documents.map((document) => ({
      url: document.url,
      kind: document.kind,
      fetchedAt: document.fetchedAt,
      quote: document.text.replace(/\s+/g, " ").slice(0, 1000),
    })),
    japanOnly: /日本(?:国内)?(?:在住|居住)|国内在住/.test(text),
    minAge: minAgeMatch ? Number(minAgeMatch[1]) : null,
    eligibilityUnknown: hasUnsupportedEligibility(text),
    purchaseRequired:
      /(?:購入|レシート|バーコード)[^。\n]{0,20}(?:必要|必須)|(?:購入者|お買い上げの方)限定/.test(
        text,
      ) && !/購入(?:は)?不要/.test(text),
    membershipRequired:
      /(?:会員登録|ログイン)[^。\n]{0,20}(?:必要|必須)|会員限定/.test(text),
    snsRequired:
      /(?:フォロー|リポスト|リツイート|SNS投稿|LINE友だち追加|Instagram|X\s*\(旧Twitter\))/.test(
        text,
      ),
    captcha: /captcha|画像認証|私はロボットではありません/i.test(text),
    maxEntries: 1,
    requiredConsents,
    requiredFields: ["name", "email"],
    technicalAllowed:
      options.technicalAllowed === true &&
      !prohibited &&
      !injection &&
      !ambiguousAutomation &&
      reviewedAllTerms,
  };
}

export function decideEligibility(
  campaign: Campaign,
  profile: Profile | null,
  preferences: Preferences,
  now = new Date(),
): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!preferences.autoApply) reasons.push("自動応募がOFFです");
  if (preferences.emergencyStop) reasons.push("緊急停止中です");
  if (
    !preferences.consentAt ||
    !Number.isFinite(Date.parse(preferences.consentAt)) ||
    Date.parse(preferences.consentAt) > now.getTime()
  )
    reasons.push("個人情報の自動送信への事前同意が必要です");
  if (!profile) reasons.push("プロフィールが未登録です");
  if (
    campaign.rules.eligibilityUnknown ||
    hasUnsupportedEligibility(
      [
        ...campaign.conditions,
        ...campaign.rules.evidence.map((e) => e.quote),
      ].join("\n"),
    )
  ) {
    reasons.push(
      "地域・属性など、現在のプロフィールでは検証できない応募条件があります。手動確認してください",
    );
  }
  if (preferences.maxApplications < 1) reasons.push("応募上限が0件です");
  if (
    !preferences.categories.includes(campaign.category) ||
    preferences.excludedCategories.includes(campaign.category)
  )
    reasons.push("希望するカテゴリの対象外です");
  if (
    !Number.isFinite(Date.parse(campaign.deadline)) ||
    Date.parse(campaign.deadline) <= now.getTime()
  )
    reasons.push("締切済み、または期限不明です");
  if (
    campaign.startsAt &&
    (!Number.isFinite(Date.parse(campaign.startsAt)) ||
      Date.parse(campaign.startsAt) > now.getTime())
  )
    reasons.push("応募開始前です");
  if (!["permitted", "silent"].includes(campaign.rules.verdict))
    reasons.push("自動応募は禁止または規約が不明です");
  if (
    !campaign.rules.reviewedAllTerms ||
    !campaign.rules.evidence.length ||
    campaign.rules.evidence.some(
      (item) =>
        !Number.isFinite(Date.parse(item.fetchedAt)) ||
        now.getTime() - Date.parse(item.fetchedAt) > 7 * 86400_000 ||
        Date.parse(item.fetchedAt) > now.getTime(),
    )
  )
    reasons.push("最新の関連規約の確認が必要です");
  if (!campaign.rules.technicalAllowed || !campaign.adapterId)
    reasons.push("操作方法を確認したアダプターがありません");
  if (campaign.rules.purchaseRequired)
    reasons.push("購入条件は手動で確認してください");
  if (
    campaign.rules.membershipRequired ||
    campaign.rules.snsRequired ||
    campaign.rules.captcha
  )
    reasons.push("認証・SNS操作・CAPTCHAは手動で対応してください");
  if (
    campaign.rules.requiredConsents.some(
      (consent) => !preferences.approvedConsents.includes(consent),
    )
  )
    reasons.push("未承認の必須同意があります");
  if (profile) {
    if (
      campaign.rules.requiredFields.some(
        (field) =>
          !Object.hasOwn(profile, field) ||
          !String(profile[field as keyof Profile] || "").trim(),
      )
    )
      reasons.push("必要な個人情報が不足しています");
    if (campaign.rules.japanOnly && !profile.prefecture)
      reasons.push("国内在住条件を確認できません");
    if (campaign.rules.minAge !== null) {
      const birth = new Date(`${profile.birthDate}T00:00:00+09:00`);
      const todayJst = new Date(now.getTime() + 9 * 3600_000);
      const birthJst = new Date(birth.getTime() + 9 * 3600_000);
      let age = todayJst.getUTCFullYear() - birthJst.getUTCFullYear();
      if (
        todayJst.getUTCMonth() < birthJst.getUTCMonth() ||
        (todayJst.getUTCMonth() === birthJst.getUTCMonth() &&
          todayJst.getUTCDate() < birthJst.getUTCDate())
      )
        age--;
      if (!Number.isFinite(age) || age < campaign.rules.minAge)
        reasons.push("年齢条件を満たしていません");
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

/** Heuristic utility score. This is not a probability of winning. */
export function rankCampaign(campaign: Campaign, now = new Date()): number {
  const remaining = Date.parse(campaign.deadline) - now.getTime();
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  const categoryWeight = [
    "現金・ギフト券",
    "Amazonギフト券",
    "家電・ガジェット",
    "旅行・宿泊",
    "食品・飲料",
    "日用品",
    "その他",
  ].indexOf(campaign.category);
  const value = Math.log10(Math.max(0, campaign.estimatedValue) + 1) * 10;
  const winners = Math.log10(Math.max(0, campaign.winners) + 1) * 6;
  const effort = campaign.rules.purchaseRequired ? -20 : 10;
  const technical = campaign.rules.technicalAllowed ? 10 : 0;
  const urgency = Math.min(10, (7 * 86400_000) / remaining);
  return Math.max(
    0,
    Math.round(
      value +
        winners +
        effort +
        technical +
        urgency +
        Math.max(0, 7 - categoryWeight) * 2,
    ),
  );
}

/** Optional Gemini enrichment; the pure rule engine above remains the final authorization layer. */
export async function analyzeCampaignWithAI(
  campaign: Campaign,
  service: import("./ai-analysis").CampaignAIService,
): Promise<Campaign> {
  return (await import("./ai-analysis")).enrichCampaignWithAI(
    campaign,
    service,
  );
}
