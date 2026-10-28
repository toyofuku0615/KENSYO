import { describe, it, expect } from "vitest";
import {
  profileSchema,
  preferencesSchema,
  sourceSchema,
} from "../src/lib/validation";
import { DEFAULT_PREFERENCES } from "../src/core/types";
describe("API boundary validation", () => {
  const profile = {
    name: "検証 太郎",
    kana: "ケンショウ タロウ",
    postalCode: "100-0001",
    prefecture: "東京都",
    address: "検証用住所",
    phone: "09000000000",
    email: "test@example.com",
    birthDate: "1990-01-01",
  };
  it("validates owner profile without accepting impossible dates", () => {
    expect(profileSchema.safeParse(profile).success).toBe(true);
    expect(
      profileSchema.safeParse({ ...profile, birthDate: "2000-02-30" }).success,
    ).toBe(false);
    expect(profileSchema.safeParse({ ...profile, email: "bad" }).success).toBe(
      false,
    );
  });
  it("requires deliberate auto-send consent and bounds daily limits", () => {
    expect(
      preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, autoApply: true })
        .success,
    ).toBe(false);
    expect(
      preferencesSchema.safeParse({
        ...DEFAULT_PREFERENCES,
        maxApplications: 1000,
      }).success,
    ).toBe(false);
    expect(
      preferencesSchema.safeParse({
        ...DEFAULT_PREFERENCES,
        autoApply: true,
        consentAt: new Date().toISOString(),
      }).success,
    ).toBe(true);
  });
  it("rejects arbitrary host patterns for collection", () => {
    expect(
      sourceSchema.safeParse({
        id: "test",
        name: "test",
        url: "https://example.com",
        kind: "html",
        enabled: true,
        termsAccepted: true,
        allowedHosts: ["*"],
      }).success,
    ).toBe(false);
  });
});
