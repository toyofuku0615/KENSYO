import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_AI_SETTINGS,
  type AIRepository,
  type AIConnection,
  type AIUsage,
  type AISettings,
  type AIPurpose,
  type AIReservation,
} from "../../core/ai-types";
import { decryptAPIKey, encryptAPIKey, safeAIError } from "./secrets";
import { aiSettingsSchema } from "./usage";
export class SupabaseAIRepository implements AIRepository {
  constructor(
    private client: SupabaseClient,
    private key: Buffer,
  ) {}
  private check(error: unknown) {
    if (error) throw new Error("AI database operation failed");
  }
  private async ensure(user: string) {
    this.check(
      (
        await this.client
          .from("users")
          .upsert({ id: user }, { onConflict: "id", ignoreDuplicates: true })
      ).error,
    );
    this.check(
      (
        await this.client
          .from("ai_settings")
          .upsert(
            { user_id: user },
            { onConflict: "user_id", ignoreDuplicates: true },
          )
      ).error,
    );
  }
  async getSettings(user: string): Promise<AISettings> {
    const { data, error } = await this.client
      .from("ai_settings")
      .select("data")
      .eq("user_id", user)
      .maybeSingle();
    this.check(error);
    return data
      ? aiSettingsSchema.parse(data.data)
      : structuredClone(DEFAULT_AI_SETTINGS);
  }
  async saveSettings(user: string, settings: AISettings) {
    const parsed = aiSettingsSchema.parse(settings);
    const previous = await this.getSettings(user);
    await this.ensure(user);
    this.check(
      (
        await this.client
          .from("ai_settings")
          .update({
            data: parsed,
            ...(previous.model !== parsed.model
              ? {
                  connection: {
                    status: "unconfigured",
                    checkedAt: null,
                    error: null,
                  },
                }
              : {}),
          })
          .eq("user_id", user)
      ).error,
    );
  }
  async getKey(user: string) {
    const { data, error } = await this.client
      .from("ai_credentials")
      .select("ciphertext")
      .eq("user_id", user)
      .maybeSingle();
    this.check(error);
    return data ? decryptAPIKey(data.ciphertext, this.key, user) : null;
  }
  async saveKey(user: string, key: string) {
    const ciphertext = encryptAPIKey(key, this.key, user);
    await this.ensure(user);
    this.check(
      (
        await this.client
          .from("ai_credentials")
          .upsert({ user_id: user, ciphertext })
      ).error,
    );
    this.check(
      (await this.client.rpc("ai_reset_key_state", { p_user_id: user })).error,
    );
  }
  async deleteKey(user: string) {
    await this.ensure(user);
    this.check(
      (await this.client.from("ai_credentials").delete().eq("user_id", user))
        .error,
    );
    this.check(
      (await this.client.rpc("ai_reset_key_state", { p_user_id: user })).error,
    );
  }
  async getConnection(user: string): Promise<AIConnection> {
    const { data, error } = await this.client
      .from("ai_settings")
      .select("connection")
      .eq("user_id", user)
      .maybeSingle();
    this.check(error);
    return (
      data?.connection ?? {
        status: "unconfigured",
        checkedAt: null,
        error: null,
      }
    );
  }
  async saveConnection(user: string, connection: AIConnection) {
    await this.ensure(user);
    this.check(
      (
        await this.client
          .from("ai_settings")
          .update({
            connection: { ...connection, error: safeAIError(connection.error) },
          })
          .eq("user_id", user)
      ).error,
    );
  }
  async getUsage(user: string): Promise<AIUsage> {
    const { data, error } = await this.client.rpc("ai_get_usage", {
      p_user_id: user,
    });
    this.check(error);
    return data as AIUsage;
  }
  async reserveCall(
    user: string,
    purpose: AIPurpose,
    model: string,
    reservedTokens: number,
  ): Promise<AIReservation | null> {
    if (!Number.isSafeInteger(reservedTokens) || reservedTokens < 0)
      throw new Error("Invalid AI token reservation");
    await this.ensure(user);
    const { data, error } = await this.client.rpc("ai_reserve_call", {
      p_user_id: user,
      p_purpose: purpose,
      p_model: model,
      p_reserved_tokens: reservedTokens,
    });
    this.check(error);
    return data ? { id: data as string } : null;
  }
  async finishCall(
    user: string,
    id: string,
    result: {
      success: boolean;
      inputTokens: number;
      outputTokens: number;
      error: string | null;
      estimated: boolean;
      cooldownUntil?: string | null;
    },
  ) {
    if (
      !Number.isSafeInteger(result.inputTokens) ||
      !Number.isSafeInteger(result.outputTokens) ||
      result.inputTokens < 0 ||
      result.outputTokens < 0
    )
      throw new Error("Invalid AI token totals");
    this.check(
      (
        await this.client.rpc("ai_finish_call", {
          p_user_id: user,
          p_id: id,
          p_result: { ...result, error: safeAIError(result.error) },
        })
      ).error,
    );
  }
  async getCache(user: string, key: string) {
    const { data, error } = await this.client
      .from("ai_cache")
      .select("data")
      .eq("user_id", user)
      .eq("key", key)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    this.check(error);
    return data?.data ?? null;
  }
  async setCache(user: string, key: string, value: unknown, expiresAt: string) {
    if (
      !Number.isFinite(Date.parse(expiresAt)) ||
      key.length > 200 ||
      JSON.stringify(value).length > 200000
    )
      throw new Error("Invalid AI cache metadata");
    await this.ensure(user);
    this.check(
      (
        await this.client
          .from("ai_cache")
          .upsert(
            { user_id: user, key, data: value, expires_at: expiresAt },
            { onConflict: "user_id,key" },
          )
      ).error,
    );
  }
  async hitCache(user: string) {
    await this.ensure(user);
    this.check(
      (await this.client.rpc("ai_hit_cache", { p_user_id: user })).error,
    );
  }
}
