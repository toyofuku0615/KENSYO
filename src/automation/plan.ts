import { z } from "zod";
import type { Profile } from "../core/types";

export const profileFieldSchema = z.enum([
  "name",
  "kana",
  "email",
  "phone",
  "postalCode",
  "prefecture",
  "address",
  "birthDate",
  "gender",
]);
export type ProfileField = z.infer<typeof profileFieldSchema>;
export const formOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("fill"),
    label: z.string().min(1).max(120),
    field: profileFieldSchema,
  }),
  z.object({
    type: z.literal("select"),
    label: z.string().min(1).max(120),
    field: profileFieldSchema,
  }),
  z.object({
    type: z.literal("radio"),
    label: z.string().min(1).max(120),
    field: profileFieldSchema,
    option: z.string().max(120),
  }),
  z.object({
    type: z.literal("consent"),
    label: z.string().min(1).max(120),
    consent: z.string().min(1).max(80),
  }),
]);
export const formPlanSchema = z.object({
  operations: z.array(formOperationSchema).max(30),
  confirmLabel: z.string().min(1).max(120),
  submitLabel: z.string().min(1).max(120),
});
export type FormPlan = z.infer<typeof formPlanSchema>;
export interface ObservedField {
  label: string;
  type: string;
  required: boolean;
  checked?: boolean;
}
const knownLabels: Record<string, ProfileField> = {
  氏名: "name",
  お名前: "name",
  フリガナ: "kana",
  メールアドレス: "email",
  電話番号: "phone",
  郵便番号: "postalCode",
  都道府県: "prefecture",
  住所: "address",
  生年月日: "birthDate",
  性別: "gender",
};
/** HTML is only field data: never execute instructions or arbitrary selectors from pages. */
export function buildGenericPlan(
  fields: ObservedField[],
  profile: Profile,
  approvedConsents: string[],
): { plan: FormPlan | null; reasons: string[] } {
  const operations: FormPlan["operations"] = [];
  const reasons: string[] = [];
  for (const field of fields) {
    if (["submit", "button", "hidden"].includes(field.type)) continue;
    if (field.type === "checkbox") {
      if (!field.required) {
        if (field.checked) reasons.push("任意の同意が事前選択されています");
        continue;
      }
      if (
        field.label === "個人情報の取扱いに同意する" &&
        approvedConsents.includes("privacy")
      )
        operations.push({
          type: "consent",
          label: field.label,
          consent: "privacy",
        });
      else reasons.push("未承認の必須同意があります");
      continue;
    }
    const key = knownLabels[field.label];
    if (!key || field.type === "file" || field.type === "password") {
      if (field.required) reasons.push("回答できない必須項目があります");
      continue;
    }
    if (!profile[key]) {
      if (field.required) reasons.push("必要なプロフィール項目が未登録です");
      continue;
    }
    if (field.type === "radio") {
      // Unknown option labels are never guessed. A site adapter must map them explicitly.
      if (field.required)
        reasons.push("ラジオボタンの選択肢を確認してください");
      continue;
    }
    operations.push({
      type: field.type === "select" ? "select" : "fill",
      label: field.label,
      field: key,
    });
  }
  return {
    plan: reasons.length
      ? null
      : {
          operations,
          confirmLabel: "入力内容を確認する",
          submitLabel: "応募を確定する",
        },
    reasons,
  };
}
export const LOCAL_TEST_PLAN: FormPlan = formPlanSchema.parse({
  operations: [
    ...(
      [
        ["氏名", "name"],
        ["フリガナ", "kana"],
        ["メールアドレス", "email"],
        ["電話番号", "phone"],
        ["郵便番号", "postalCode"],
        ["住所", "address"],
        ["生年月日", "birthDate"],
      ] as const
    ).map(([label, field]) => ({ type: "fill", label, field })),
    { type: "select", label: "都道府県", field: "prefecture" },
    {
      type: "consent",
      label: "個人情報の取扱いに同意する",
      consent: "privacy",
    },
  ],
  confirmLabel: "入力内容を確認する",
  submitLabel: "応募を確定する",
});
