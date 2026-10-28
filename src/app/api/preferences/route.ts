import { NextRequest, NextResponse } from "next/server";
import {
  readJson,
  apiError,
  checkOrigin,
  privateHeaders,
  requireUser,
} from "@/lib/auth";
import { getStore } from "@/lib/store";
import { preferencesSchema } from "@/lib/validation";
export async function PUT(request: NextRequest) {
  try {
    checkOrigin(request);
    const user = await requireUser(request),
      store = getStore();
    const { preferences } = (await readJson(request)) as Record<
      string,
      unknown
    >;
    const parsed = preferencesSchema.parse(preferences);
    const before = await store.getPreferences(user);
    // Timestamp records server receipt of actual consent rather than trusting client time.
    if (parsed.consentAt && !before.consentAt)
      parsed.consentAt = new Date().toISOString();
    await store.savePreferences(user, parsed);
    await store.audit(user, {
      action: parsed.emergencyStop ? "emergency_stop" : "preferences_updated",
      detail: "応募設定を更新",
      createdAt: new Date().toISOString(),
    });
    return NextResponse.json({ ok: true }, { headers: privateHeaders });
  } catch (error) {
    return apiError(error);
  }
}
