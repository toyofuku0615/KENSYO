import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Profile } from "../core/types";

export function encryptionKey(value?: string | Buffer): Buffer {
  const key = Buffer.isBuffer(value)
    ? value
    : value
      ? Buffer.from(value, "base64")
      : randomBytes(32);
  if (key.length !== 32)
    throw new Error(
      "PROFILE_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  return key;
}
export function persistentKey(file: string): Buffer {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, randomBytes(32).toString("base64"), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  chmodSync(file, 0o600);
  return encryptionKey(readFileSync(file, "utf8").trim());
}
export function encryptProfile(
  profile: Profile,
  key: Buffer,
  userId: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(userId));
  const body = Buffer.concat([
    cipher.update(JSON.stringify(profile), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    body.toString("base64"),
  ].join(".");
}
export function decryptProfile(
  value: string,
  key: Buffer,
  userId: string,
): Profile {
  const [version, iv, tag, body] = value.split(".");
  if (version !== "v1" || !iv || !tag || !body)
    throw new Error("Invalid encrypted profile");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64"),
  );
  cipher.setAAD(Buffer.from(userId));
  cipher.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      cipher.update(Buffer.from(body, "base64")),
      cipher.final(),
    ]).toString("utf8"),
  ) as Profile;
}
