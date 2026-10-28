import type { ElementHandle, Page } from "playwright";
import type { Profile } from "../core/types";
import { z } from "zod";

export const profileKeys = [
  "name",
  "kana",
  "postalCode",
  "prefecture",
  "address",
  "phone",
  "email",
  "birthDate",
  "gender",
] as const;
export type ProfileKey = (typeof profileKeys)[number];
export const snapshotSchema = z
  .object({
    fields: z
      .array(
        z
          .object({
            ref: z.string(),
            label: z.string().max(240),
            question: z.string().max(240),
            type: z.enum([
              "text",
              "email",
              "tel",
              "date",
              "number",
              "textarea",
              "select",
              "radio",
              "checkbox",
              "unsupported",
            ]),
            required: z.boolean(),
            maxLength: z.number().int().nullable(),
            checked: z.boolean(),
            profileField: z.enum(profileKeys).nullable(),
            options: z
              .array(
                z
                  .object({ ref: z.string(), label: z.string().max(160) })
                  .strict(),
              )
              .max(60),
          })
          .strict(),
      )
      .max(40),
    buttons: z
      .array(
        z
          .object({
            ref: z.string(),
            label: z.string().max(160),
            kind: z.enum(["next", "submit", "unknown"]),
          })
          .strict(),
      )
      .max(10),
    blocked: z.array(z.string()).max(10),
  })
  .strict();
