import { randomUUID } from "node:crypto";
import type { JobRun, Store } from "./types";
import { collectSource } from "./collection";
import { decideEligibility, rankCampaign } from "./analysis";
import {
  submitWithBrowser,
  supportsCampaign,
  type Submitter,
} from "../automation/browser";

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
): Promise<JobRun> {
  const run = newRun("collect");
  await store.recordRun(userId, run);
  try {
    const preferences = await store.getPreferences(userId);
    if (preferences.emergencyStop) throw new Error("stopped");
    const sources = (await store.listSources(userId)).filter(
      (source) => source.enabled,
    );
    for (const source of sources) {
      if ((await store.getPreferences(userId)).emergencyStop) break;
      try {
        if (source.kind === "fixture" && process.env.KENSHO_MODE === "supabase")
          continue;
        const campaigns = await collectSource(source);
        for (const campaign of campaigns) {
          if (new Date(campaign.deadline).getTime() <= Date.now()) continue;
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
): Promise<JobRun> {
  const run = newRun("apply");
  await store.recordRun(userId, run);
  try {
    const campaigns = (await store.listCampaigns(userId)).sort(
      (a, b) => rankCampaign(b) - rankCampaign(a),
    );
    for (const campaign of campaigns) {
      if (campaign.isDemo && process.env.KENSHO_MODE === "supabase") continue;
      const prefs = await store.getPreferences(userId);
      if (!prefs.autoApply || prefs.emergencyStop || !prefs.consentAt) break;
      const profile = await store.getProfile(userId);
      const decision = decideEligibility(campaign, profile, prefs);
      if (!decision.eligible || !profile) continue;
      // Unknown sites stay in the manual queue without reserving a submission.
      if (!supportsCampaign(campaign)) continue;
      const application = await store.claimApplication(userId, campaign.id);
      if (!application) continue;
      try {
        const finalCheck = async () => {
          const current = await store.getPreferences(userId);
          const currentProfile = await store.getProfile(userId);
          return (
            JSON.stringify(currentProfile) === JSON.stringify(profile) &&
            decideEligibility(campaign, currentProfile, current).eligible &&
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
