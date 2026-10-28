import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_PREFERENCES,
  type Application,
  type AuditEntry,
  type Campaign,
  type JobRun,
  type Preferences,
  type Profile,
  type Source,
  type Store,
} from "../core/types";
import {
  decryptProfile,
  encryptionKey,
  encryptProfile,
} from "./profile-crypto";

export class SupabaseStore implements Store {
  private client: SupabaseClient;
  private key: Buffer;
  constructor(url: string, serviceKey: string, profileKey: string) {
    this.client = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    this.key = encryptionKey(profileKey);
  }
  private check(error: { message: string } | null) {
    if (error) throw new Error("Database operation failed");
  }
  private async ensureUser(userId: string) {
    const { error } = await this.client
      .from("users")
      .upsert({ id: userId }, { onConflict: "id", ignoreDuplicates: true });
    this.check(error);
  }
  private async one<T>(
    table: string,
    userId: string,
    id?: string,
  ): Promise<T | null> {
    let query = this.client.from(table).select("data").eq("user_id", userId);
    if (id !== undefined) query = query.eq("id", id);
    const { data, error } = await query.maybeSingle();
    this.check(error);
    return (data?.data as T) ?? null;
  }
  private async many<T>(table: string, userId: string): Promise<T[]> {
    const result: T[] = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await this.client
        .from(table)
        .select("data")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .order("id")
        .range(offset, offset + 499);
      this.check(error);
      result.push(...(data ?? []).map((row) => row.data as T));
      if (!data || data.length < 500) return result;
    }
  }
  async getProfile(userId: string): Promise<Profile | null> {
    const row = await this.one<{ ciphertext: string }>("user_profiles", userId);
    return row ? decryptProfile(row.ciphertext, this.key, userId) : null;
  }
  async saveProfile(userId: string, profile: Profile) {
    await this.ensureUser(userId);
    const { error } = await this.client
      .from("user_profiles")
      .upsert({
        user_id: userId,
        data: { ciphertext: encryptProfile(profile, this.key, userId) },
      });
    this.check(error);
  }
  async getPreferences(userId: string): Promise<Preferences> {
    return (
      (await this.one<Preferences>("user_preferences", userId)) ??
      structuredClone(DEFAULT_PREFERENCES)
    );
  }
  async savePreferences(userId: string, preferences: Preferences) {
    await this.ensureUser(userId);
    const { error } = await this.client
      .from("user_preferences")
      .upsert({ user_id: userId, data: preferences });
    this.check(error);
  }
  async listSources(userId: string): Promise<Source[]> {
    return this.many<Source>("sources", userId);
  }
  async saveSource(userId: string, source: Source) {
    await this.ensureUser(userId);
    const { error } = await this.client
      .from("sources")
      .upsert(
        { user_id: userId, id: source.id, data: source },
        { onConflict: "user_id,id" },
      );
    this.check(error);
  }
  async deleteSource(userId: string, id: string) {
    const { error } = await this.client
      .from("sources")
      .delete()
      .eq("user_id", userId)
      .eq("id", id);
    this.check(error);
  }
  async listCampaigns(userId: string): Promise<Campaign[]> {
    return this.many<Campaign>("campaigns", userId);
  }
  async upsertCampaign(userId: string, campaign: Campaign) {
    await this.ensureUser(userId);
    const { error } = await this.client.rpc("upsert_campaign", {
      p_user_id: userId,
      p_campaign: campaign,
    });
    this.check(error);
  }
  async listApplications(userId: string): Promise<Application[]> {
    const { error } = await this.client.rpc("reconcile_stale_applications", {
      p_user_id: userId,
    });
    this.check(error);
    return this.many<Application>("applications", userId);
  }
  async claimApplication(
    userId: string,
    campaignId: string,
  ): Promise<Application | null> {
    const { data, error } = await this.client.rpc("claim_application", {
      p_user_id: userId,
      p_campaign_id: campaignId,
    });
    this.check(error);
    return (data as Application) ?? null;
  }
  async updateApplication(
    userId: string,
    id: string,
    patch: Partial<
      Pick<Application, "status" | "receipt" | "error" | "prizeValue">
    >,
  ) {
    const current = await this.one<Application>("applications", userId, id);
    if (!current) throw new Error("Application not found");
    const app = { ...current, ...patch, updatedAt: new Date().toISOString() };
    const { error } = await this.client
      .from("applications")
      .update({ data: app, status: app.status, updated_at: app.updatedAt })
      .eq("user_id", userId)
      .eq("id", id);
    this.check(error);
    const result = await this.client
      .from("application_jobs")
      .update({ status: app.status })
      .eq("user_id", userId)
      .eq("id", id);
    this.check(result.error);
    await this.audit(userId, {
      action: "application.updated",
      campaignId: app.campaignId,
      detail: app.status,
      createdAt: app.updatedAt,
    });
  }
  async saveManualApplication(
    userId: string,
    campaignId: string,
    status: "submitted" | "won" | "lost",
    prizeValue?: number,
  ) {
    const { error } = await this.client.rpc("save_manual_application", {
      p_user_id: userId,
      p_campaign_id: campaignId,
      p_status: status,
      p_prize_value: prizeValue ?? 0,
    });
    this.check(error);
  }
  async recordRun(userId: string, run: JobRun) {
    await this.ensureUser(userId);
    const { error } = await this.client
      .from("job_runs")
      .upsert(
        { user_id: userId, id: run.id, data: run },
        { onConflict: "user_id,id" },
      );
    this.check(error);
  }
  async listRuns(userId: string): Promise<JobRun[]> {
    return (await this.many<JobRun>("job_runs", userId)).slice(0, 100);
  }
  async audit(userId: string, entry: AuditEntry) {
    await this.ensureUser(userId);
    const { error } = await this.client
      .from("audit_logs")
      .insert({ user_id: userId, id: randomUUID(), data: entry });
    this.check(error);
  }
  async deleteUser(userId: string) {
    const { error } = await this.client.auth.admin.deleteUser(userId);
    this.check(error);
  }
  async requestRun(userId: string, kind: "collect" | "apply") {
    await this.ensureUser(userId);
    const { error } = await this.client
      .from("run_requests")
      .upsert(
        { user_id: userId, kind },
        { onConflict: "user_id,kind", ignoreDuplicates: true },
      );
    this.check(error);
  }
  async takeRunRequests(userId: string): Promise<Array<"collect" | "apply">> {
    const { data, error } = await this.client.rpc("take_run_requests", {
      p_user_id: userId,
    });
    this.check(error);
    return (data ?? []) as Array<"collect" | "apply">;
  }
  async completeRunRequest(userId: string, kind: "collect" | "apply") {
    const { error } = await this.client
      .from("run_requests")
      .delete()
      .eq("user_id", userId)
      .eq("kind", kind);
    this.check(error);
  }
  async listUserIds(): Promise<string[]> {
    const result: string[] = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await this.client
        .from("users")
        .select("id")
        .order("id")
        .range(offset, offset + 499);
      this.check(error);
      result.push(...(data ?? []).map((row) => row.id as string));
      if (!data || data.length < 500) return result;
    }
  }
}
