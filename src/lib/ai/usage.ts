import { z } from "zod";
import type { AIUsage } from "../../core/ai-types";
export const aiSettingsSchema = z
  .object({
    enabled: z.boolean(),
    model: z
      .string()
      .max(120)
      .regex(/^(?:models\/)?[a-zA-Z0-9_.-]*$/),
    freeTierAcknowledged: z.boolean(),
    dailyLimit: z.number().int().min(1).max(10000),
    monthlyLimit: z.number().int().min(1).max(100000),
    perMinuteLimit: z.number().int().min(1).max(60),
    monthlyTokenLimit: z.number().int().min(1).max(100000000),
    maxInputChars: z.number().int().min(100).max(100000),
    maxOutputTokens: z.number().int().min(16).max(8192),
  })
  .strict();
export function periodStarts(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 3600000);
  const day = `${jst.toISOString().slice(0, 10)}T00:00:00+09:00`;
  const month = `${jst.toISOString().slice(0, 7)}-01T00:00:00+09:00`;
  return {
    day: new Date(day).toISOString(),
    month: new Date(month).toISOString(),
    minute: new Date(now.getTime() - 60000).toISOString(),
  };
}
export const emptyAIUsage = (): AIUsage => ({
  todayCalls: 0,
  monthCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  successes: 0,
  failures: 0,
  analysisSuccesses: 0,
  analysisFailures: 0,
  cachedHits: 0,
  lastError: null,
  estimatedTokens: false,
  cooldownUntil: null,
});
