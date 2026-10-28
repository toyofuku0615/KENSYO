import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLocalStore, type LocalStore } from "../src/lib/local-store";
import {
  decryptProfile,
  encryptProfile,
  encryptionKey,
} from "../src/lib/profile-crypto";
import {
  DEFAULT_PREFERENCES,
  type Campaign,
  type Profile,
} from "../src/core/types";
const profile: Profile = {
  name: "検証太郎",
  kana: "ケンショウタロウ",
  postalCode: "1000001",
  prefecture: "東京都",
  address: "検証住所1",
  phone: "09012345678",
  email: "test@example.invalid",
  birthDate: "1990-01-01",
};
const dirs: string[] = [];
const stores: LocalStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kensho-store-"));
  dirs.push(dir);
  const path = join(dir, "test.sqlite");
  const store = createLocalStore(path);
  stores.push(store);
  return { store, path, dir };
}
function campaign(id = "campaign-one"): Campaign {
  return {
    id,
    title: "検証",
    organizer: "テスト",
    officialUrl: "https://example.com/entry",
    entryUrl: "https://example.com/entry",
    imageUrl: null,
    prize: "景品",
    estimatedValue: 1000,
    winners: 10,
    startsAt: null,
    deadline: new Date(Date.now() + 86400_000).toISOString(),
    category: "食品・飲料",
    conditions: [],
    rules: {
      verdict: "permitted",
      reason: "検証用",
      evidence: [],
      reviewedAllTerms: true,
      japanOnly: true,
      minAge: null,
      purchaseRequired: false,
      membershipRequired: false,
      snsRequired: false,
      captcha: false,
      maxEntries: 1,
      requiredConsents: [],
      requiredFields: [],
      technicalAllowed: true,
    },
    sourceId: "fixture",
    discoveredAt: new Date().toISOString(),
    checkedAt: new Date().toISOString(),
    adapterId: "fixture",
    isDemo: true,
  };
}
async function ready(store: LocalStore, user = "alice", id = "campaign-one") {
  await store.saveProfile(user, profile);
  await store.savePreferences(user, {
    ...DEFAULT_PREFERENCES,
    autoApply: true,
    consentAt: new Date().toISOString(),
  });
  await store.upsertCampaign(user, campaign(id));
}

