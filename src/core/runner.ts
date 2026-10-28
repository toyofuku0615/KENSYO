import { randomUUID } from "node:crypto";
import type { JobRun, Store } from "./types";
import { createAIService, type AIService } from "../lib/ai/provider";
import {
  campaignNeedsAI,
  campaignWorthAI,
  enrichCampaignWithAI,
  prepareGenericCampaign,
} from "./ai-analysis";
import { collectSource } from "./collection";
import { decideEligibility, rankCampaign } from "./analysis";
import {
  submitWithBrowser,
  supportsCampaign,
  type Submitter,
} from "../automation/browser";

export interface RunnerOptions {
  aiService?: Pick<AIService, "getStatus" | "generate">;
}
async function availableAI(
  store: Store,
  userId: string,
  options: RunnerOptions,
) {
  try {
    const service = options.aiService ?? createAIService(store, userId);
    const status = await service.getStatus();
    return status.settings.enabled &&
      status.settings.model &&
      status.settings.freeTierAcknowledged &&
      status.keyConfigured
      ? service
      : null;
  } catch {
    return null;
  }
}
const timestamp = () => new Date().toISOString();
function newRun(kind: JobRun["kind"]): JobRun {
  return {
    id: randomUUID(),
    kind,
    status: "running",
    startedAt: timestamp(),
    finishedAt: null,
    processed: 0,
    errors: [],
  };
}
export async function runCollection(
  store: Store,
  userId: string,
  options: RunnerOptions = {},
): Promise<JobRun> {
  const run = newRun("collect");
  await store.recordRun(userId, run);
  try {
    const preferences = await store.getPreferences(userId);
    if (preferences.emergencyStop) throw new Error("stopped");
    const ai = await availableAI(store, userId, options);
    const sources = (await store.listSources(userId)).filter(
      (source) => source.enabled,
    );
    for (const source of sources) {
      if ((await store.getPreferences(userId)).emergencyStop) break;
      try {
        if (source.kind === "fixture" && process.env.KENSHO_MODE === "supabase")
          continue;
        const campaigns = await collectSource(source);
        for (const discovered of campaigns) {
          if (new Date(discovered.deadline).getTime() <= Date.now()) continue;
          let campaign = discovered;
          const categoryMatches =
            preferences.categories.includes(campaign.category) &&
            !preferences.excludedCategories.includes(campaign.category);
          if (
            ai &&
            !campaign.isDemo &&
            categoryMatches &&
            campaignWorthAI(campaign) &&
            campaignNeedsAI(campaign)
          ) {
            campaign = await enrichCampaignWithAI(campaign, ai);
          }
          campaign = prepareGenericCampaign(campaign, source);
          await store.upsertCampaign(userId, campaign);
          run.processed += 1;
        }
      } catch {
        // A source's name/URL and the exception can contain attacker-controlled data or credentials.
        run.errors.push(
          `情報源 ${source.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)} の取得に失敗しました`,
        );
      }
    }
    run.status = run.errors.length ? "failed" : "completed";
  } catch {
    run.status = "failed";
    run.errors.push(
      "収集処理を実行できませんでした。停止設定と接続を確認してください",
    );
  }
  run.finishedAt = timestamp();
  await store.recordRun(userId, run);
  await store.audit(userId, {
    action: "collection.finished",
    detail: `${run.status}:${run.processed}`,
    createdAt: timestamp(),
  });
  return run;
}
export async function runApplications(
  store: Store,
  userId: string,
  submit: Submitter = submitWithBrowser,
  options: RunnerOptions = {},
): Promise<JobRun> {
  const run = newRun("apply");
  await store.recordRun(userId, run);
  try {
    const ai = await availableAI(store, userId, options);
    const sources = await store.listSources(userId);
    const alreadyApplied = new Set(
      (await store.listApplications(userId)).map(
        (application) => application.campaignId,
      ),
    );
    const campaigns = (await store.listCampaigns(userId))
      .map((campaign) =>
        prepareGenericCampaign(
          campaign,
          sources.find((source) => source.id === campaign.sourceId),
        ),
      )
      .sort((a, b) => rankCampaign(b) - rankCampaign(a));
    for (const campaign of campaigns) {
      if (alreadyApplied.has(campaign.id)) continue;
      if (campaign.isDemo && process.env.KENSHO_MODE === "supabase") continue;
      const prefs = await store.getPreferences(userId);
      if (!prefs.autoApply || prefs.emergencyStop || !prefs.consentAt) break;
      const profile = await store.getProfile(userId);
      const decision = decideEligibility(campaign, profile, prefs);
      if (!decision.eligible || !profile) continue;
      // Unknown sites stay in the manual queue without reserving a submission.
      if (!supportsCampaign(campaign)) continue;
      // Persist a newly operator-reviewed adapter before the same DB's atomic safety claim.
      if (campaign.adapterId === "generic-ai")
        await store.upsertCampaign(userId, campaign);
      const application = await store.claimApplication(userId, campaign.id);
      if (!application) continue;
      try {
        if (campaign.adapterId === "generic-ai" && !ai) {
          await store.updateApplication(userId, application.id, {
            status: "manual_required",
            error:
              "このフォームにはGemini解析が必要です。AI設定・モデル・APIキー・利用上限を確認してください",
          });
          await store.audit(userId, {
            action: "application.manual_required",
            campaignId: campaign.id,
            detail: "AI_UNAVAILABLE",
            createdAt: timestamp(),
          });
          run.processed += 1;
          continue;
        }
        const finalCheck = async () => {
          // Re-read authorization at every potentially sending click/request.
          // Captured rules or a previously persisted generic adapter cannot keep
          // permission alive after the user/operator changes settings or terms.
          const [current, currentProfile, currentCampaigns, currentSources] =
            await Promise.all([
              store.getPreferences(userId),
              store.getProfile(userId),
              store.listCampaigns(userId),
              store.listSources(userId),
            ]);
          const storedCampaign = currentCampaigns.find(
            (item) => item.id === campaign.id,
          );
          if (!storedCampaign) return false;
          const currentCampaign = prepareGenericCampaign(
            storedCampaign,
            currentSources.find(
              (source) => source.id === storedCampaign.sourceId,
            ),
          );
          if (
            currentCampaign.entryUrl !== campaign.entryUrl ||
            currentCampaign.officialUrl !== campaign.officialUrl ||
            currentCampaign.adapterId !== campaign.adapterId
          )
            return false;
          if (campaign.adapterId === "generic-ai") {
            if (!ai) return false;
            const aiStatus = await ai.getStatus();
            if (
              !aiStatus.settings.enabled ||
              !aiStatus.settings.model ||
              !aiStatus.settings.freeTierAcknowledged ||
              !aiStatus.keyConfigured
            )
              return false;
          }
          return (
            JSON.stringify(currentProfile) === JSON.stringify(profile) &&
            decideEligibility(currentCampaign, currentProfile, current)
              .eligible &&
            current.autoApply &&
            !current.emergencyStop &&
            !!current.consentAt
          );
        };
        const result = await submit({
          campaign,
          profile,
          preferences: prefs,
          finalCheck,
          ...(ai ? { ai } : {}),
        });
        await store.updateApplication(userId, application.id, result);
        await store.audit(userId, {
          action: `application.${result.status}`,
          campaignId: campaign.id,
          detail: result.status,
          createdAt: timestamp(),
        });
        run.processed += 1;
        if (["failed", "unknown_result"].includes(result.status))
          run.errors.push(
            `応募 ${campaign.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)} の結果確認が必要です`,
          );
      } catch {
        await store.updateApplication(userId, application.id, {
          status: "unknown_result",
          error: "応募結果が不明です。自動再送しません",
        });
        run.errors.push("応募結果を保存する際にエラーが発生しました");
      }
    }
    run.status = run.errors.length ? "failed" : "completed";
  } catch {
    run.status = "failed";
    run.errors.push("応募処理を実行できませんでした");
  }
  run.finishedAt = timestamp();
  await store.recordRun(userId, run);
  return run;
}
