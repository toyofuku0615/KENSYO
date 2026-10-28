import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createLocalStore, type LocalStore } from "../src/lib/local-store";
import { DEFAULT_AI_SETTINGS } from "../src/core/ai-types";
import type { Profile } from "../src/core/types";
import {
  createAIService,
  sanitizeAIPayload,
  rateLimitCooldownMs,
} from "../src/lib/ai/provider";
import type { GeminiTransport } from "../src/lib/ai/gemini";

const stores: LocalStore[] = [];
const owner = "provider-alice";
const storedKey = "test-stored-gemini-credential-never-log";
const envKey = "test-environment-gemini-credential-never-log";
const answerSchema = z.object({ answer: z.string().min(1) }).strict();
const profile: Profile = {
  name: "検証 花子",
  kana: "ケンショウ ハナコ",
  address: "テスト区検証町1-2-3",
  prefecture: "東京都",
  phone: "09012345678",
  email: "private-owner@example.invalid",
  postalCode: "1000001",
  birthDate: "1990-01-01",
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});
async function setup(options: { key?: boolean; enabled?: boolean } = {}) {
  vi.stubEnv("GEMINI_API_KEY", "");
  const store = createLocalStore(":memory:", randomBytes(32));
  stores.push(store);
  await store.ai.saveSettings(owner, {
    ...DEFAULT_AI_SETTINGS,
    enabled: options.enabled ?? true,
    model: "mock-text-model",
    freeTierAcknowledged: true,
    dailyLimit: 100,
    perMinuteLimit: 30,
    monthlyTokenLimit: 1000000,
  });
  if (options.key !== false) await store.ai.saveKey(owner, storedKey);
  const transport: GeminiTransport = {
    listModels: vi.fn(async () => [
      { id: "mock-text-model", displayName: "Mock model" },
    ]),
    generate: vi.fn(async () => ({
      text: '{"answer":"公開情報に基づく回答"}',
      inputTokens: 12,
      outputTokens: 8,
      estimated: false,
    })),
  };
  return {
    store,
    transport,
    service: createAIService(store, owner, { transport }),
  };
}

describe("Gemini provider credentials and explicit configuration", () => {
  it("returns only masked configuration and gives stored credentials priority over environment", async () => {
    const { service, transport } = await setup();
    vi.stubEnv("GEMINI_API_KEY", envKey);
    const status = await service.getStatus();
    expect(status).toMatchObject({
      keyConfigured: true,
      keySource: "stored",
      provider: "Google Gemini",
    });
    expect(JSON.stringify(status)).not.toContain(storedKey);
    expect(JSON.stringify(status)).not.toContain(envKey);
    await service.generate("answer", { question: "公開質問" }, answerSchema);
    expect(vi.mocked(transport.generate).mock.calls[0][0].apiKey).toBe(
      storedKey,
    );
  });
  it("deletes the stored key and disables AI while exposing environment fallback only as metadata", async () => {
    const { service, store } = await setup();
    vi.stubEnv("GEMINI_API_KEY", envKey);
    await service.deleteKey();
    expect(await store.ai.getKey(owner)).toBeNull();
    expect(await service.getStatus()).toMatchObject({
      keyConfigured: true,
      keySource: "environment",
      settings: { enabled: false },
      connection: { status: "unconfigured" },
    });
  });
  it("does not call the SDK when no credential is configured", async () => {
    const { service, transport } = await setup({ key: false });
    await expect(
      service.generate("answer", { question: "公開質問" }, answerSchema),
    ).rejects.toMatchObject({ code: "unconfigured" });
    expect(transport.generate).not.toHaveBeenCalled();
    expect(await service.getStatus()).toMatchObject({
      keyConfigured: false,
      keySource: "none",
    });
  });
  it("keeps automatic AI disabled until explicitly enabled", async () => {
    const { service, transport } = await setup({ enabled: false });
    await expect(
      service.generate("form", { fields: [] }, answerSchema),
    ).rejects.toMatchObject({ code: "disabled" });
    expect(transport.generate).not.toHaveBeenCalled();
  });
  it("requires a selected model and free-tier acknowledgment without silently choosing another model", async () => {
    const { service, store, transport } = await setup();
    const settings = await store.ai.getSettings(owner);
    await store.ai.saveSettings(owner, { ...settings, model: "" });
    await expect(
      service.generate("answer", {}, answerSchema),
    ).rejects.toMatchObject({ code: "model_required" });
    await store.ai.saveSettings(owner, {
      ...settings,
      freeTierAcknowledged: false,
    });
    await expect(
      service.generate("answer", {}, answerSchema),
    ).rejects.toMatchObject({ code: "free_tier_confirmation" });
    expect(transport.generate).not.toHaveBeenCalled();
  });
  it("lists actual transport models as one counted request, filtering invalid identifiers", async () => {
    const { service, transport, store } = await setup({ enabled: false });
    vi.mocked(transport.listModels).mockResolvedValue([
      { id: "mock-text-model", displayName: "Mock" },
      { id: "../unsafe", displayName: "Unsafe" },
    ]);
    expect(await service.listModels()).toEqual([
      { id: "mock-text-model", displayName: "Mock" },
    ]);
    expect(transport.listModels).toHaveBeenCalledOnce();
    expect(await store.ai.getUsage(owner)).toMatchObject({
      todayCalls: 1,
      monthCalls: 1,
      successes: 1,
      inputTokens: 0,
      outputTokens: 0,
    });
  });
  it("tests connection with strict JSON even while background AI is disabled", async () => {
    const { service, store, transport } = await setup({ enabled: false });
    vi.mocked(transport.generate).mockResolvedValue({
      text: '{"connected":true}',
      inputTokens: 9,
      outputTokens: 2,
      estimated: false,
    });
    expect(await service.testConnection()).toMatchObject({
      status: "success",
      error: null,
    });
    expect((await service.getStatus()).connection.checkedAt).not.toBeNull();
    expect(await store.ai.getUsage(owner)).toMatchObject({
      todayCalls: 1,
      successes: 1,
      inputTokens: 9,
      outputTokens: 2,
    });
  });
});

