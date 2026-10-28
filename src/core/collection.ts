import { createHash } from "node:crypto";
import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { analyzeRules, type TermsDocument } from "./analysis";
import type { Campaign, Source } from "./types";
import { safeFetchText } from "./url-safety";

export function canonicalCampaignId(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (/^(?:utm_|fbclid|gclid|ref$)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  const hash = createHash("sha256").update(url.href).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/** Date-only Japanese deadlines end at 23:59:59 JST; never infer an absent year. */
export function parseJapaneseDeadline(text: string): string | null {
  const iso = text.match(
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})\b/,
  );
  if (iso && Number.isFinite(Date.parse(iso[0])))
    return new Date(iso[0]).toISOString();
  const matches = [
    ...text.matchAll(
      /(20\d{2})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*日?(?:[（(][^）)]{0,4}[）)])?(?:\s*(\d{1,2})[:時](\d{1,2})?分?)?/g,
    ),
  ];
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  const [year, month, day] = [last[1], last[2], last[3]].map(Number);
  const hour = last[4] === undefined ? 23 : Number(last[4]),
    minute =
      last[5] === undefined
        ? last[4] === undefined
          ? 59
          : 0
        : Number(last[5]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59
  )
    return null;
  const timestamp = Date.UTC(
    year,
    month - 1,
    day,
    hour - 9,
    minute,
    last[4] === undefined ? 59 : 0,
  );
  const check = new Date(timestamp + 9 * 3600_000);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    return null;
  return new Date(timestamp).toISOString();
}

export function visibleText(html: string): string {
  const $ = load(html);
  $("script,style,noscript,iframe,template").remove();
  return $("body").text().replace(/\s+/g, " ").trim().slice(0, 100_000);
}

