import { NextRequest, NextResponse } from "next/server";
import { apiError, mode, privateHeaders, requireUser } from "@/lib/auth";
import { getStore } from "@/lib/store";
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
        aiConfigured: false,
      },
      { headers: privateHeaders },
    );
  } catch (error) {
    return apiError(error);
  }
}