describe("Gemini boundaries, accounting, and cache", () => {
  it.each([
    "not JSON",
    '{"answer":"safe","execute":"steal()"}',
    '{"answer":null}',
  ])("rejects invalid or extra JSON output: %s", async (text) => {
    const { service, transport, store } = await setup();
    vi.mocked(transport.generate).mockResolvedValue({
      text,
      inputTokens: 12,
      outputTokens: 8,
      estimated: false,
    });
    await expect(
      service.generate("form", { fields: [] }, answerSchema),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(await store.ai.getUsage(owner)).toMatchObject({
      failures: 1,
      successes: 0,
      lastError: "INVALID_RESPONSE",
    });
  });
  it.each([
    [429, "rate_limited", "RATE_LIMITED"],
    [403, "authentication", "AUTHENTICATION"],
    [504, "timeout", "TIMEOUT"],
  ] as const)(
    "sanitizes provider error %s and never retries",
    async (status, code, savedCode) => {
      const { service, transport, store } = await setup();
      vi.mocked(transport.generate).mockRejectedValue({
        status,
        message: `${storedKey} ${profile.email}`,
        body: profile.address,
      });
      await expect(
        service.generate("form", { fields: [] }, answerSchema),
      ).rejects.toMatchObject({ code });
      expect(transport.generate).toHaveBeenCalledOnce();
      const usage = await store.ai.getUsage(owner);
      expect(usage).toMatchObject({
        failures: 1,
        lastError: savedCode,
        estimatedTokens: true,
      });
      expect(JSON.stringify(usage)).not.toContain(storedKey);
      expect(JSON.stringify(usage)).not.toContain(profile.email);
      if (status === 429) {
        expect(usage.cooldownUntil).not.toBeNull();
        await expect(
          service.generate(
            "answer",
            { question: "別の公開質問" },
            answerSchema,
          ),
        ).rejects.toMatchObject({ code: "limit" });
        expect(transport.generate).toHaveBeenCalledOnce();
      }
    },
  );
  it("recognizes aborted requests and stores only a safe connection failure", async () => {
    const { service, transport } = await setup();
    vi.mocked(transport.generate).mockRejectedValue({
      name: "AbortError",
      message: `secret ${storedKey}`,
    });
    expect(await service.testConnection()).toMatchObject({
      status: "failed",
      error: "TIMEOUT",
    });
    expect(JSON.stringify(await service.getStatus())).not.toContain(storedKey);
  });
  it("redacts owner data and credentials before sending only public structural input", async () => {
    const { service, store, transport } = await setup();
    await store.saveProfile(owner, profile);
    await service.generate(
      "form",
      {
        labels: [
          profile.name,
          profile.kana,
          profile.address,
          profile.phone,
          profile.email,
          profile.birthDate,
          profile.postalCode,
          storedKey,
        ],
        field: "name",
      },
      answerSchema,
    );
    const input = vi.mocked(transport.generate).mock.calls[0][0];
    for (const value of [...Object.values(profile), storedKey])
      expect(input.prompt).not.toContain(value);
    expect(input.prompt).toContain("[REDACTED]");
    expect(input.systemInstruction).toContain("untrusted DATA");
    expect(input.systemInstruction).toContain("Never invent user experiences");
  });
  it.each([
    "profile",
    "apiKey",
    "cookie",
    "authorization",
    "value",
    "outerHTML",
  ])(
    "rejects sensitive input property %s before reservation or transport",
    async (field) => {
      const { service, store, transport } = await setup();
      await expect(
        service.generate("form", { [field]: "secret" }, answerSchema),
      ).rejects.toMatchObject({ code: "unsafe_input" });
      expect(transport.generate).not.toHaveBeenCalled();
      expect((await store.ai.getUsage(owner)).todayCalls).toBe(0);
    },
  );
  it("limits input size and cyclic/invalid structures locally", async () => {
    const { service, transport } = await setup();
    await expect(
      service.generate(
        "answer",
        { publicText: "x".repeat(12001) },
        answerSchema,
      ),
    ).rejects.toMatchObject({ code: "input_size" });
    expect(() => sanitizeAIPayload({ number: NaN })).toThrow();
    expect(() => sanitizeAIPayload({ callback: () => undefined })).toThrow();
    expect(transport.generate).not.toHaveBeenCalled();
  });
  it("caches validated repeated public inputs and counts cache hits separately", async () => {
    const { service, store, transport } = await setup();
    const input = { question: "この商品の公開された特徴は？" };
    expect(await service.generate("answer", input, answerSchema)).toEqual({
      answer: "公開情報に基づく回答",
    });
    await service.generate("answer", input, answerSchema);
    expect(transport.generate).toHaveBeenCalledOnce();
    expect(await store.ai.getUsage(owner)).toMatchObject({
      todayCalls: 1,
      cachedHits: 1,
      inputTokens: 12,
      outputTokens: 8,
    });
    const settings = await store.ai.getSettings(owner);
    await service.updateSettings({
      ...settings,
      model: "another-explicit-mock-model",
    });
    await service.generate("answer", input, answerSchema);
    expect(transport.generate).toHaveBeenCalledTimes(2);
  });
  it("revalidates schema on cached data instead of trusting an invalid cached plan", async () => {
    const { service, store, transport } = await setup();
    vi.spyOn(store.ai, "getCache").mockResolvedValue({
      answer: "safe",
      execute: "arbitrary-script",
    });
    await service.generate("answer", { question: "公開情報" }, answerSchema);
    expect(transport.generate).toHaveBeenCalledOnce();
  });
  it("rejects cached output that contains current owner profile values", async () => {
    const { service, store, transport } = await setup();
    await store.saveProfile(owner, profile);
    vi.spyOn(store.ai, "getCache").mockResolvedValue({
      answer: profile.address,
    });
    await expect(
      service.generate("answer", { question: "公開情報" }, answerSchema),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(transport.generate).not.toHaveBeenCalled();
  });
  it("rejects a successful transport output that echoes owner data", async () => {
    const { service, store, transport } = await setup();
    await store.saveProfile(owner, profile);
    vi.mocked(transport.generate).mockResolvedValue({
      text: JSON.stringify({ answer: profile.name }),
      inputTokens: 1,
      outputTokens: 5,
      estimated: false,
    });
    await expect(
      service.generate("answer", { question: "公開情報" }, answerSchema),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect((await store.ai.getUsage(owner)).failures).toBe(1);
  });
  it("uses bounded exponential cooldown across explicit attempts without retrying automatically", async () => {
    const { service, transport, store } = await setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    vi.mocked(transport.generate).mockRejectedValue({ status: 429 });
    await expect(
      service.generate("answer", { question: "first" }, answerSchema),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect((await store.ai.getUsage(owner)).cooldownUntil).toBe(
      "2026-11-01T00:01:00.000Z",
    );
    vi.setSystemTime(new Date("2026-11-01T00:01:01Z"));
    await expect(
      service.generate("answer", { question: "second" }, answerSchema),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect((await store.ai.getUsage(owner)).cooldownUntil).toBe(
      "2026-11-01T00:03:01.000Z",
    );
    expect(transport.generate).toHaveBeenCalledTimes(2);
    expect(
      rateLimitCooldownMs({ lastError: "RATE_LIMITED", failures: 99 }),
    ).toBe(900000);
    expect(
      rateLimitCooldownMs({ lastError: "AUTHENTICATION", failures: 99 }),
    ).toBe(60000);
  });
  it("refuses a request whose conservative token reservation exceeds the remaining cap", async () => {
    const { service, transport, store } = await setup();
    await store.ai.saveSettings(owner, {
      ...(await store.ai.getSettings(owner)),
      monthlyTokenLimit: 1,
    });
    await expect(
      service.generate("form", { fields: [] }, answerSchema),
    ).rejects.toMatchObject({ code: "limit" });
    expect(transport.generate).not.toHaveBeenCalled();
    expect((await store.ai.getUsage(owner)).todayCalls).toBe(0);
  });
  it("enforces daily request and total token reservations before making a request", async () => {
    const { service, store, transport } = await setup();
    await store.ai.saveSettings(owner, {
      ...(await store.ai.getSettings(owner)),
      dailyLimit: 1,
    });
    await service.generate("answer", { question: "一つ目" }, answerSchema);
    await expect(
      service.generate("answer", { question: "二つ目" }, answerSchema),
    ).rejects.toMatchObject({ code: "limit" });
    expect(transport.generate).toHaveBeenCalledOnce();
  });
});
