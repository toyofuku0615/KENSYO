import { lookup } from "node:dns/promises";
import {
  Agent,
  ProxyAgent,
  fetch as safeRequest,
  type Dispatcher,
} from "undici";
import type { Route } from "playwright";
import type { Campaign, Preferences, Profile } from "../core/types";
import { decideEligibility } from "../core/analysis";
import {
  assertRobotsAllowed,
  isPublicAddress,
  validatePublicUrl,
} from "../core/url-safety";
import { actionPlanSchema, type ActionPlan } from "./action-planner";
import type { FormSnapshot } from "./form-analyzer";
import {
  hasConflictingQuizEvidence,
  safeGeneratedAnswer,
  safeOptionAnswer,
} from "./answer-generator";

export function localAIOrigin(): string {
  const u = new URL(process.env.TEST_FORM_ORIGIN || "http://127.0.0.1:3000");
  if (
    u.protocol !== "http:" ||
    u.hostname !== "127.0.0.1" ||
    u.pathname !== "/" ||
    u.search ||
    u.hash ||
    u.username ||
    u.password
  )
    throw new Error("Invalid fixture origin");
  return u.origin;
}
export function liveHosts(): string[] {
  return (process.env.LIVE_SUBMISSION_HOSTS || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter((v) => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(v));
}
export function canUseGenericCampaign(c: Campaign): boolean {
  try {
    const u = new URL(c.entryUrl);
    if (c.adapterId !== "generic-ai") return false;
    if (c.isDemo)
      return (
        process.env.KENSHO_MODE !== "supabase" &&
        u.origin === localAIOrigin() &&
        /^\/ai-test-form\/[a-z-]+$/.test(u.pathname) &&
        !u.search &&
        !u.hash &&
        !u.username &&
        !u.password
      );
    return (
      process.env.ENABLE_LIVE_SUBMISSIONS === "true" &&
      u.protocol === "https:" &&
      liveHosts().includes(u.hostname) &&
      !u.username &&
      !u.password &&
      !u.hash &&
      (!u.port || u.port === "443")
    );
  } catch {
    return false;
  }
}
export function validateActionPlan(
  untrusted: unknown,
  snapshot: FormSnapshot,
  campaign: Campaign,
  profile: Profile,
  preferences: Preferences,
): ActionPlan {
  const plan = actionPlanSchema.parse(untrusted);
  if (plan.manualReason) throw new Error("manual-required");
  if (snapshot.blocked.length) throw new Error("blocked-form");
  if (snapshot.fields.some((f) => f.type === "unsupported" && f.required))
    throw new Error("unsupported-required");
  if (
    snapshot.fields.some(
      (f) => f.type === "checkbox" && f.checked && !f.required,
    )
  )
    throw new Error("prechecked-optional-consent");
  const terminal = plan.actions.filter(
    (a) => a.type === "click_next" || a.type === "submit_application",
  );
  if (terminal.length !== 1 || plan.actions.at(-1) !== terminal[0])
    throw new Error("invalid-transition");
  const touched = new Set<string>();
  for (const op of plan.actions) {
    if (op.type === "inspect_page" || op.type === "verify_submission") continue;
    if (op.type === "click_next" || op.type === "submit_application") {
      const button = snapshot.buttons.find((b) => b.ref === op.ref);
      if (
        !button ||
        button.kind !== (op.type === "click_next" ? "next" : "submit")
      )
        throw new Error("unapproved-button");
      continue;
    }
    const field = snapshot.fields.find((f) => f.ref === op.ref);
    if (!field || touched.has(field.ref))
      throw new Error("unknown-or-duplicate-control");
    touched.add(field.ref);
    if (op.type === "fill_profile_field") {
      if (
        field.profileField !== op.field ||
        !profile[op.field] ||
        ![
          "text",
          "email",
          "tel",
          "date",
          "number",
          "textarea",
          "select",
        ].includes(field.type)
      )
        throw new Error("unverified-profile-mapping");
      if (field.maxLength && profile[op.field]!.length > field.maxLength)
        throw new Error("profile-too-long");
    }
    if (op.type === "fill_generated_answer") {
      if (
        field.profileField ||
        !["text", "textarea"].includes(field.type) ||
        !safeGeneratedAnswer(
          op.answer,
          op.evidenceQuote,
          field,
          campaign,
          profile,
        )
      )
        throw new Error("unverified-answer");
    }
    if (op.type === "select_option") {
      const option = field.options.find((o) => o.ref === op.optionRef);
      if (
        field.type !== "select" ||
        field.profileField ||
        !option ||
        !safeOptionAnswer(
          option.label,
          op.evidenceQuote,
          field,
          campaign,
          preferences,
        )
      )
        throw new Error("unverified-option");
      if (
        /クイズ|正しい|特徴|答え/.test(field.question || field.label) &&
        hasConflictingQuizEvidence(
          option.label,
          field.options.map((o) => o.label),
          campaign,
        )
      )
        throw new Error("conflicting-quiz-evidence");
    }
    if (op.type === "select_radio") {
      if (
        field.type !== "radio" ||
        !safeOptionAnswer(
          field.label,
          op.evidenceQuote,
          field,
          campaign,
          preferences,
        )
      )
        throw new Error("unverified-radio");
      if (
        /クイズ|正しい|特徴|答え/.test(field.question || field.label) &&
        hasConflictingQuizEvidence(
          field.label,
          snapshot.fields
            .filter((f) => f.type === "radio" && f.question === field.question)
            .map((f) => f.label),
          campaign,
        )
      )
        throw new Error("conflicting-quiz-evidence");
    }
    if (op.type === "check_approved_consent") {
      const acceptable =
        op.consent === "privacy"
          ? /個人情報|プライバシー/
          : /応募規約|利用規約/;
      if (
        field.type !== "checkbox" ||
        !field.required ||
        !preferences.approvedConsents.includes(op.consent) ||
        !acceptable.test(field.label) ||
        /広告|メールマガジン|メルマガ|ニュースレター|販促|プロモーション|第三者提供|購入|契約|有料/.test(
          field.label,
        )
      )
        throw new Error("unapproved-consent");
    }
  }
  for (const field of snapshot.fields.filter((f) => f.required)) {
    if (field.type === "radio") {
      if (!field.question.trim()) throw new Error("unidentified-radio-group");
      if (
        !plan.actions.some(
          (a) =>
            a.type === "select_radio" &&
            snapshot.fields.find((f) => f.ref === a.ref)?.question ===
              field.question,
        )
      )
        throw new Error("unanswered-radio");
    } else if (!touched.has(field.ref)) throw new Error("unanswered-required");
  }
  return plan;
}
export function validateGenericInput(
  campaign: Campaign,
  profile: Profile,
  preferences: Preferences,
): boolean {
  return (
    canUseGenericCampaign(campaign) &&
    decideEligibility(campaign, profile, preferences).eligible
  );
}
function transport(): Dispatcher {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) {
    if (process.env.KENSHO_PROXY_PUBLIC_DESTINATIONS_ONLY !== "1")
      throw new Error("Unverified proxy network policy");
    return new ProxyAgent(proxy);
  }
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        lookup(hostname, { all: true })
          .then((addresses) => {
            if (
              !addresses.length ||
              addresses.some((a) => !isPublicAddress(a.address))
            ) {
              callback(new Error("Nonpublic destination"), []);
              return;
            }
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0].address, addresses[0].family);
          })
          .catch((e) => callback(e, []));
      },
    },
  });
}
/** Route every real request through a DNS-pinned public transport; redirects are re-intercepted. */
export async function fulfillPublicRoute(
  route: Route,
  origin: string,
  allowSending: boolean,
  finalCheck: () => Promise<boolean>,
  profile: Profile,
  networkFrozen = false,
): Promise<void> {
  const req = route.request(),
    url = new URL(req.url());
  if (url.origin !== origin || !["GET", "POST"].includes(req.method())) {
    await route.abort("blockedbyclient");
    return;
  }
  // Block every request while values are being filled or a later page is re-analysed.
  // Looking for literal PII cannot catch encoding, URL paths or keystroke exfiltration.
  if (
    (networkFrozen && !allowSending) ||
    (allowSending && !(await finalCheck()))
  ) {
    await route.abort("blockedbyclient");
    return;
  }
  const data = req.postData() || "";
  const hasSensitive = Object.values(profile)
    .filter((v) => v && v.length >= 3)
    .some(
      (v) =>
        data.includes(v) ||
        data.includes(encodeURIComponent(v)) ||
        url.search.includes(v) ||
        url.search.includes(encodeURIComponent(v)),
    );
  if (
    (req.method() !== "GET" || hasSensitive) &&
    (!allowSending || !(await finalCheck()))
  ) {
    await route.abort("blockedbyclient");
    return;
  }
  await validatePublicUrl(url.href, liveHosts());
  if (req.isNavigationRequest() || req.method() === "POST")
    await assertRobotsAllowed(url.href, liveHosts());
  const dispatcher = transport();
  try {
    const headers = { ...req.headers() };
    delete headers.host;
    delete headers["content-length"];
    delete headers["accept-encoding"];
    const response = await safeRequest(url, {
      dispatcher,
      redirect: "manual",
      method: req.method(),
      headers,
      body: req.method() === "POST" ? data : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const reader = response.body?.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    if (reader)
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 2_000_000) {
          await reader.cancel();
          throw new Error("Response too large");
        }
        parts.push(part.value);
      }
    const responseHeaders = Object.fromEntries(response.headers);
    delete responseHeaders["content-encoding"];
    delete responseHeaders["content-length"];
    await route.fulfill({
      status: response.status,
      headers: responseHeaders,
      body: Buffer.concat(parts),
    });
  } finally {
    await dispatcher.close();
  }
}
