import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";

export function mode(): "demo" | "supabase" {
  return process.env.KENSHO_MODE === "demo" ||
    (!process.env.KENSHO_MODE && process.env.NODE_ENV !== "production")
    ? "demo"
    : "supabase";
}
export async function authClient() {
  const jar = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase の接続設定が必要です。");
  return createServerClient(url, key, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (items) => {
        for (const { name, value, options } of items)
          jar.set(name, value, options);
      },
    },
  });
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
/** Next may normalize request.nextUrl to localhost; validate the original authority instead. */
function demoHost(request: NextRequest): string {
  const host = request.headers.get("host");
  if (
    !host ||
    !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::([1-9]\d{0,4}))?$/i.test(host)
  ) {
    throw new ApiError("デモモードはローカル接続専用です。", 403);
  }
  const authority = new URL(`http://${host}`);
  if (authority.port && Number(authority.port) > 65535)
    throw new ApiError("接続先ポートが不正です。", 403);
  return authority.host;
}
export function checkOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  // Supabase deployments require a pinned origin and never trust Host/Forwarded headers.
  // A local demo may derive its HTTP origin from a strictly validated loopback Host only.
  const localHost = mode() === "demo" ? demoHost(request) : null;
  const expected =
    process.env.APP_ORIGIN || (localHost ? `http://${localHost}` : null);
  if (!expected)
    throw new ApiError("環境設定に APP_ORIGIN を設定してください。", 503);
  if (origin !== expected) throw new ApiError("送信元を確認できません。", 403);
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new ApiError("外部サイトからの操作は許可されません。", 403);
}
/** Bound both declared and streamed JSON size before parsing sensitive input. */
export async function readJson(
  request: Request,
  maxBytes = 16_384,
): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") || "",
    )
  ) {
    throw new ApiError("JSON 形式で送信してください。", 415);
  }
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new ApiError("送信データが大きすぎます。", 413);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError("送信データがありません。");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiError("送信データが大きすぎます。", 413);
      }
      parts.push(next.value);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("JSON データを確認してください。");
  } finally {
    reader.releaseLock();
  }
}
export async function requireUser(request: NextRequest): Promise<string> {
  if (mode() === "demo") {
    demoHost(request);
    return "local-demo-user";
  }
  const { data, error } = await (await authClient()).auth.getUser();
  if (error || !data.user) throw new ApiError("ログインしてください。", 401);
  return data.user.id;
}
export function apiError(error: unknown) {
  if (error instanceof ApiError)
    return NextResponse.json(
      { error: error.message },
      { status: error.status },
    );
  // Never expose SQL, validation input, credentials, URLs containing tokens or profile data.
  return NextResponse.json(
    { error: "処理に失敗しました。接続設定と入力項目を確認してください。" },
    { status: 400 },
  );
}
export const privateHeaders = { "Cache-Control": "private, no-store" };
