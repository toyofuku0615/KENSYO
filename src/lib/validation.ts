import { z } from "zod";
import { CATEGORIES } from "@/core/types";

const text = z.string().trim().min(1).max(160);
export const profileSchema = z
  .object({
    name: text,
    kana: text,
    postalCode: z.string().regex(/^\d{3}-?\d{4}$/),
    prefecture: text,
    address: z.string().trim().min(1).max(300),
    phone: z.string().regex(/^[0-9+() -]{9,20}$/),
    email: z.string().email().max(254),
    birthDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((v) => {
        const date = new Date(v + "T00:00:00Z");
        return (
          Number.isFinite(date.getTime()) &&
          date.toISOString().slice(0, 10) === v &&
          date <= new Date() &&
          date.getUTCFullYear() >= 1900
        );
      }),
    gender: z.string().max(30).optional(),
  })
  .strict();
export const preferencesSchema = z
  .object({
    autoCollect: z.boolean(),
    autoApply: z.boolean(),
    emergencyStop: z.boolean(),
    consentAt: z.string().datetime().nullable(),
    approvedConsents: z.array(z.enum(["privacy", "terms"])).max(2),
    maxApplications: z.number().int().min(1).max(100),
    categories: z.array(z.enum(CATEGORIES)).max(7),
    excludedCategories: z.array(z.enum(CATEGORIES)).max(7),
  })
  .strict()
  .refine(
    (v) =>
      !v.autoApply ||
      (v.consentAt && Date.parse(v.consentAt) <= Date.now() + 60_000),
    { message: "自動送信への事前同意が必要です。" },
  );
export const sourceSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9_-]+$/),
    name: text,
    url: z.string().url().max(2000),
    kind: z.enum(["rss", "html", "fixture"]),
    enabled: z.boolean(),
    termsAccepted: z.boolean(),
    allowedHosts: z
      .array(
        z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
      )
      .min(1)
      .max(20),
  })
  .strict();