export type FormSnapshot = z.infer<typeof snapshotSchema>;
export type ObservedControl = FormSnapshot["fields"][number];
/** Detect familiar encodings of this owner's private values before any metadata leaves this process. */
export function containsPrivateMetadata(
  text: string,
  profile: Profile,
): boolean {
  const normalize = (value: string) =>
    value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  const variants = new Set<string>();
  for (const value of Object.values(profile).filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length >= 3,
  )) {
    for (const variant of [
      value,
      encodeURIComponent(value),
      Buffer.from(value).toString("base64"),
      Buffer.from(value).toString("base64url"),
    ])
      variants.add(normalize(variant));
  }
  const birth = profile.birthDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (birth)
    for (const value of [
      `${birth[1]}/${birth[2]}/${birth[3]}`,
      `${birth[1]}/${Number(birth[2])}/${Number(birth[3])}`,
      `${birth[1]}年${Number(birth[2])}月${Number(birth[3])}日`,
      birth[1] + birth[2] + birth[3],
    ])
      variants.add(normalize(value));
  const normalized = normalize(text);
  return (
    [...variants].some(
      (value) => value.length >= 3 && normalized.includes(value),
    ) ||
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+81|0\d{1,4})[-\s]?\d{2,4}[-\s]?\d{4}|\b\d{3}[-ー]\d{4}\b|\b\d{4}[\/年]\d{1,2}[\/月]\d{1,2}/i.test(
      text,
    )
  );
}
type CapturedElement = {
  handle: ElementHandle<HTMLElement | SVGElement>;
  signature: string;
};
const capturedPages = new WeakMap<Page, Map<string, CapturedElement>>();
/** Keep element identity and semantics locally; none of this private map is sent to Gemini. */
function elementSignature(element: Element): string {
  const field = element as HTMLInputElement;
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const clone = field.labels?.[0]?.cloneNode(true) as HTMLElement | undefined;
  clone
    ?.querySelectorAll("input,select,textarea,button")
    .forEach((e) => e.remove());
  const labelled = field
    .getAttribute("aria-labelledby")
    ?.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
  const label = clean(
    field.getAttribute("aria-label") ||
      labelled ||
      clone?.textContent ||
      field.getAttribute("placeholder") ||
      (field.matches("button,input[type=submit]")
        ? field.textContent || field.value || ""
        : ""),
  );
  return JSON.stringify({
    tag: field.tagName,
    type: field.getAttribute("type"),
    name: field.name,
    required: field.required,
    disabled: field.disabled,
    label,
    question: clean(
      field.closest("fieldset")?.querySelector("legend")?.textContent || "",
    ),
    maxLength: field.maxLength,
    options:
      field.tagName === "SELECT"
        ? [...(field as unknown as HTMLSelectElement).options].map((o) => ({
            label: clean(o.textContent || ""),
            value: o.value,
            disabled: o.disabled,
          }))
        : [],
    formAction: field.form?.action,
    formMethod: field.form?.method,
    buttonAction: field.getAttribute("formaction"),
    connected: field.isConnected,
    visible: field.getClientRects().length > 0,
  });
}
async function captureElements(page: Page, snapshot: FormSnapshot) {
  const previous = capturedPages.get(page);
  if (previous)
    await Promise.all(
      [...previous.values()].map((item) =>
        item.handle.dispose().catch(() => undefined),
      ),
    );
  const captured = new Map<string, CapturedElement>();
  for (const field of [...snapshot.fields, ...snapshot.buttons]) {
    const attr = field.ref.startsWith("f")
      ? "data-kensho-control"
      : "data-kensho-button";
    const locator = page.locator(`[${attr}="${field.ref}"]`);
    if ((await locator.count()) !== 1)
      throw new Error("Ambiguous control identity");
    const handle = await locator.elementHandle();
    if (!handle) throw new Error("Missing control identity");
    captured.set(field.ref, {
      handle,
      signature: await handle.evaluate(elementSignature),
    });
  }
  capturedPages.set(page, captured);
}
export async function currentElement(
  page: Page,
  ref: string,
): Promise<ElementHandle<HTMLElement | SVGElement>> {
  const item = capturedPages.get(page)?.get(ref);
  if (!item) throw new Error("Uncaptured element");
  const attr = ref.startsWith("f")
    ? "data-kensho-control"
    : "data-kensho-button";
  if (
    (await page.locator(`[${attr}="${ref}"]`).count()) !== 1 ||
    (await item.handle.getAttribute(attr)) !== ref ||
    (await item.handle.evaluate(elementSignature)) !== item.signature
  )
    throw new Error("Form changed after analysis");
  return item.handle;
}
export async function verifyCapturedForm(
  page: Page,
  snapshot: FormSnapshot,
): Promise<void> {
  for (const field of [...snapshot.fields, ...snapshot.buttons])
    await currentElement(page, field.ref);
  if (
    await page.locator('input[type="checkbox"]').evaluateAll((elements) =>
      elements.some((element) => {
        const input = element as HTMLInputElement;
        return !input.required && input.checked;
      }),
    )
  )
    throw new Error("Optional consent changed");
}
const mappings: Record<ProfileKey, RegExp> = {
  name: /^(?:お届け先の?|応募者の?|ご)?(?:氏名|お名前|名前)(?:（必須）|\*|\s)*$/,
  kana: /^(?:お名前の?|氏名の?)?(?:フリガナ|ふりがな|カナ)(?:（必須）|\*|\s)*$/,
  postalCode: /^(?:お届け先の?)?郵便番号(?:（必須）|\*|\s)*$/,
  prefecture: /^(?:お届け先の?)?都道府県(?:（必須）|\*|\s)*$/,
  address:
    /^(?:お届け先の?|ご)?(?:住所|市区町村・番地・建物名)(?:（必須）|\*|\s)*$/,
  phone: /^(?:連絡先の?|ご)?(?:電話番号|携帯電話番号)(?:（必須）|\*|\s)*$/,
  email:
    /^(?:ご連絡先の?|ご)?(?:メールアドレス|Eメールアドレス|Email)(?:（必須）|\*|\s)*$/i,
  birthDate: /^(?:ご)?生年月日(?:（必須）|\*|\s)*$/,
  gender: /^(?:ご)?性別(?:（任意）|（必須）|\*|\s)*$/,
};
export function identifyProfileField(label: string): ProfileKey | null {
  return profileKeys.find((key) => mappings[key].test(label.trim())) ?? null;
}
/** Never export entered values, raw HTML, URLs, ids, names, hidden controls or page body. */
export async function inspectForm(
  page: Page,
  profile: Profile,
): Promise<FormSnapshot> {
  const raw = await page.evaluate(() => {
    document
      .querySelectorAll("[data-kensho-control],[data-kensho-button]")
      .forEach((element) => {
        element.removeAttribute("data-kensho-control");
        element.removeAttribute("data-kensho-button");
      });
    const clean = (s: string) => s.replace(/\s+/g, " ").trim();
    const labelOf = (
      e: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
    ) => {
      const aria = e.getAttribute("aria-label");
      if (aria) return clean(aria);
      const ids = e.getAttribute("aria-labelledby");
      if (ids)
        return clean(
          ids
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" "),
        );
      const clone = e.labels?.[0]?.cloneNode(true) as HTMLElement | undefined;
      clone
        ?.querySelectorAll("input,select,textarea,button")
        .forEach((child) => child.remove());
      return clean(clone?.textContent || e.getAttribute("placeholder") || "");
    };
    const blocked: string[] = [];
    if (
      document.querySelector(
        'iframe[src*="captcha"],iframe[title*="CAPTCHA"],[data-sitekey],input[name*="captcha" i]',
      )
    )
      blocked.push("CAPTCHAは本人操作が必要です");
    if (
      document.querySelector(
        'input[type="password"],input[autocomplete="one-time-code"],input[autocomplete="cc-number"]',
      )
    )
      blocked.push("認証・決済情報の入力が必要です");
    const radioQuestions = new Map<string, string>();
    for (const radio of document.querySelectorAll<HTMLInputElement>(
      'input[type="radio"]',
    )) {
      const question = clean(
        radio.closest("fieldset")?.querySelector("legend")?.textContent || "",
      );
      const prior = radioQuestions.get(question);
      if (!question || !radio.name || (prior && prior !== radio.name))
        blocked.push("ラジオボタンの設問を一意に確認できません");
      radioQuestions.set(question, radio.name);
    }
    const fields = [
      ...document.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >("input,select,textarea"),
    ]
      .filter(
        (e) =>
          !e.disabled &&
          e.getAttribute("type") !== "hidden" &&
          !["submit", "button", "reset"].includes(
            e.getAttribute("type") || "",
          ) &&
          e.getClientRects().length > 0,
      )
      .slice(0, 41)
      .map((e, index) => {
        const ref = `f${index}`;
        e.setAttribute("data-kensho-control", ref);
        const type =
          e.tagName === "SELECT"
            ? "select"
            : e.tagName === "TEXTAREA"
              ? "textarea"
              : (e as HTMLInputElement).type || "text";
        const options =
          e.tagName === "SELECT"
            ? [...(e as HTMLSelectElement).options].map((o, i) => ({
                ref: `o${i}`,
                label: clean(o.textContent || ""),
              }))
            : [];
        return {
          ref,
          label: labelOf(e),
          question: clean(
            e.closest("fieldset")?.querySelector("legend")?.textContent || "",
          ),
          type: [
            "text",
            "email",
            "tel",
            "date",
            "number",
            "textarea",
            "select",
            "radio",
            "checkbox",
          ].includes(type)
            ? type
            : "unsupported",
          required: e.required,
          maxLength: "maxLength" in e && e.maxLength > 0 ? e.maxLength : null,
          checked: (e as HTMLInputElement).checked === true,
          profileField: null,
          options,
        };
      });
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
        'button,input[type="submit"]',
      ),
    ]
      .filter((e) => !e.disabled && e.getClientRects().length > 0)
      .slice(0, 11)
      .map((e, index) => {
        const ref = `b${index}`;
        e.setAttribute("data-kensho-button", ref);
        const label = clean(
          e.getAttribute("aria-label") ||
            e.textContent ||
            (e as HTMLInputElement).value ||
            "",
        );
        return {
          ref,
          label,
          kind: /^(?:次へ|次のページへ|入力内容を確認する|確認する|確認画面へ)$/.test(
            label,
          )
            ? "next"
            : /^(?:応募を確定する|応募する|送信する|応募を送信する)$/.test(
                  label,
                )
              ? "submit"
              : "unknown",
        };
      });
    return { fields, buttons, blocked };
  });
  const parsed = snapshotSchema.parse(raw);
  for (const field of parsed.fields) {
    field.profileField = identifyProfileField(field.label);
    if (field.profileField) field.options = [];
  }
  // A later page may echo entered PII into labels. It is never sent for re-analysis.
  const publicText = JSON.stringify(parsed);
  if (containsPrivateMetadata(publicText, profile))
    throw new Error("フォームの解析対象に個人情報が含まれています");
  await captureElements(page, parsed);
  return parsed;
}
