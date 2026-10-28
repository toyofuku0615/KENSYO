export interface AISettings {
  enabled: boolean;
  model: string;
  freeTierAcknowledged: boolean;
  dailyLimit: number;
  monthlyLimit: number;
  perMinuteLimit: number;
  monthlyTokenLimit: number;
  maxInputChars: number;
  maxOutputTokens: number;
}
export const DEFAULT_AI_SETTINGS: AISettings = {
  enabled: false,
  model: "",
  freeTierAcknowledged: false,
  dailyLimit: 20,
  monthlyLimit: 200,
  perMinuteLimit: 2,
  monthlyTokenLimit: 100000,
  maxInputChars: 12000,
  maxOutputTokens: 1500,
};
export type AIPurpose =
  "connection" | "models" | "campaign" | "form" | "answer";
export interface AIConnection {
  status: "unconfigured" | "success" | "failed";
  checkedAt: string | null;
  error: string | null;
}
export interface AIUsage {
  todayCalls: number;
  monthCalls: number;
  inputTokens: number;
  outputTokens: number;
  successes: number;
  failures: number;
  analysisSuccesses: number;
  analysisFailures: number;
  cachedHits: number;
  lastError: string | null;
  estimatedTokens: boolean;
  cooldownUntil: string | null;
}
export interface AIReservation {
  id: string;
}
export interface AIRepository {
  getSettings(userId: string): Promise<AISettings>;
  saveSettings(userId: string, settings: AISettings): Promise<void>;
  getKey(userId: string): Promise<string | null>;
  saveKey(userId: string, key: string): Promise<void>;
  deleteKey(userId: string): Promise<void>;
  getConnection(userId: string): Promise<AIConnection>;
  saveConnection(userId: string, connection: AIConnection): Promise<void>;
  getUsage(userId: string): Promise<AIUsage>;
  reserveCall(
    userId: string,
    purpose: AIPurpose,
    model: string,
    reservedTokens: number,
  ): Promise<AIReservation | null>;
  finishCall(
    userId: string,
    id: string,
    result: {
      success: boolean;
      inputTokens: number;
      outputTokens: number;
      error: string | null;
      estimated: boolean;
      cooldownUntil?: string | null;
    },
  ): Promise<void>;
  getCache(userId: string, key: string): Promise<unknown | null>;
  setCache(
    userId: string,
    key: string,
    value: unknown,
    expiresAt: string,
  ): Promise<void>;
  hitCache(userId: string): Promise<void>;
}
