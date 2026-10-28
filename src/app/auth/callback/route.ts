import { NextRequest, NextResponse } from "next/server";
import { authClient } from "@/lib/auth";
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (code) {
    const { error } = await (
      await authClient()
    ).auth.exchangeCodeForSession(code);
    if (!error)
      return NextResponse.redirect(
        new URL("/", process.env.APP_ORIGIN || request.nextUrl.origin),
      );
  }
  return NextResponse.redirect(
    new URL(
      "/login?error=auth",
      process.env.APP_ORIGIN || request.nextUrl.origin,
    ),
  );
}
