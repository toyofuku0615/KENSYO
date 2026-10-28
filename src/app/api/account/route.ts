import { NextRequest, NextResponse } from "next/server";
import {
  apiError,
  authClient,
  checkOrigin,
  mode,
  privateHeaders,
  requireUser,
} from "@/lib/auth";
import { getStore } from "@/lib/store";
export async function DELETE(request: NextRequest) {
  try {
    checkOrigin(request);
    const user = await requireUser(request);
    await getStore().deleteUser(user);
    if (mode() === "supabase") await (await authClient()).auth.signOut();
    return NextResponse.json({ ok: true }, { headers: privateHeaders });
  } catch (error) {
    return apiError(error);
  }
}
