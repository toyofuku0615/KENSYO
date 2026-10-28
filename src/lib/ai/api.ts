import { NextRequest, NextResponse } from "next/server";
import {
  ApiError,
  apiError,
  checkOrigin,
  mode,
  privateHeaders,
  requireUser,
} from "@/lib/auth";
import { getStore } from "@/lib/store";
import { createAIService, AIServiceError } from "./provider";

export async function aiForRequest(request: NextRequest, mutation = false) {
  if (mutation) {
    checkOrigin(request);
    if (mode() !== "demo") {
      const origin = process.env.APP_ORIGIN;
      const forwarded = request.headers.get("x-forwarded-proto");
      if (
        !origin?.startsWith("https://") ||
        (forwarded
          ? forwarded !== "https"
          : request.nextUrl.protocol !== "https:")
      ) {
        throw new ApiError(
          "AI設定の送信にはHTTPS接続が必要です。ローカル検証は非公開のdemoモードを使ってください。",
          403,
        );
      }
    }
  }
  const userId = await requireUser(request);
  return createAIService(getStore(), userId);
}
export function aiApiError(error: unknown) {
  if (error instanceof AIServiceError)
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: 400, headers: privateHeaders },
    );
  return apiError(error);
}
