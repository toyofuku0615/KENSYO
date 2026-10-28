import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJson, apiError, authClient, checkOrigin } from "@/lib/auth";
export async function POST(request: NextRequest) {
  try {
    checkOrigin(request);
    const { email } = z
      .object({ email: z.string().email().max(254) })
      .parse((await readJson(request)) as Record<string, unknown>);
    const origin = process.env.APP_ORIGIN || request.nextUrl.origin;
    const { error } = await (
      await authClient()
    ).auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${origin}/auth/callback` },
    });
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
