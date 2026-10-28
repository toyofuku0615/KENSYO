import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** A distinct authenticated context prevents swapping profile/API ciphertexts. */
export function encryptAPIKey(
  value: string,
  key: Buffer,
  userId: string,
): string {
  if (key.length !== 32 || !value.trim() || value.length > 512)
    throw new Error("Invalid AI credential configuration");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`kensho-ai-key:v1:${userId}`));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    body.toString("base64"),
  ].join(".");
}
export function decryptAPIKey(
  value: string,
  key: Buffer,
  userId: string,
): string {
  const [version, iv, tag, body] = value.split(".");
  if (version !== "v1" || !iv || !tag || !body || key.length !== 32)
    throw new Error("Invalid AI credential configuration");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64"),
  );
  decipher.setAAD(Buffer.from(`kensho-ai-key:v1:${userId}`));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(body, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
export function safeAIError(value: string | null | undefined): string | null {
  return !value
    ? null
    : /^[A-Z0-9_]{1,64}$/.test(value)
      ? value
      : "AI_REQUEST_FAILED";
}
