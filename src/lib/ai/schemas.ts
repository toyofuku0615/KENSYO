import { z } from "zod";

// One schema is used by persistence, APIs, and the provider.
export { aiSettingsSchema } from "./usage";
export const connectionResponseSchema = z
  .object({ connected: z.literal(true) })
  .strict();
export const apiKeySchema = z
  .string()
  .trim()
  .min(20)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

export interface AIModel {
  id: string;
  displayName: string;
}
