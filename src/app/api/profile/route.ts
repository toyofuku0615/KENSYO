import { NextRequest, NextResponse } from "next/server";
import {
  readJson,
  apiError,
  checkOrigin,
  privateHeaders,
  requireUser,
} from "@/lib/auth";
import { getStore } from "@/lib/store";
import { profileSchema } from "@/lib/validation";
export async function PUT(request: NextRequest) {
  try {
    checkOrigin(request);
    const user = await requireUser(request);
    const { profile } = (await readJson(request)) as Record<string, unknown>;
    await getStore().saveProfile(user, profileSchema.parse(profile));
    return NextResponse.json({ ok: true }, { headers: privateHeaders });
  } catch (error) {
    return apiError(error);
  }
}
