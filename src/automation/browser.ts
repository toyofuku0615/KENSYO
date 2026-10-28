import { submitWithGenericBrowser } from "./executor";
import { canUseGenericCampaign } from "./submission-validator";
import type { GenerativeAI } from "./action-planner";
import { chromium, type Page } from "playwright";
import type { Campaign, Preferences, Profile } from "../core/types";
import {
  buildGenericPlan,
  formPlanSchema,
  LOCAL_TEST_PLAN,
  type FormPlan,
  type ObservedField,
} from "./plan";

export interface SubmissionResult {
  status:
    "submitted" | "manual_required" | "blocked" | "failed" | "unknown_result";
  receipt: string | null;
  error: string | null;
}
export interface SubmissionInput {
  ai?: GenerativeAI;
  campaign: Campaign;
  profile: Profile;
  preferences: Preferences;
  /** Re-read DB controls immediately before every potentially submitting click. */
  finalCheck: () => Promise<boolean>;
}
export type Submitter = (input: SubmissionInput) => Promise<SubmissionResult>;

export function testFormOrigin(): string {
  const u = new URL(process.env.TEST_FORM_ORIGIN ?? "http://127.0.0.1:3000");
  if (
    u.protocol !== "http:" ||
    u.hostname !== "127.0.0.1" ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw new Error("TEST_FORM_ORIGIN must be a loopback HTTP origin");
  return u.origin;
}
export function supportsCampaign(campaign: Campaign): boolean {
  // Production adapters are code-reviewed registrations, not identifiers supplied by scraped HTML.
  return (
    (campaign.isDemo && campaign.adapterId === "local-test") ||
    canUseGenericCampaign(campaign)
  );
}
export function fixtureRequestAllowed(
  raw: string,
  origin = testFormOrigin(),
): boolean {
  try {
    const u = new URL(raw);
    return (
      u.origin === origin &&
      !u.username &&
      !u.password &&
      (u.pathname === "/test-form" ||
        u.pathname === "/test-form/complete" ||
        u.pathname === "/api/test-submit" ||
        u.pathname.startsWith("/_next/"))
    );
  } catch {
    return false;
  }
}
async function detectFields(page: Page): Promise<ObservedField[]> {
  return page.locator("input,select,textarea").evaluateAll((elements) =>
    elements.map((element) => {
      const field = element as HTMLInputElement;
      const labels = field.labels;
      const labelClone = labels?.[0]?.cloneNode(true) as
        HTMLElement | undefined;
      labelClone
        ?.querySelectorAll("input,select,textarea,button")
        .forEach((child) => child.remove());
      return {
        label:
          labelClone?.textContent?.trim() ??
          field.getAttribute("aria-label") ??
          "",
        type: field.tagName === "SELECT" ? "select" : field.type || "text",
        required:
          field.required || field.getAttribute("aria-required") === "true",
        checked: field.type === "checkbox" ? field.checked : undefined,
      };
    }),
  );
}
export async function executePlan(
  page: Page,
  untrustedPlan: FormPlan,
  profile: Profile,
  preferences: Preferences,
): Promise<void> {
  const plan = formPlanSchema.parse(untrustedPlan);
  for (const op of plan.operations) {
    const locator = page.getByLabel(op.label, { exact: op.type !== "select" });
    if ((await locator.count()) !== 1) throw new Error("ambiguous-field");
    if (op.type === "consent") {
      if (!preferences.approvedConsents.includes(op.consent))
        throw new Error("unapproved-consent");
      await locator.check();
    } else {
      const value = profile[op.field];
      if (!value) throw new Error("missing-profile-field");
      if (op.type === "select") await locator.selectOption({ label: value });
      else if (op.type === "radio") {
        if (op.option !== value) throw new Error("unmapped-radio-option");
        await page.getByRole("radio", { name: op.label, exact: true }).check();
      } else await locator.fill(value);
    }
  }
}
export const submitWithBrowser: Submitter = async (input) => {
  if (input.campaign.adapterId === "generic-ai")
    return submitWithGenericBrowser(input);
  const { campaign, profile, preferences, finalCheck } = input;
  const result = (
    status: SubmissionResult["status"],
    error: string | null,
    receipt: string | null = null,
  ): SubmissionResult => ({ status, error, receipt });
  if (!supportsCampaign(campaign))
    return result("manual_required", "サイト専用アダプターの確認が必要です");
  if (
    !preferences.autoApply ||
    !preferences.consentAt ||
    preferences.emergencyStop
  )
    return result("blocked", "自動応募が停止されています");
  if (
    !campaign.rules.reviewedAllTerms ||
    !campaign.rules.technicalAllowed ||
    !["permitted", "silent"].includes(campaign.rules.verdict)
  )
    return result("blocked", "規約または操作条件を満たしません");
  if (
    campaign.rules.requiredConsents.some(
      (c) => !preferences.approvedConsents.includes(c),
    )
  )
    return result("blocked", "必須同意が承認されていません");
  let clicked = false;
  let browser;
  try {
    const origin = testFormOrigin();
    // isDemo alone cannot grant a network exception: this adapter can only visit our own fixture.
    const entryUrl = new URL(campaign.entryUrl);
    if (
      entryUrl.hostname !== "127.0.0.1" ||
      entryUrl.protocol !== "http:" ||
      entryUrl.pathname !== "/test-form" ||
      entryUrl.search ||
      entryUrl.hash ||
      entryUrl.username ||
      entryUrl.password
    )
      return result("blocked", "テストフォームのURLが不正です");
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    });
    const context = await browser.newContext({
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    context.setDefaultTimeout(10_000);
    await context.route("**/*", async (route) => {
      if (fixtureRequestAllowed(route.request().url(), origin))
        await route.continue();
      else await route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    await page.goto(`${origin}/test-form`, {
      waitUntil: "networkidle",
      timeout: 20_000,
    });
    if (
      await page
        .locator(
          'iframe[src*="captcha"],iframe[title*="CAPTCHA"],[data-sitekey]',
        )
        .count()
    )
      return result("manual_required", "CAPTCHA は本人操作が必要です");
    const fields = await detectFields(page);
    const generic = buildGenericPlan(
      fields,
      profile,
      preferences.approvedConsents,
    );
    if (!generic.plan)
      return result("manual_required", generic.reasons.join("・"));
    await executePlan(page, LOCAL_TEST_PLAN, profile, preferences);
    if (
      !(await page
        .locator("form")
        .evaluateAll((forms) =>
          forms.every((form) => (form as HTMLFormElement).checkValidity()),
        ))
    )
      return result("failed", "フォームの入力検証に失敗しました");
    if (!(await finalCheck()))
      return result("blocked", "送信直前の安全確認で停止しました");
    // Confirmation can submit a form on some sites. Once clicked, any uncertainty is non-retryable.
    clicked = true;
    await page
      .getByRole("button", { name: LOCAL_TEST_PLAN.confirmLabel, exact: true })
      .click();
    await page
      .getByRole("button", { name: LOCAL_TEST_PLAN.submitLabel, exact: true })
      .waitFor({ state: "visible" });
    if (!(await finalCheck()))
      return result("blocked", "送信直前の安全確認で停止しました");
    await page
      .getByRole("button", { name: LOCAL_TEST_PLAN.submitLabel, exact: true })
      .click();
    await Promise.race([
      page
        .getByRole("heading", { name: "応募を受け付けました", exact: true })
        .waitFor({ timeout: 15_000 }),
      page
        .getByRole("alert")
        .filter({ hasText: "フォームエラー" })
        .waitFor({ timeout: 15_000 }),
    ]);
    if (
      await page
        .getByRole("alert")
        .filter({ hasText: "フォームエラー" })
        .count()
    )
      return result("failed", "フォームが入力内容を受け付けませんでした");
    const receiptText =
      (await page.getByTestId("receipt").textContent())?.trim() ?? "";
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(receiptText))
      return result("unknown_result", "受付情報を検証できませんでした");
    return result("submitted", null, receiptText);
  } catch {
    // Never persist raw browser errors: selectors, page text, requests can contain PII.
    return result(
      clicked ? "unknown_result" : "failed",
      clicked
        ? "送信結果を確認できませんでした。自動再送しません"
        : "ブラウザ操作を完了できませんでした",
    );
  } finally {
    await browser?.close().catch(() => undefined);
  }
};
