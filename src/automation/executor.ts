import { chromium, type Page } from "playwright";
import type { SubmissionInput, SubmissionResult } from "./browser";
import type { GenerativeAI, ActionPlan } from "./action-planner";
import { planForm } from "./action-planner";
import {
  currentElement,
  inspectForm,
  verifyCapturedForm,
  type FormSnapshot,
} from "./form-analyzer";
import {
  validateActionPlan,
  validateGenericInput,
  fulfillPublicRoute,
  localAIOrigin,
} from "./submission-validator";
export interface GenericSubmissionInput extends SubmissionInput {
  ai?: GenerativeAI;
}
const completionHeading =
  /^(?:応募を受け付けました|ご応募ありがとうございます|応募が完了しました|応募完了|送信が完了しました|受付完了|Application (?:received|complete)|Submission (?:received|complete))$/i;
/** A completion view is evidence only after this execution attempted the validated final submit. */
export async function readSubmissionEvidence(
  page: Page,
  finalSubmissionAttempted: boolean,
  possibleSend = false,
): Promise<SubmissionResult | null> {
  if (!(await page.getByRole("heading", { name: completionHeading }).count()))
    return null;
  if (!finalSubmissionAttempted)
    return {
      status: possibleSend ? "unknown_result" : "manual_required",
      receipt: null,
      error: "送信操作に対応する受付情報を確認できません。自動再送しません",
    };
  let receipt = "";
  const dedicated = page.getByTestId("receipt");
  if ((await dedicated.count()) === 1)
    receipt = (await dedicated.textContent())?.trim() || "";
  else {
    const labelled = page.getByText(
      /^受付(?:番号|ID)\s*[:：]\s*[A-Za-z0-9_-]{1,100}$/,
    );
    if ((await labelled.count()) === 1)
      receipt = ((await labelled.textContent()) || "")
        .replace(/^受付(?:番号|ID)\s*[:：]\s*/, "")
        .trim();
  }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(receipt))
    return {
      status: "unknown_result",
      receipt: null,
      error: "受付番号を検証できません。自動再送しません",
    };
  return { status: "submitted", receipt, error: null };
}
export async function executeActions(
  page: Page,
  plan: ActionPlan,
  snapshot: FormSnapshot,
  input: SubmissionInput,
): Promise<"next" | "submit"> {
  for (const action of plan.actions) {
    if (action.type === "inspect_page" || action.type === "verify_submission")
      continue;
    if (action.type === "click_next" || action.type === "submit_application")
      return action.type === "click_next" ? "next" : "submit";
    const field = snapshot.fields.find((f) => f.ref === action.ref)!;
    const element = await currentElement(page, field.ref);
    if (action.type === "fill_profile_field") {
      const value = input.profile[action.field]!;
      if (field.type === "select") {
        const options = await element.evaluate((element) =>
          [...(element as HTMLSelectElement).options].map(
            (option) => option.textContent || "",
          ),
        );
        const matches = options.filter((v) => v.trim() === value);
        if (matches.length !== 1) throw new Error("Ambiguous profile option");
        await element.selectOption({ label: value });
      } else await element.fill(value);
    } else if (action.type === "fill_generated_answer")
      await element.fill(action.answer);
    else if (action.type === "select_option") {
      const index = Number(action.optionRef.slice(1));
      await element.selectOption({ index });
    } else if (
      action.type === "select_radio" ||
      action.type === "check_approved_consent"
    )
      await element.check();
  }
  throw new Error("Missing transition");
}
export async function submitWithGenericBrowser(
  input: GenericSubmissionInput,
): Promise<SubmissionResult> {
  const result = (
    status: SubmissionResult["status"],
    error: string | null,
    receipt: string | null = null,
  ): SubmissionResult => ({ status, error, receipt });
  if (!input.ai)
    return result("manual_required", "Geminiの設定・接続が必要です");
  if (!validateGenericInput(input.campaign, input.profile, input.preferences))
    return result("blocked", "応募条件・規約・操作許可を満たしません");
  let browser;
  let possibleSend = false;
  let sendingWindow = false;
  let networkFrozen = false;
  let finalSubmissionAttempted = false;
  try {
    const c = input.campaign;
    const entry = new URL(c.entryUrl);
    if (c.isDemo && entry.origin !== localAIOrigin())
      return result("blocked", "検証先のURLが不正です");
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
    context.setDefaultTimeout(8000);
    await context.routeWebSocket("**/*", (ws) => ws.close());
    await context.route("**/*", async (route) => {
      try {
        const req = route.request(),
          url = new URL(req.url());
        if (c.isDemo) {
          const allowed =
            url.origin === entry.origin &&
            (url.pathname.startsWith("/ai-test-form/") ||
              url.pathname === "/api/ai-test-submit" ||
              url.pathname.startsWith("/_next/"));
          if (!allowed) {
            await route.abort("blockedbyclient");
            return;
          }
          if (
            (networkFrozen && !sendingWindow) ||
            (req.method() !== "GET" && !sendingWindow) ||
            (sendingWindow && !(await input.finalCheck()))
          ) {
            await route.abort("blockedbyclient");
            return;
          }
          await route.continue();
        } else
          await fulfillPublicRoute(
            route,
            entry.origin,
            sendingWindow,
            input.finalCheck,
            input.profile,
            networkFrozen,
          );
      } catch {
        await route.abort("blockedbyclient").catch(() => undefined);
      }
    });
    const page = await context.newPage();
    await page.goto(entry.href, { waitUntil: "networkidle", timeout: 20000 });
    const started = Date.now();
    const seen = new Set<string>();
    for (let step = 0; step < 6 && Date.now() - started < 90000; step++) {
      const completion = await readSubmissionEvidence(
        page,
        finalSubmissionAttempted,
        possibleSend,
      );
      if (completion) return completion;
      const snapshot = await inspectForm(page, input.profile);
      if (snapshot.blocked.length)
        return result("manual_required", snapshot.blocked.join("・"));
      const fingerprint = JSON.stringify(snapshot);
      if (seen.has(fingerprint))
        return result(
          possibleSend ? "unknown_result" : "manual_required",
          "画面が進まないため停止しました。自動再送しません",
        );
      seen.add(fingerprint);
      const plan = validateActionPlan(
        await planForm(input.ai, snapshot, c, input.preferences, input.profile),
        snapshot,
        c,
        input.profile,
        input.preferences,
      );
      await verifyCapturedForm(page, snapshot);
      networkFrozen = true;
      const transition = await executeActions(page, plan, snapshot, input);
      if (
        !(await page
          .locator("form")
          .evaluateAll((forms) =>
            forms.every((form) => (form as HTMLFormElement).checkValidity()),
          ))
      )
        return result("manual_required", "回答できない必須項目があります");
      if (!(await input.finalCheck()))
        return result("blocked", "送信直前の安全確認で停止しました");
      await verifyCapturedForm(page, snapshot);
      const terminal = plan.actions.at(-1)!;
      if (!("ref" in terminal)) throw new Error("Invalid terminal");
      // Next buttons can submit the current page. Any interruption after this point must never retry.
      possibleSend = true;
      sendingWindow = true;
      finalSubmissionAttempted = transition === "submit";
      await (await currentElement(page, terminal.ref)).click();
      await page.waitForLoadState("networkidle");
      if (transition === "submit") {
        await Promise.race([
          page
            .getByRole("heading", { name: completionHeading })
            .waitFor({ timeout: 12000 }),
          page
            .getByRole("alert")
            .filter({ hasText: "フォームエラー" })
            .waitFor({ timeout: 12000 }),
        ]);
        if (
          await page
            .getByRole("alert")
            .filter({ hasText: "フォームエラー" })
            .count()
        )
          return result("failed", "フォームが回答を受け付けませんでした");
      }
      sendingWindow = false;
    }
    return result(
      possibleSend ? "unknown_result" : "manual_required",
      "画面数または実行時間の上限に達しました。自動再送しません",
    );
  } catch {
    return result(
      possibleSend ? "unknown_result" : "manual_required",
      possibleSend
        ? "送信結果が不明です。自動再送しません"
        : "フォームの安全な解析・入力を完了できません。手動確認してください",
    );
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
