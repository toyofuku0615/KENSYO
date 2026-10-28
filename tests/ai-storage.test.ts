import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLocalStore, type LocalStore } from "../src/lib/local-store";
import { DEFAULT_AI_SETTINGS } from "../src/core/ai-types";
import { decryptAPIKey, encryptAPIKey } from "../src/lib/ai/secrets";
import { randomBytes } from "node:crypto";
const stores: LocalStore[] = [],
  dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kensho-ai-"));
  dirs.push(dir);
  const path = join(dir, "test.sqlite"),
    store = createLocalStore(path);
  stores.push(store);
  return { store, path };
}
describe("encrypted AI credentials and durable budgets", () => {
  it("encrypts credentials at rest and isolates users", async () => {
    const { store, path } = setup();
    await store.ai.saveKey("alice", "test-credential-never-log");
    expect(await store.ai.getKey("alice")).toBe("test-credential-never-log");
    expect(await store.ai.getKey("bob")).toBeNull();
    const db = new DatabaseSync(path);
    const row = db.prepare("SELECT ciphertext FROM ai_credentials").get() as {
      ciphertext: string;
    };
    db.close();
    expect(row.ciphertext).not.toContain("test-credential");
    const other = createLocalStore(path);
    stores.push(other);
    expect(await other.ai.getKey("alice")).toBe("test-credential-never-log");
  });
  it("authenticates owner and encryption context", () => {
    const key = randomBytes(32),
      cipher = encryptAPIKey("test-value", key, "alice");
    expect(() => decryptAPIKey(cipher, key, "bob")).toThrow();
    expect(() => decryptAPIKey(cipher, randomBytes(32), "alice")).toThrow();
  });
  it("deleting key clears cache and connection but not usage history", async () => {
    const { store } = setup();
    await store.ai.saveKey("alice", "test-value");
    await store.ai.saveConnection("alice", {
      status: "success",
      checkedAt: new Date().toISOString(),
      error: null,
    });
    await store.ai.setCache(
      "alice",
      "cache",
      { plan: "public" },
      new Date(Date.now() + 60000).toISOString(),
    );
    await store.ai.reserveCall("alice", "models", "", 0);
    await store.ai.deleteKey("alice");
    expect(await store.ai.getKey("alice")).toBeNull();
    expect(await store.ai.getCache("alice", "cache")).toBeNull();
    expect((await store.ai.getConnection("alice")).status).toBe("unconfigured");
    expect((await store.ai.getUsage("alice")).monthCalls).toBe(1);
  });
  it("reserves a daily limit atomically across two connections", async () => {
    const { store, path } = setup();
    await store.ai.saveSettings("alice", {
      ...DEFAULT_AI_SETTINGS,
      dailyLimit: 1,
      perMinuteLimit: 60,
    });
    const second = createLocalStore(path);
    stores.push(second);
    const result = await Promise.all([
      store.ai.reserveCall("alice", "form", "model", 10),
      second.ai.reserveCall("alice", "form", "model", 10),
    ]);
    expect(result.filter(Boolean)).toHaveLength(1);
    expect((await store.ai.getUsage("alice")).todayCalls).toBe(1);
    expect((await store.ai.getUsage("bob")).todayCalls).toBe(0);
  });
  it("reserves pending tokens and never releases uncertain requests for free", async () => {
    const { store } = setup();
    await store.ai.saveSettings("alice", {
      ...DEFAULT_AI_SETTINGS,
      monthlyTokenLimit: 20,
    });
    const call = await store.ai.reserveCall("alice", "form", "model", 20);
    expect(call).not.toBeNull();
    expect(await store.ai.reserveCall("alice", "form", "model", 1)).toBeNull();
    await store.ai.finishCall("alice", call!.id, {
      success: false,
      inputTokens: 0,
      outputTokens: 0,
      error: "TIMEOUT",
      estimated: true,
    });
    expect((await store.ai.getUsage("alice")).inputTokens).toBe(20);
    expect(await store.ai.reserveCall("alice", "form", "model", 1)).toBeNull();
  });
  it("finishes once, counts actual tokens and sanitizes errors", async () => {
    const { store } = setup();
    const call = await store.ai.reserveCall("alice", "campaign", "model", 100);
    await store.ai.finishCall("alice", call!.id, {
      success: false,
      inputTokens: 12,
      outputTokens: 3,
      error: "key=SECRET email=private@example.com",
      estimated: false,
    });
    await store.ai.finishCall("alice", call!.id, {
      success: true,
      inputTokens: 99,
      outputTokens: 99,
      error: null,
      estimated: false,
    });
    expect(await store.ai.getUsage("alice")).toMatchObject({
      failures: 1,
      successes: 0,
      inputTokens: 12,
      outputTokens: 3,
      lastError: "AI_REQUEST_FAILED",
    });
  });
  it("cannot finish another owner reservation", async () => {
    const { store } = setup();
    const call = await store.ai.reserveCall("alice", "form", "model", 10);
    await store.ai.finishCall("bob", call!.id, {
      success: true,
      inputTokens: 1,
      outputTokens: 1,
      error: null,
      estimated: false,
    });
    expect((await store.ai.getUsage("alice")).successes).toBe(0);
  });
  it("enforces persistent 429 cooldown", async () => {
    const { store } = setup();
    const call = await store.ai.reserveCall("alice", "models", "", 0);
    const cooldown = new Date(Date.now() + 60000).toISOString();
    await store.ai.finishCall("alice", call!.id, {
      success: false,
      inputTokens: 0,
      outputTokens: 0,
      error: "RATE_LIMIT",
      estimated: false,
      cooldownUntil: cooldown,
    });
    expect(await store.ai.reserveCall("alice", "models", "", 0)).toBeNull();
    expect((await store.ai.getUsage("alice")).cooldownUntil).toBe(cooldown);
  });
  it("counts calls by Japanese day and month", async () => {
    const { store } = setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T14:59:00Z"));
    await store.ai.reserveCall("alice", "form", "model", 10);
    expect((await store.ai.getUsage("alice")).todayCalls).toBe(1);
    vi.setSystemTime(new Date("2026-10-31T15:01:00Z"));
    expect(await store.ai.getUsage("alice")).toMatchObject({
      todayCalls: 0,
      monthCalls: 0,
    });
  });
  it("caps rolling minute separately from month and day", async () => {
    const { store } = setup();
    await store.ai.saveSettings("alice", {
      ...DEFAULT_AI_SETTINGS,
      perMinuteLimit: 1,
    });
    await store.ai.reserveCall("alice", "models", "", 0);
    expect(await store.ai.reserveCall("alice", "models", "", 0)).toBeNull();
  });
  it("cache respects owner, expiry and counters", async () => {
    const { store } = setup();
    await store.ai.setCache(
      "alice",
      "cache",
      { plan: "public" },
      new Date(Date.now() + 60000).toISOString(),
    );
    expect(await store.ai.getCache("bob", "cache")).toBeNull();
    expect(await store.ai.getCache("alice", "cache")).toEqual({
      plan: "public",
    });
    await store.ai.hitCache("alice");
    expect((await store.ai.getUsage("alice")).cachedHits).toBe(1);
    await store.ai.setCache(
      "alice",
      "expired",
      {},
      new Date(Date.now() - 1000).toISOString(),
    );
    expect(await store.ai.getCache("alice", "expired")).toBeNull();
  });
  it("deletes credentials/settings/usage/cache with account deletion", async () => {
    const { store } = setup();
    await store.ai.saveKey("alice", "test-value");
    await store.ai.reserveCall("alice", "models", "", 0);
    await store.ai.setCache(
      "alice",
      "cache",
      {},
      new Date(Date.now() + 60000).toISOString(),
    );
    await store.deleteUser("alice");
    expect(await store.ai.getKey("alice")).toBeNull();
    expect((await store.ai.getUsage("alice")).monthCalls).toBe(0);
    expect(await store.ai.getSettings("alice")).toEqual(DEFAULT_AI_SETTINGS);
  });
  it("validates limits rather than accepting a bypass", async () => {
    const { store } = setup();
    await expect(
      store.ai.saveSettings("alice", {
        ...DEFAULT_AI_SETTINGS,
        dailyLimit: -1,
      }),
    ).rejects.toThrow();
    await expect(
      store.ai.reserveCall("alice", "form", "model", NaN),
    ).rejects.toThrow();
  });
  it("separates model/connection checks from actual analysis totals", async () => {
    const { store } = setup();
    await store.ai.saveSettings("alice", {
      ...DEFAULT_AI_SETTINGS,
      perMinuteLimit: 60,
    });
    for (const purpose of ["models", "connection", "form"] as const) {
      const call = await store.ai.reserveCall("alice", purpose, "test", 0);
      await store.ai.finishCall("alice", call!.id, {
        success: true,
        inputTokens: 0,
        outputTokens: 0,
        error: null,
        estimated: false,
      });
    }
    expect(await store.ai.getUsage("alice")).toMatchObject({
      monthCalls: 3,
      successes: 3,
      analysisSuccesses: 1,
      analysisFailures: 0,
    });
  });
});
