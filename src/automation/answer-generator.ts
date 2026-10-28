import type { Campaign, Preferences, Profile } from "../core/types";
import type { ObservedControl } from "./form-analyzer";

export function publicEvidence(campaign: Campaign): string[] {
  return campaign.rules.evidence
    .map((e) => e.quote)
    .filter((s) => s.trim().length > 0)
    .slice(0, 12);
}
export function evidenceSupports(campaign: Campaign, quote: string): boolean {
  return (
    quote.trim().length >= 2 &&
    publicEvidence(campaign).some((text) => text.includes(quote))
  );
}
export function safeGeneratedAnswer(
  answer: string,
  quote: string,
  field: ObservedControl,
  campaign: Campaign,
  profile: Profile,
): boolean {
  if (
    !answer.trim() ||
    answer.length > (field.maxLength ?? 300) ||
    answer.length > 500
  )
    return false;
  if (
    !/(?:理由|使ってみたい|期待|感想|メッセージ)/.test(
      field.question + field.label,
    )
  )
    return false;
  // Do not fabricate the user's experience, purchases, ownership or identity.
  if (
    /(?:買った|購入した|購入しました|使った|使っています|使い続け|飲んでいます|いつも|普段|愛用|愛飲|気に入|お気に入り|好きです|利用してい|毎日飲|食べた|試した|持ってい|経験|住んでい|歳です|勤務|家族は|ました|ていた|でした)/.test(
      answer,
    )
  )
    return false;
  if (
    !/(?:試してみたい|使ってみたい|楽しみ|期待|知りたい|味わってみたい)/.test(
      answer,
    )
  )
    return false;
  if (
    /(?:使用歴|購入歴|経験|使った|買った|購入した|使用した|利用歴|これまで|いつから|何年)/.test(
      field.question + field.label,
    )
  )
    return false;
  if (
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+81|0\d{1,4})[-\s]?\d{2,4}[-\s]?\d{4}/i.test(
      answer,
    )
  )
    return false;
  if (
    Object.values(profile).some((v) => v && v.length >= 3 && answer.includes(v))
  )
    return false;
  return evidenceSupports(campaign, quote);
}
export function safeOptionAnswer(
  option: string,
  quote: string,
  field: ObservedControl,
  campaign: Campaign,
  preferences: Preferences,
): boolean {
  const question = field.question || field.label;
  if (
    /広告|メールマガジン|メルマガ|ニュースレター|配信|販促|プロモーション|第三者提供|購入|契約|有料/.test(
      question + option,
    )
  )
    return false;
  if (/クイズ|正しい|特徴|答え/.test(question))
    return (
      evidenceSupports(campaign, quote) &&
      quote.includes(option) &&
      !/(?:では(?:あり)?ません|ではない|ではなく|ありません|含まない|含みません|誤り|不正解|違います|除く|不明|未確認|推測|かもしれ|とは言え)/.test(
        quote,
      )
    );
  if (/好き|好み|希望|カテゴリ/.test(question))
    return preferences.categories.includes(option.trim());
  return false;
}
/** Conflicting published alternatives cannot be resolved by model confidence. */
export function hasConflictingQuizEvidence(
  option: string,
  alternatives: string[],
  campaign: Campaign,
): boolean {
  return alternatives.some(
    (other) =>
      other !== option &&
      !!other.trim() &&
      publicEvidence(campaign).some((text) => text.includes(other)),
  );
}
