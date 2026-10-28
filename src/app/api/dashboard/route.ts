import { NextRequest, NextResponse } from "next/server";
import { apiError, mode, privateHeaders, requireUser } from "@/lib/auth";
import { getStore } from "@/lib/store";
import { createAIService } from "@/lib/ai/provider";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const userId = await requireUser(request),
      store = getStore();
    if (mode() === "demo" && !(await store.listSources(userId)).length) {
      await store.saveSource(userId, {
        id: "demo-fixture",
        name: "ローカル検証用キャンペーン",
        url: "https://example.com/demo",
        kind: "fixture",
        enabled: true,
        termsAccepted: true,
        allowedHosts: ["example.com"],
      });
    }
    const [profile, preferences, sources, campaigns, applications, runs] =
      await Promise.all([
        store.getProfile(userId),
        store.getPreferences(userId),
        store.listSources(userId),
        store.listCampaigns(userId),
        store.listApplications(userId),
        store.listRuns(userId),
      ]);
    const aiStatus = await createAIService(store, userId).getStatus();
    return NextResponse.json(
      {
        mode: mode(),
        hasProfile: !!profile,
        profile:
          request.nextUrl.searchParams.get("includeProfile") === "1"
            ? profile
            : null,
        preferences,
        sources,
        campaigns,
        applications,
        runs,
        aiConfigured: aiStatus.keyConfigured,
      },
      { headers: privateHeaders },
    );
  } catch (error) {
    return apiError(error);
  }
}
