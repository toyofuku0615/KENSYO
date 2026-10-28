import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  readJson,
  apiError,
  checkOrigin,
  privateHeaders,
  requireUser,
} from "@/lib/auth";
import { getStore } from "@/lib/store";
const schema = z
  .object({
    campaignId: z.string().min(1).max(100),
    status: z.enum(["submitted", "won", "lost"]),
    prizeValue: z.number().min(0).max(100000000).optional(),
  })
  .strict();
export async function POST(request: NextRequest) {
  try {
    checkOrigin(request);
    const user = await requireUser(request),
      body = schema.parse((await readJson(request)) as Record<string, unknown>);
    await getStore().saveManualApplication(
      user,
      body.campaignId,
      body.status,
      body.prizeValue,
    );
    await getStore().audit(user, {
      action: "manual_result",
      campaignId: body.campaignId,
      detail: body.status,
      createdAt: new Date().toISOString(),
    });
    return NextResponse.json({ ok: true }, { headers: privateHeaders });
  } catch (error) {
    return apiError(error);
  }
}
