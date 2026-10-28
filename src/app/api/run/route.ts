import { NextRequest, NextResponse } from "next/server";
import {
  readJson,
  apiError,
  ApiError,
  checkOrigin,
  mode,
  privateHeaders,
  requireUser,
} from "@/lib/auth";
import { getStore } from "@/lib/store";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    checkOrigin(request);
    const user = await requireUser(request),
      store = getStore();
    const { kind } = (await readJson(request)) as Record<string, unknown>;
    if (kind !== "collect" && kind !== "apply")
      throw new ApiError("実行種別が不正です。");
    if (mode() === "supabase") {
      await store.requestRun(user, kind);
      return NextResponse.json(
        {
          ok: true,
          queued: true,
          message:
            "実行予約を保存しました。次のワーカー起動時に処理します（定期実行は6時間ごと）。",
        },
        { headers: privateHeaders },
      );
    }
    const { runCollection, runApplications } = await import("@/core/runner");
    const run =
      kind === "collect"
        ? await runCollection(store, user)
        : await runApplications(store, user);
    return NextResponse.json({ ok: true, run }, { headers: privateHeaders });
  } catch (error) {
    return apiError(error);
  }
}