describe("encrypted user-scoped storage", () => {
  it("persists profiles encrypted and restores with the retained key", async () => {
    const { store, path, dir } = setup();
    await store.saveProfile("alice", profile);
    expect(await store.getProfile("alice")).toEqual(profile);
    const db = new DatabaseSync(path);
    const row = db.prepare("SELECT data FROM user_profiles").get() as {
      data: string;
    };
    expect(row.data).not.toContain(profile.address);
    expect(row.data).not.toContain(profile.email);
    db.close();
    expect(readFileSync(join(dir, "profile.key"), "utf8").trim()).toHaveLength(
      44,
    );
    const second = createLocalStore(path);
    stores.push(second);
    expect(await second.getProfile("alice")).toEqual(profile);
  });
  it("uses authenticated encryption bound to the owner", () => {
    const key = encryptionKey();
    const encrypted = encryptProfile(profile, key, "alice");
    expect(() => decryptProfile(encrypted, key, "bob")).toThrow();
    expect(() => decryptProfile(encrypted, encryptionKey(), "alice")).toThrow();
  });
  it("isolates profiles, campaigns, preferences, sources and application mutations", async () => {
    const { store } = setup();
    await ready(store);
    await store.savePreferences("bob", {
      ...DEFAULT_PREFERENCES,
      maxApplications: 2,
    });
    expect(await store.getProfile("bob")).toBeNull();
    expect(await store.listCampaigns("bob")).toEqual([]);
    expect((await store.getPreferences("bob")).maxApplications).toBe(2);
    const app = await store.claimApplication("alice", "campaign-one");
    expect(app).not.toBeNull();
    await expect(
      store.updateApplication("bob", app!.id, { status: "won" }),
    ).rejects.toThrow("not found");
    await expect(
      store.saveManualApplication("bob", "campaign-one", "won"),
    ).rejects.toThrow("not found");
    expect(await store.listApplications("bob")).toEqual([]);
  });
  it("deduplicates campaign identity independently for each owner", async () => {
    const { store } = setup();
    await store.upsertCampaign("alice", {
      ...campaign(),
      discoveredAt: "2026-01-01T00:00:00.000Z",
    });
    await store.upsertCampaign("alice", { ...campaign(), title: "更新済み" });
    await store.upsertCampaign("bob", campaign());
    expect(await store.listCampaigns("alice")).toHaveLength(1);
    expect((await store.listCampaigns("alice"))[0].title).toBe("更新済み");
    expect((await store.listCampaigns("alice"))[0].discoveredAt).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(await store.listCampaigns("bob")).toHaveLength(1);
  });
  it("atomically grants exactly one durable claim across two connections", async () => {
    const { store, path } = setup();
    await ready(store);
    const other = createLocalStore(path);
    stores.push(other);
    const results = await Promise.all([
      store.claimApplication("alice", "campaign-one"),
      other.claimApplication("alice", "campaign-one"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.listApplications("alice")).toHaveLength(1);
  });
  it("never retries an unknown or failed result", async () => {
    const { store } = setup();
    await ready(store);
    const app = await store.claimApplication("alice", "campaign-one");
    await store.updateApplication("alice", app!.id, {
      status: "unknown_result",
    });
    expect(await store.claimApplication("alice", "campaign-one")).toBeNull();
    await store.updateApplication("alice", app!.id, { status: "failed" });
    expect(await store.claimApplication("alice", "campaign-one")).toBeNull();
  });
  it("reconciles an abandoned in-flight claim to unknown without requeueing", async () => {
    const { store, path } = setup();
    await ready(store);
    await store.claimApplication("alice", "campaign-one");
    const db = new DatabaseSync(path);
    db.prepare("UPDATE applications SET updated_at=?").run(
      new Date(Date.now() - 31 * 60_000).toISOString(),
    );
    db.close();
    const applications = await store.listApplications("alice");
    expect(applications[0].status).toBe("unknown_result");
    expect(await store.claimApplication("alice", "campaign-one")).toBeNull();
  });
  it.each(["off", "emergency", "no-consent", "future-consent"])(
    "blocks claim when %s",
    async (condition) => {
      const { store } = setup();
      await ready(store);
      const pref = await store.getPreferences("alice");
      if (condition === "off") pref.autoApply = false;
      if (condition === "emergency") pref.emergencyStop = true;
      if (condition === "no-consent") pref.consentAt = null;
      if (condition === "future-consent")
        pref.consentAt = new Date(Date.now() + 60_000).toISOString();
      await store.savePreferences("alice", pref);
      expect(await store.claimApplication("alice", "campaign-one")).toBeNull();
    },
  );
  it("enforces the daily JST quota atomically across campaigns", async () => {
    const { store } = setup();
    await ready(store);
    await store.savePreferences("alice", {
      ...(await store.getPreferences("alice")),
      maxApplications: 1,
    });
    await store.upsertCampaign("alice", campaign("two"));
    expect(
      await store.claimApplication("alice", "campaign-one"),
    ).not.toBeNull();
    expect(await store.claimApplication("alice", "two")).toBeNull();
  });
  it("rejects expired and excluded-category campaigns", async () => {
    const { store } = setup();
    await ready(store);
    await store.upsertCampaign("alice", {
      ...campaign(),
      deadline: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await store.claimApplication("alice", "campaign-one")).toBeNull();
    await store.upsertCampaign("alice", campaign());
    await store.savePreferences("alice", {
      ...(await store.getPreferences("alice")),
      excludedCategories: ["食品・飲料"],
    });
    expect(await store.claimApplication("alice", "campaign-one")).toBeNull();
  });
  it("queues manual executions once and leases atomically per owner", async () => {
    const { store, path } = setup();
    await store.requestRun("alice", "collect");
    await store.requestRun("alice", "collect");
    await store.requestRun("bob", "apply");
    expect(await store.takeRunRequests("alice")).toEqual(["collect"]);
    expect(await store.takeRunRequests("alice")).toEqual([]);
    expect(await store.takeRunRequests("bob")).toEqual(["apply"]);
    const db = new DatabaseSync(path);
    db.prepare(
      "UPDATE run_requests SET lease_until=? WHERE user_id='alice'",
    ).run(new Date(Date.now() - 1000).toISOString());
    db.close();
    expect(await store.takeRunRequests("alice")).toEqual(["collect"]);
    await store.completeRunRequest("alice", "collect");
    expect(await store.takeRunRequests("alice")).toEqual([]);
  });
  it("records manual outcomes while blocking changes to in-flight submissions", async () => {
    const { store } = setup();
    await ready(store);
    const app = await store.claimApplication("alice", "campaign-one");
    await expect(
      store.saveManualApplication("alice", "campaign-one", "won", 5000),
    ).rejects.toThrow("in progress");
    await store.updateApplication("alice", app!.id, {
      status: "submitted",
      receipt: "TEST-123",
    });
    await store.saveManualApplication("alice", "campaign-one", "won", 5000);
    expect((await store.listApplications("alice"))[0]).toMatchObject({
      status: "won",
      prizeValue: 5000,
      receipt: "TEST-123",
    });
  });
  it("does not leak profile fields into automatic audit entries", async () => {
    const { store, path } = setup();
    await ready(store);
    const app = await store.claimApplication("alice", "campaign-one");
    await store.updateApplication("alice", app!.id, { status: "submitted" });
    const db = new DatabaseSync(path);
    const logs = db.prepare("SELECT data FROM audit_logs").all() as {
      data: string;
    }[];
    db.close();
    expect(logs.length).toBeGreaterThan(0);
    const text = JSON.stringify(logs);
    for (const value of [
      profile.name,
      profile.phone,
      profile.address,
      profile.email,
    ])
      expect(text).not.toContain(value);
  });
  it("deletes one account and all of its records while preserving others", async () => {
    const { store } = setup();
    await ready(store);
    await ready(store, "bob");
    await store.claimApplication("alice", "campaign-one");
    await store.requestRun("alice", "apply");
    await store.deleteUser("alice");
    expect(await store.getProfile("alice")).toBeNull();
    expect(await store.listCampaigns("alice")).toEqual([]);
    expect(await store.listApplications("alice")).toEqual([]);
    expect(await store.takeRunRequests("alice")).toEqual([]);
    expect(await store.getProfile("bob")).toEqual(profile);
  });
});
