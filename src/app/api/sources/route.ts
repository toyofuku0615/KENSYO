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
import { sourceSchema } from "@/lib/validation";
export async function POST(request: NextRequest) {
  try {
    checkOrigin(request);
    const user = await requireUser(request);
    const { source } = (await readJson(request)) as Record<string, unknown>;
    const parsed = sourceSchema.parse(source);
    if (parsed.kind === "fixture" && mode() !== "demo")
      throw new ApiError("検証用ソースはデモモード専用です。");
    if (parsed.kind !== "fixture") {
      const url = new URL(parsed.url);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !parsed.allowedHosts.includes(url.hostname)
      )
        throw new ApiError("HTTPS URL と取得許可ホストを確認してください。");
    }
    await getStore().saveSource(user, parsed);
    return NextResponse.json({ ok: true }, { headers: privateHeaders });
  } catch (error) {
    return apiError(error);
  }
}
export async function DELETE(request: NextRequest) {
  try {
    checkOrigin(request);
    const user = await requireUser(request),
      id = request.nextUrl.searchParams.get("id");
    if (!id) throw new ApiError("情報源を指定してください。");
    await getStore().deleteSource(user, id);
    return NextResponse.json({ ok: true }, { headers: privateHeaders });
  } catch (error) {
    return apiError(error);
  }
}
