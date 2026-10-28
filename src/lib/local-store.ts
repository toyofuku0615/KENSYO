import { LocalAIRepository } from "./ai/local-repository";
import type { AIRepository } from "../core/ai-types";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
  persistentKey,
} from "./profile-crypto";

type DataRow = { data: string };
export class LocalStore implements Store {
  readonly ai: AIRepository;
  private db: DatabaseSync;
  private key: Buffer;
  constructor(path: string, key?: string | Buffer) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.key = key
      ? encryptionKey(key)
      : path === ":memory:"
        ? encryptionKey()
        : persistentKey(join(dirname(path), "profile.key"));
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS user_profiles (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS user_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(user_id,id));
      CREATE TABLE IF NOT EXISTS campaigns (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(user_id,id));
      CREATE TABLE IF NOT EXISTS campaign_rules (user_id TEXT NOT NULL, campaign_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(user_id,campaign_id), FOREIGN KEY(user_id,campaign_id) REFERENCES campaigns(user_id,id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS rule_evidence (user_id TEXT NOT NULL, campaign_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(user_id,id), FOREIGN KEY(user_id,campaign_id) REFERENCES campaigns(user_id,id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS submission_adapters (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS applications (id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, campaign_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(user_id,campaign_id), FOREIGN KEY(user_id,campaign_id) REFERENCES campaigns(user_id,id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS applications_owner_date ON applications(user_id,created_at);
      CREATE TABLE IF NOT EXISTS application_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, campaign_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_requests (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, lease_until TEXT, PRIMARY KEY(user_id,kind));
      CREATE TABLE IF NOT EXISTS job_runs (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(user_id,id));
      CREATE TABLE IF NOT EXISTS notifications (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_logs (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    if (
      !(
        this.db.prepare("PRAGMA table_info(run_requests)").all() as {
          name: string;
        }[]
      ).some((column) => column.name === "lease_until")
    )
      this.db.exec("ALTER TABLE run_requests ADD COLUMN lease_until TEXT");
    this.ai = new LocalAIRepository(this.db, this.key);
    this.reconcileStale();
  }
  close() {
    this.db.close();
  }
  private ensureUser(userId: string) {
    this.db.prepare("INSERT OR IGNORE INTO users(id) VALUES (?)").run(userId);
  }
  private one<T>(table: string, userId: string, id?: string): T | null {
    const row = (
      id === undefined
        ? this.db
            .prepare(`SELECT data FROM ${table} WHERE user_id=?`)
            .get(userId)
        : this.db
            .prepare(`SELECT data FROM ${table} WHERE user_id=? AND id=?`)
            .get(userId, id)
    ) as DataRow | undefined;
    return row ? (JSON.parse(row.data) as T) : null;
  }
  private many<T>(table: string, userId: string): T[] {
    return (
      this.db
        .prepare(
          `SELECT data FROM ${table} WHERE user_id=? ORDER BY rowid DESC`,
        )
        .all(userId) as DataRow[]
    ).map((row) => JSON.parse(row.data) as T);
  }
  private reconcileStale() {
    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    const rows = this.db
      .prepare(
        "SELECT id,user_id,data FROM applications WHERE status='submitting' AND updated_at < ?",
      )
      .all(cutoff) as { id: string; user_id: string; data: string }[];
    for (const row of rows) {
      const value: Application = {
        ...JSON.parse(row.data),
        status: "unknown_result",
        error: "ワーカー中断後の結果不明。自動再送しません。",
        updatedAt: new Date().toISOString(),
      };
      this.db
        .prepare(
          "UPDATE applications SET status=?,updated_at=?,data=? WHERE id=? AND user_id=? AND status='submitting'",
        )
        .run(
          value.status,
          value.updatedAt,
          JSON.stringify(value),
          row.id,
          row.user_id,
        );
      this.db
        .prepare(
          "UPDATE application_jobs SET status='unknown_result' WHERE id=? AND user_id=?",
        )
        .run(row.id, row.user_id);
    }
  }
  async getProfile(userId: string): Promise<Profile | null> {
    const row = this.db
      .prepare("SELECT data FROM user_profiles WHERE user_id=?")
      .get(userId) as DataRow | undefined;
    return row ? decryptProfile(row.data, this.key, userId) : null;
  }
  async saveProfile(userId: string, profile: Profile) {
    this.ensureUser(userId);
    this.db
      .prepare(
        "INSERT INTO user_profiles(user_id,data) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data",
      )
      .run(userId, encryptProfile(profile, this.key, userId));
  }
  async getPreferences(userId: string): Promise<Preferences> {
    return (
      this.one<Preferences>("user_preferences", userId) ??
      structuredClone(DEFAULT_PREFERENCES)
    );
  }
  async savePreferences(userId: string, preferences: Preferences) {
    this.ensureUser(userId);
    this.db
      .prepare(
        "INSERT INTO user_preferences(user_id,data) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data",
      )
      .run(userId, JSON.stringify(preferences));
  }
  async listSources(userId: string): Promise<Source[]> {
    return this.many<Source>("sources", userId);
  }
  async saveSource(userId: string, source: Source) {
    this.ensureUser(userId);
    this.db
      .prepare(
        "INSERT INTO sources(user_id,id,data) VALUES (?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET data=excluded.data",
      )
      .run(userId, source.id, JSON.stringify(source));
  }
  async deleteSource(userId: string, id: string) {
    this.db
      .prepare("DELETE FROM sources WHERE user_id=? AND id=?")
      .run(userId, id);
  }
  async listCampaigns(userId: string): Promise<Campaign[]> {
    return this.many<Campaign>("campaigns", userId);
  }
  async upsertCampaign(userId: string, campaign: Campaign) {
    this.ensureUser(userId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.one<Campaign>("campaigns", userId, campaign.id);
      if (existing)
        campaign = { ...campaign, discoveredAt: existing.discoveredAt };
      this.db
        .prepare(
          "INSERT INTO campaigns(user_id,id,data) VALUES (?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET data=excluded.data",
        )
        .run(userId, campaign.id, JSON.stringify(campaign));
      this.db
        .prepare(
          "INSERT INTO campaign_rules(user_id,campaign_id,data) VALUES (?,?,?) ON CONFLICT(user_id,campaign_id) DO UPDATE SET data=excluded.data",
        )
        .run(userId, campaign.id, JSON.stringify(campaign.rules));
      this.db
        .prepare("DELETE FROM rule_evidence WHERE user_id=? AND campaign_id=?")
        .run(userId, campaign.id);
      for (const item of campaign.rules.evidence)
        this.db
          .prepare(
            "INSERT INTO rule_evidence(user_id,campaign_id,id,data) VALUES (?,?,?,?)",
          )
          .run(userId, campaign.id, randomUUID(), JSON.stringify(item));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async listApplications(userId: string): Promise<Application[]> {
    this.reconcileStale();
    return this.many<Application>("applications", userId);
  }
  async claimApplication(
    userId: string,
    campaignId: string,
  ): Promise<Application | null> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prefs = this.one<Preferences>("user_preferences", userId);
      const campaign = this.one<Campaign>("campaigns", userId, campaignId);
      const now = new Date();
      const consent = prefs?.consentAt
        ? new Date(prefs.consentAt).getTime()
        : NaN;
      const jstDay = new Date(now.getTime() + 9 * 3600_000)
        .toISOString()
        .slice(0, 10);
      const start = new Date(`${jstDay}T00:00:00+09:00`).toISOString();
      const count = this.db
        .prepare(
          "SELECT count(*) AS total FROM applications WHERE user_id=? AND created_at>=?",
        )
        .get(userId, start) as { total: number };
      const valid =
        prefs &&
        campaign &&
        prefs.autoApply &&
        !prefs.emergencyStop &&
        Number.isFinite(consent) &&
        consent <= now.getTime() &&
        count.total < Math.min(100, Math.max(0, prefs.maxApplications)) &&
        this.db
          .prepare("SELECT 1 FROM user_profiles WHERE user_id=?")
          .get(userId) &&
        new Date(campaign.deadline).getTime() > now.getTime() &&
        (!campaign.startsAt ||
          new Date(campaign.startsAt).getTime() <= now.getTime()) &&
        prefs.categories.includes(campaign.category) &&
        !prefs.excludedCategories.includes(campaign.category);
      if (
        !valid ||
        this.db
          .prepare(
            "SELECT 1 FROM applications WHERE user_id=? AND campaign_id=?",
          )
          .get(userId, campaignId)
      ) {
        this.db.exec("COMMIT");
        return null;
      }
      const app: Application = {
        id: randomUUID(),
        campaignId,
        status: "submitting",
        receipt: null,
        error: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        prizeValue: null,
      };
      this.db
        .prepare(
          "INSERT INTO applications(id,user_id,campaign_id,status,created_at,updated_at,data) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          app.id,
          userId,
          campaignId,
          app.status,
          app.createdAt,
          app.updatedAt,
          JSON.stringify(app),
        );
      this.db
        .prepare(
          "INSERT INTO application_jobs(id,user_id,campaign_id,status,created_at) VALUES (?,?,?,?,?)",
        )
        .run(app.id, userId, campaignId, app.status, app.createdAt);
      this.db
        .prepare("INSERT INTO audit_logs(user_id,id,data) VALUES (?,?,?)")
        .run(
          userId,
          randomUUID(),
          JSON.stringify({
            action: "application.claimed",
            campaignId,
            detail: "排他制御により応募権を確保",
            createdAt: now.toISOString(),
          }),
        );
      this.db.exec("COMMIT");
      return app;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async updateApplication(
    userId: string,
    id: string,
    patch: Partial<
      Pick<Application, "status" | "receipt" | "error" | "prizeValue">
    >,
  ) {
    const current = this.one<Application>("applications", userId, id);
    if (!current) throw new Error("Application not found");
    const app = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        "UPDATE applications SET status=?,updated_at=?,data=? WHERE user_id=? AND id=?",
      )
      .run(app.status, app.updatedAt, JSON.stringify(app), userId, id);
    this.db
      .prepare("UPDATE application_jobs SET status=? WHERE user_id=? AND id=?")
      .run(app.status, userId, id);
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
    if (!this.one<Campaign>("campaigns", userId, campaignId))
      throw new Error("Campaign not found");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          "SELECT data FROM applications WHERE user_id=? AND campaign_id=?",
        )
        .get(userId, campaignId) as DataRow | undefined;
      const current = row ? (JSON.parse(row.data) as Application) : null;
      if (current?.status === "submitting")
        throw new Error("Application is in progress");
      const now = new Date().toISOString();
      const app: Application = {
        id: current?.id ?? randomUUID(),
        campaignId,
        status,
        receipt: current?.receipt ?? null,
        error: null,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
        prizeValue: status === "won" ? (prizeValue ?? 0) : null,
      };
      this.db
        .prepare(
          "INSERT INTO applications(id,user_id,campaign_id,status,created_at,updated_at,data) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,campaign_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,data=excluded.data",
        )
        .run(
          app.id,
          userId,
          campaignId,
          status,
          app.createdAt,
          now,
          JSON.stringify(app),
        );
      this.db
        .prepare("INSERT INTO audit_logs(user_id,id,data) VALUES (?,?,?)")
        .run(
          userId,
          randomUUID(),
          JSON.stringify({
            action: "application.manual",
            campaignId,
            detail: status,
            createdAt: now,
          }),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async recordRun(userId: string, run: JobRun) {
    this.ensureUser(userId);
    this.db
      .prepare(
        "INSERT INTO job_runs(user_id,id,data) VALUES (?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET data=excluded.data",
      )
      .run(userId, run.id, JSON.stringify(run));
  }
  async listRuns(userId: string): Promise<JobRun[]> {
    return this.many<JobRun>("job_runs", userId).slice(0, 100);
  }
  async audit(userId: string, entry: AuditEntry) {
    this.ensureUser(userId);
    this.db
      .prepare("INSERT INTO audit_logs(user_id,id,data) VALUES (?,?,?)")
      .run(userId, randomUUID(), JSON.stringify(entry));
  }
  async deleteUser(userId: string) {
    this.db.prepare("DELETE FROM users WHERE id=?").run(userId);
  }
  async requestRun(userId: string, kind: "collect" | "apply") {
    this.ensureUser(userId);
    this.db
      .prepare("INSERT OR IGNORE INTO run_requests(user_id,kind) VALUES (?,?)")
      .run(userId, kind);
  }
  async takeRunRequests(userId: string): Promise<Array<"collect" | "apply">> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const rows = this.db
        .prepare(
          "SELECT kind FROM run_requests WHERE user_id=? AND (lease_until IS NULL OR lease_until<=?)",
        )
        .all(userId, now) as { kind: "collect" | "apply" }[];
      this.db
        .prepare(
          "UPDATE run_requests SET lease_until=? WHERE user_id=? AND (lease_until IS NULL OR lease_until<=?)",
        )
        .run(new Date(Date.now() + 30 * 60_000).toISOString(), userId, now);
      this.db.exec("COMMIT");
      return rows.map((row) => row.kind);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async completeRunRequest(userId: string, kind: "collect" | "apply") {
    this.db
      .prepare("DELETE FROM run_requests WHERE user_id=? AND kind=?")
      .run(userId, kind);
  }
  async listUserIds(): Promise<string[]> {
    return (
      this.db.prepare("SELECT id FROM users").all() as { id: string }[]
    ).map((row) => row.id);
  }
}
export function createLocalStore(
  path: string,
  key?: string | Buffer,
): LocalStore {
  return new LocalStore(path, key);
}
