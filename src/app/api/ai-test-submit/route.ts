import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  ApiError,
  apiError,
  checkOrigin,
  mode,
  readJson,
  requireUser,
} from "@/lib/auth";
const fields = z
  .object({
    name: z.string().trim().min(1).max(160),
    address: z.string().trim().min(1).max(300),
    email: z.string().email(),
    privacy: z.literal("on"),
    category: z.string().max(50).optional(),
    answer: z.string().max(100).optional(),
    quiz: z.string().max(30).optional(),
    newsletter: z.string().optional(),
  })
  .strict();
export async function POST(request: NextRequest) {
  try {
    checkOrigin(request);
    await requireUser(request);
    if (mode() !== "demo") throw new ApiError("Not found", 404);
    const parsed = z
      .object({
        variant: z.enum([
          "easy",
          "survey",
          "free",
          "quiz",
          "multi",
          "reordered",
        ]),
        fields,
      })
      .strict()
      .parse(await readJson(request));
    if (parsed.fields.newsletter) throw new ApiError("広告同意は不要です。");
    if (["survey", "multi"].includes(parsed.variant) && !parsed.fields.category)
      throw new ApiError("必須回答がありません。");
    if (["free", "multi"].includes(parsed.variant) && !parsed.fields.answer)
      throw new ApiError("必須回答がありません。");
    if (parsed.variant === "quiz" && parsed.fields.quiz !== "無糖")
      throw new ApiError("回答を確認してください。");
    return NextResponse.json(
      { receipt: `AI-TEST-${randomUUID()}` },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
