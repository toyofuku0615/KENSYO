import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_AI_SETTINGS,
  type AIConnection,
  type AIRepository,
  type AISettings,
  type AIUsage,
  type AIPurpose,
  type AIReservation,
} from "../../core/ai-types";
import { decryptAPIKey, encryptAPIKey, safeAIError } from "./secrets";
import { aiSettingsSchema, emptyAIUsage, periodStarts } from "./usage";
const DEFAULT_CONNECTION: AIConnection = {
  status: "unconfigured",
  checkedAt: null,
  error: null,
};
type CallRow = {
  purpose: AIPurpose;
  id: string;
  created_at: string;
  reserved_tokens: number;
  input_tokens: number;
  output_tokens: number;
  success: number | null;
  estimated: number;
  error: string | null;
  cooldown_until: string | null;
};
export class LocalAIRepository implements AIRepository {
  constructor(
    private db: DatabaseSync,
    private key: Buffer,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS ai_settings(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,data TEXT NOT NULL,connection TEXT NOT NULL,cooldown_until TEXT);
 CREATE TABLE IF NOT EXISTS ai_credentials(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,ciphertext TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS ai_usage(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,purpose TEXT NOT NULL,model TEXT NOT NULL,created_at TEXT NOT NULL,reserved_tokens INTEGER NOT NULL,input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0,success INTEGER,estimated INTEGER NOT NULL DEFAULT 1,error TEXT,cooldown_until TEXT);
 CREATE INDEX IF NOT EXISTS ai_usage_owner_date ON ai_usage(user_id,created_at);
 CREATE TABLE IF NOT EXISTS ai_cache(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,key TEXT NOT NULL,data TEXT NOT NULL,expires_at TEXT NOT NULL,PRIMARY KEY(user_id,key));
 CREATE TABLE IF NOT EXISTS ai_cache_hits(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,month TEXT NOT NULL,total INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,month));`);
  }
  private ensure(user: string) {
    this.db.prepare("INSERT OR IGNORE INTO users(id) VALUES (?)").run(user);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO ai_settings(user_id,data,connection) VALUES (?,?,?)",
      )
      .run(
        user,
        JSON.stringify(DEFAULT_AI_SETTINGS),
        JSON.stringify(DEFAULT_CONNECTION),
      );
  }
  async getSettings(user: string): Promise<AISettings> {
    const row = this.db
      .prepare("SELECT data FROM ai_settings WHERE user_id=?")
      .get(user) as { data: string } | undefined;
    return row
      ? aiSettingsSchema.parse(JSON.parse(row.data))
      : structuredClone(DEFAULT_AI_SETTINGS);
  }
  async saveSettings(user: string, settings: AISettings) {
    const safe = aiSettingsSchema.parse(settings);
    this.ensure(user);
    const previous = this.db
      .prepare("SELECT data FROM ai_settings WHERE user_id=?")
      .get(user) as { data: string };
    if (JSON.parse(previous.data).model !== safe.model)
      this.db
        .prepare("UPDATE ai_settings SET connection=? WHERE user_id=?")
        .run(JSON.stringify(DEFAULT_CONNECTION), user);
    this.db
      .prepare("UPDATE ai_settings SET data=? WHERE user_id=?")
      .run(JSON.stringify(safe), user);
  }
  async getKey(user: string) {
    const row = this.db
      .prepare("SELECT ciphertext FROM ai_credentials WHERE user_id=?")
      .get(user) as { ciphertext: string } | undefined;
    return row ? decryptAPIKey(row.ciphertext, this.key, user) : null;
  }
  async saveKey(user: string, value: string) {
    const encrypted = encryptAPIKey(value, this.key, user);
    this.ensure(user);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO ai_credentials(user_id,ciphertext) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET ciphertext=excluded.ciphertext",
        )
        .run(user, encrypted);
      this.resetKeyState(user);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async deleteKey(user: string) {
    this.ensure(user);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM ai_credentials WHERE user_id=?").run(user);
      this.resetKeyState(user);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private resetKeyState(user: string) {
    this.db
      .prepare("UPDATE ai_settings SET connection=? WHERE user_id=?")
      .run(JSON.stringify(DEFAULT_CONNECTION), user);
    this.db.prepare("DELETE FROM ai_cache WHERE user_id=?").run(user);
  }
  async getConnection(user: string): Promise<AIConnection> {
    const row = this.db
      .prepare("SELECT connection FROM ai_settings WHERE user_id=?")
      .get(user) as { connection: string } | undefined;
    return row ? JSON.parse(row.connection) : { ...DEFAULT_CONNECTION };
  }
  async saveConnection(user: string, connection: AIConnection) {
    this.ensure(user);
    this.db
      .prepare("UPDATE ai_settings SET connection=? WHERE user_id=?")
      .run(
        JSON.stringify({ ...connection, error: safeAIError(connection.error) }),
        user,
      );
  }
  async getUsage(user: string): Promise<AIUsage> {
    const now = new Date(),
      starts = periodStarts(now);
    const rows = this.db
      .prepare(
        "SELECT * FROM ai_usage WHERE user_id=? AND created_at>=? ORDER BY created_at DESC,rowid DESC",
      )
      .all(user, starts.month) as CallRow[];
    const usage = emptyAIUsage();
    usage.monthCalls = rows.length;
    usage.todayCalls = rows.filter(
      (row) => row.created_at >= starts.day,
    ).length;
    for (const row of rows) {
      usage.inputTokens +=
        row.success === null ? row.reserved_tokens : row.input_tokens;
      usage.outputTokens += row.output_tokens;
      if (row.success === 1) usage.successes++;
      else if (row.success === 0) usage.failures++;
      if (["campaign", "form", "answer"].includes(row.purpose)) {
        if (row.success === 1) usage.analysisSuccesses++;
        else if (row.success === 0) usage.analysisFailures++;
      }
      if (row.estimated) usage.estimatedTokens = true;
    }
    usage.lastError = rows.find((row) => row.error)?.error ?? null;
    const row = this.db
      .prepare("SELECT cooldown_until FROM ai_settings WHERE user_id=?")
      .get(user) as { cooldown_until: string | null } | undefined;
    usage.cooldownUntil =
      row?.cooldown_until && row.cooldown_until > now.toISOString()
        ? row.cooldown_until
        : null;
    usage.cachedHits =
      (
        this.db
          .prepare(
            "SELECT total FROM ai_cache_hits WHERE user_id=? AND month=?",
          )
          .get(user, starts.month) as { total: number } | undefined
      )?.total ?? 0;
    return usage;
  }
  async reserveCall(
    user: string,
    purpose: AIPurpose,
    model: string,
    reservedTokens: number,
  ): Promise<AIReservation | null> {
    if (!Number.isSafeInteger(reservedTokens) || reservedTokens < 0)
      throw new Error("Invalid AI token reservation");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.ensure(user);
      const row = this.db
        .prepare("SELECT data,cooldown_until FROM ai_settings WHERE user_id=?")
        .get(user) as { data: string; cooldown_until: string | null };
      const settings = aiSettingsSchema.parse(JSON.parse(row.data));
      const now = new Date(),
        stamp = now.toISOString(),
        starts = periodStarts(now);
      const count = this.db
        .prepare(
          "SELECT count(*) as total,sum(CASE WHEN created_at>=? THEN 1 ELSE 0 END) as daily,sum(CASE WHEN created_at>=? THEN 1 ELSE 0 END) as recent,sum(CASE WHEN success IS NULL THEN reserved_tokens ELSE input_tokens+output_tokens END) as tokens FROM ai_usage WHERE user_id=? AND created_at>=?",
        )
        .get(starts.day, starts.minute, user, starts.month) as {
        total: number;
        daily: number;
        recent: number;
        tokens: number;
      };
      if (
        (row.cooldown_until && row.cooldown_until > stamp) ||
        count.total >= settings.monthlyLimit ||
        count.daily >= settings.dailyLimit ||
        count.recent >= settings.perMinuteLimit ||
        (count.tokens ?? 0) + reservedTokens > settings.monthlyTokenLimit
      ) {
        this.db.exec("COMMIT");
        return null;
      }
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO ai_usage(id,user_id,purpose,model,created_at,reserved_tokens) VALUES (?,?,?,?,?,?)",
        )
        .run(id, user, purpose, model, stamp, reservedTokens);
      this.db.exec("COMMIT");
      return { id };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
    const input = Math.max(0, Math.floor(result.inputTokens)),
      output = Math.max(0, Math.floor(result.outputTokens));
    if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output))
      throw new Error("Invalid AI token totals");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          "SELECT reserved_tokens FROM ai_usage WHERE user_id=? AND id=? AND success IS NULL",
        )
        .get(user, id) as { reserved_tokens: number } | undefined;
      if (row) {
        this.db
          .prepare(
            "UPDATE ai_usage SET success=?,input_tokens=?,output_tokens=?,estimated=?,error=?,cooldown_until=? WHERE user_id=? AND id=? AND success IS NULL",
          )
          .run(
            result.success ? 1 : 0,
            result.estimated ? Math.max(input, row.reserved_tokens) : input,
            output,
            result.estimated ? 1 : 0,
            safeAIError(result.error),
            result.cooldownUntil ?? null,
            user,
            id,
          );
        if (
          result.cooldownUntil &&
          Number.isFinite(Date.parse(result.cooldownUntil))
        )
          this.db
            .prepare(
              "UPDATE ai_settings SET cooldown_until=CASE WHEN cooldown_until IS NULL OR cooldown_until<? THEN ? ELSE cooldown_until END WHERE user_id=?",
            )
            .run(result.cooldownUntil, result.cooldownUntil, user);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async getCache(user: string, key: string) {
    const row = this.db
      .prepare(
        "SELECT data FROM ai_cache WHERE user_id=? AND key=? AND expires_at>?",
      )
      .get(user, key, new Date().toISOString()) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }
  async setCache(user: string, key: string, value: unknown, expiresAt: string) {
    if (!Number.isFinite(Date.parse(expiresAt)) || key.length > 200)
      throw new Error("Invalid AI cache metadata");
    const data = JSON.stringify(value);
    if (data.length > 200000) throw new Error("AI cache too large");
    this.ensure(user);
    this.db
      .prepare(
        "INSERT INTO ai_cache(user_id,key,data,expires_at) VALUES (?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at",
      )
      .run(user, key, data, new Date(expiresAt).toISOString());
  }
  async hitCache(user: string) {
    this.ensure(user);
    this.db
      .prepare(
        "INSERT INTO ai_cache_hits(user_id,month,total) VALUES (?,?,1) ON CONFLICT(user_id,month) DO UPDATE SET total=total+1",
      )
      .run(user, periodStarts().month);
  }
}
