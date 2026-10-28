import { NextRequest, NextResponse } from "next/server";
import { aiForRequest, aiApiError } from "@/lib/ai/api";
import { privateHeaders } from "@/lib/auth";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    return NextResponse.json(
      await (await aiForRequest(request, true)).testConnection(),
      { headers: privateHeaders },
    );
  } catch (error) {
    return aiApiError(error);
  }
}
