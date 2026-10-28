import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJson, privateHeaders, mode } from "@/lib/auth";
import { aiForRequest, aiApiError } from "@/lib/ai/api";
import { aiSettingsSchema, apiKeySchema } from "@/lib/ai/schemas";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    return NextResponse.json(
      { ...(await (await aiForRequest(request)).getStatus()), mode: mode() },
      { headers: privateHeaders },
    );
  } catch (error) {
    return aiApiError(error);
  }
}
export async function PUT(request: NextRequest) {
  try {
    const service = await aiForRequest(request, true);
    const { settings } = z
      .object({ settings: aiSettingsSchema })
      .strict()
      .parse(await readJson(request));
    await service.updateSettings(settings);
    return NextResponse.json({ ok: true }, { headers: privateHeaders });
  } catch (error) {
    return aiApiError(error);
  }
}
export async function POST(request: NextRequest) {
  try {
    const service = await aiForRequest(request, true);
    const { apiKey } = z
      .object({ apiKey: apiKeySchema })
      .strict()
      .parse(await readJson(request));
    await service.saveKey(apiKey);
    return NextResponse.json({ ok: true }, { headers: privateHeaders });
  } catch (error) {
    return aiApiError(error);
  }
}
export async function DELETE(request: NextRequest) {
  try {
    await (await aiForRequest(request, true)).deleteKey();
    return NextResponse.json({ ok: true }, { headers: privateHeaders });
  } catch (error) {
    return aiApiError(error);
  }
}
