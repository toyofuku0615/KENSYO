import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  readJson,
  apiError,
  ApiError,
  checkOrigin,
  mode,
  requireUser,
} from "@/lib/auth";
import { profileSchema } from "@/lib/validation";
export async function POST(request: NextRequest) {
  try {
    checkOrigin(request);
    await requireUser(request);
    if (mode() !== "demo") throw new ApiError("Not found", 404);
    const { privacy, ...profile } = (await readJson(request)) as Record<
      string,
      unknown
    >;
    if (privacy !== "on") throw new ApiError("必須同意がありません。");
    profileSchema.parse(profile);
    // Never persist or log this test form's personal data.
    return NextResponse.json(
      { receipt: `TEST-${randomUUID()}` },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