export function extractCampaign(
  html: string,
  url: string,
  sourceId: string,
  documents: TermsDocument[] = [],
  now = new Date(),
): Campaign | null {
  const $ = load(html);
  const text = visibleText(html);
  const title = (
    $("h1").first().text() ||
    $("meta[property='og:title']").attr("content") ||
    $("title").text()
  )
    .trim()
    .slice(0, 250);
  if (
    !title ||
    !/(?:懸賞|プレゼント|キャンペーン|抽選|賞品)/.test(title + text)
  )
    return null;
  const deadlineText =
    $("[data-deadline]").first().attr("data-deadline") ||
    $("time[itemprop='endDate']").attr("datetime") ||
    text.match(
      /(?:応募締切|応募期間|応募期限|締め切り|締切|締め切|開催期間)[\s\S]{0,120}/,
    )?.[0] ||
    "";
  const deadline = parseJapaneseDeadline(deadlineText);
  if (!deadline || Date.parse(deadline) <= now.getTime()) return null;
  const startsText = $("[data-starts-at]").attr("data-starts-at");
  const startsAt = startsText ? parseJapaneseDeadline(startsText) : null;
  const prize = (
    $("[data-prize]").first().attr("data-prize") ||
    text.match(/(?:賞品|プレゼント内容)\s*[:：]?\s*([^。]{1,100})/)?.[1] ||
    title
  ).slice(0, 200);
  const amount =
    $("[data-value]").attr("data-value") ||
    text.match(/(?:賞品価値|相当|総額)\s*[:：]?\s*([\d,]+)\s*円/)?.[1];
  const winnersText =
    $("[data-winners]").attr("data-winners") ||
    text.match(/(?:抽選で|当選人数|当選者)\s*[:：]?\s*([\d,]+)\s*名/)?.[1];
  const category = /Amazon/i.test(prize)
    ? "Amazonギフト券"
    : /現金|ギフト|商品券|金券/.test(prize)
      ? "現金・ギフト券"
      : /家電|イヤホン|パソコン|ガジェット|掃除機/.test(prize)
        ? "家電・ガジェット"
        : /旅行|宿泊|ホテル/.test(prize)
          ? "旅行・宿泊"
          : /食品|飲料|お菓子|肉|ビール|米/.test(prize)
            ? "食品・飲料"
            : /日用品|洗剤/.test(prize)
              ? "日用品"
              : "その他";
  const entryLink = $("a")
    .toArray()
    .find((element) =>
      /応募(?:はこちら|する|ページ|フォーム)/.test($(element).text()),
    );
  let entryUrl = url;
  try {
    if (entryLink && $(entryLink).attr("href"))
      entryUrl = new URL($(entryLink).attr("href")!, url).href;
  } catch {
    /* keep official URL */
  }
  if (!/^https:\/\//.test(entryUrl)) entryUrl = url;
  const imageRaw = $("meta[property='og:image']").attr("content");
  let imageUrl: string | null = null;
  try {
    const image = new URL(imageRaw || "", url);
    if (
      imageRaw &&
      image.protocol === "https:" &&
      image.hostname === new URL(url).hostname &&
      !image.username &&
      !image.password
    )
      imageUrl = image.href;
  } catch {
    /* no remote image */
  }
  const rules = analyzeRules(documents, {
    technicalAllowed: false,
    platformRequired: /Instagram|Twitter|X\s*\(旧|LINE|SNS/.test(text),
    now,
  });
  return {
    id: canonicalCampaignId(url),
    title,
    organizer: (
      $("[data-organizer]").attr("data-organizer") ||
      $("meta[property='og:site_name']").attr("content") ||
      new URL(url).hostname
    ).slice(0, 100),
    officialUrl: url,
    entryUrl,
    imageUrl,
    prize,
    estimatedValue: Math.max(
      0,
      Math.min(100_000_000, Number((amount || "0").replace(/,/g, "")) || 0),
    ),
    winners: Math.max(
      0,
      Math.min(10_000_000, Number((winnersText || "0").replace(/,/g, "")) || 0),
    ),
    startsAt,
    deadline,
    category,
    conditions: [
      rules.japanOnly ? "日本国内在住" : "応募資格は規約を確認",
      rules.purchaseRequired ? "購入条件あり" : "購入条件は根拠を確認",
      rules.reason,
    ],
    rules,
    sourceId,
    discoveredAt: now.toISOString(),
    checkedAt: now.toISOString(),
    adapterId: null,
    isDemo: false,
  };
}

function linksByText(
  html: string,
  base: string,
  pattern: RegExp,
  allowedHosts: string[],
): string[] {
  const $ = load(html);
  const links: string[] = [];
  $("a[href]").each((_, element) => {
    if (!pattern.test($(element).text())) return;
    try {
      const url = new URL($(element).attr("href")!, base);
      if (
        url.protocol === "https:" &&
        allowedHosts.includes(url.hostname) &&
        !url.username &&
        !url.password
      )
        links.push(url.href);
    } catch {
      /* invalid links are external data */
    }
  });
  return [...new Set(links)].slice(0, 5);
}

export function parseRssLinks(xml: string): string[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("外部実体を含む XML は解析しません");
  const parser = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
  });
  const doc = parser.parse(xml);
  const items = doc?.rss?.channel?.item || doc?.feed?.entry || [];
  const array = Array.isArray(items) ? items : [items];
  return array
    .flatMap((item: Record<string, unknown>) => {
      const links = Array.isArray(item.link) ? item.link : [item.link];
      return links.flatMap((link: unknown) =>
        typeof link === "string"
          ? [link]
          : link && typeof link === "object" && "@_href" in link
            ? [String(link["@_href"])]
            : [],
      );
    })
    .filter((value: string) => /^https:\/\//.test(value))
    .slice(0, 20);
}

async function officialCampaign(
  raw: string,
  source: Source,
): Promise<Campaign | null> {
  const initial = await safeFetchText(raw, source.allowedHosts);
  const officialLinks = linksByText(
    initial.text,
    initial.url,
    /公式(?:サイト|ページ)|キャンペーン(?:サイト|ページ)|応募ページ/,
    source.allowedHosts,
  );
  // A third-party listing can identify the official page, but it never supplies operative terms.
  const official = officialLinks.find(
    (link) => new URL(link).hostname !== new URL(initial.url).hostname,
  );
  const page = official
    ? await safeFetchText(official, source.allowedHosts)
    : initial;
  const now = new Date();
  const documents: TermsDocument[] = [
    {
      url: page.url,
      text: visibleText(page.text),
      kind: "campaign",
      fetchedAt: now.toISOString(),
    },
  ];
  for (const link of linksByText(
    page.text,
    page.url,
    /応募規約|キャンペーン規約|利用規約|利用条件|自動化ポリシー|プラットフォーム規約/,
    source.allowedHosts,
  )) {
    try {
      const response = await safeFetchText(link, source.allowedHosts);
      const $ = load(page.text);
      const anchorText = $("a")
        .toArray()
        .filter((element) => {
          try {
            return (
              new URL($(element).attr("href") || "", page.url).href === link
            );
          } catch {
            return false;
          }
        })
        .map((element) => $(element).text())
        .join(" ");
      documents.push({
        url: response.url,
        text: visibleText(response.text),
        kind: /プラットフォーム/.test(anchorText)
          ? "platform"
          : /応募|キャンペーン/.test(anchorText)
            ? "campaign"
            : "site",
        fetchedAt: new Date().toISOString(),
      });
    } catch {
      /* missing related terms deliberately leads to unknown */
    }
  }
  return extractCampaign(page.text, page.url, source.id, documents, now);
}

export function fixtureCampaigns(
  sourceId = "demo-source",
  now = new Date(),
): Campaign[] {
  const fetchedAt = now.toISOString();
  const deadline = new Date(now.getTime() + 14 * 86400_000).toISOString();
  const documents: TermsDocument[] = [
    {
      url: "http://127.0.0.1:3000/test-form",
      kind: "campaign",
      text: "テスト専用の応募フォームです。自動応募を許可します。日本国内在住、18歳以上。個人情報の取り扱いに同意してください。1人1回。",
      fetchedAt,
    },
    {
      url: "http://127.0.0.1:3000/test-form",
      kind: "site",
      text: "このローカル検証サイトでは自動入力と自動応募を許可します。外部には送信しません。",
      fetchedAt,
    },
  ];
  const rules = analyzeRules(documents, { technicalAllowed: true, now });
  rules.requiredFields = [
    "name",
    "kana",
    "postalCode",
    "prefecture",
    "address",
    "phone",
    "email",
    "birthDate",
  ];
  const base: Campaign = {
    id: canonicalCampaignId("https://demo.kensho.example/campaign/gift"),
    title: "【テスト】春のギフト券プレゼント",
    organizer: "Kensho Lab（架空）",
    officialUrl: "http://127.0.0.1:3000/test-form",
    entryUrl: "http://127.0.0.1:3000/test-form",
    imageUrl: null,
    prize: "デモ用ギフト券（実際の賞品はありません）",
    estimatedValue: 10000,
    winners: 100,
    startsAt: null,
    deadline,
    category: "現金・ギフト券",
    conditions: [
      "テストデータ",
      "日本国内在住・18歳以上",
      "実際の懸賞応募ではありません",
    ],
    rules,
    sourceId,
    discoveredAt: fetchedAt,
    checkedAt: fetchedAt,
    adapterId: "local-test",
    isDemo: true,
  };
  const manual: Campaign = {
    ...base,
    id: canonicalCampaignId("https://demo.kensho.example/campaign/coffee"),
    title: "【テスト】コーヒーセットが当たる",
    prize: "デモ用コーヒーセット",
    estimatedValue: 3000,
    winners: 20,
    category: "食品・飲料",
    adapterId: null,
    rules: {
      ...rules,
      verdict: "unknown",
      reviewedAllTerms: false,
      technicalAllowed: false,
      reason: "関連規約を確認できないため手動確認が必要です",
      evidence: [],
    },
  };
  return [base, manual];
}

/** Sources are opt-in and exact-host approved; failures propagate for job-run accounting. */
export async function collectSource(source: Source): Promise<Campaign[]> {
  if (!source.enabled) return [];
  if (!source.termsAccepted)
    throw new Error("収集先の利用条件を確認してください");
  if (source.kind === "fixture") {
    if (
      process.env.KENSHO_MODE !== "demo" &&
      process.env.NODE_ENV === "production"
    )
      throw new Error("本番環境でテスト収集は無効です");
    return fixtureCampaigns(source.id);
  }
  if (!source.allowedHosts.length)
    throw new Error("取得を許可するホストが未設定です");
  const feed = await safeFetchText(source.url, source.allowedHosts);
  const links =
    source.kind === "rss"
      ? parseRssLinks(feed.text)
      : linksByText(
          feed.text,
          feed.url,
          /プレゼント|懸賞|キャンペーン|抽選/,
          source.allowedHosts,
        );
  const targets = [
    ...new Set([...(source.kind === "html" ? [feed.url] : []), ...links]),
  ].slice(0, 20);
  const deduplicated = new Map<string, Campaign>();
  const errors: string[] = [];
  for (const target of targets) {
    try {
      const campaign = await officialCampaign(target, source);
      if (campaign) deduplicated.set(campaign.id, campaign);
    } catch {
      errors.push("対象ページの取得・規約確認に失敗しました");
    }
  }
  // Do not silently turn partial-source failure into an entirely successful collection.
  if (errors.length)
    throw new Error(
      `${errors.length} 件の対象ページで取得に失敗しました（ホスト承認・robots・接続状態を確認）`,
    );
  return [...deduplicated.values()];
}
