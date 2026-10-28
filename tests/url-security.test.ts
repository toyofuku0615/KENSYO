import { describe, expect, it } from "vitest";
import { isPublicAddress, robotsAllows } from "../src/core/url-safety";

describe("SSRF IPv6 canonicalization", () => {
  it.each([
    "2001:db8::1",
    "2001:0db8:0000:0000:0000:0000:0000:0001",
    "2001:0000:0000:0000:0000:0000:7f00:0001",
    "2001:2::1",
    "2001:0002:0000:0000:0000:0000:0000:0001",
    "3fff::1",
    "3fff:000f:ffff:ffff:ffff:ffff:ffff:ffff",
  ])("rejects special-use address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each([
    "2606:4700:4700::1111",
    "2606:4700:4700:0000:0000:0000:0000:1111",
    "2001:4860:4860::8888",
  ])("keeps public unicast address %s usable", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("robots agent specificity", () => {
  it("does not let a shorter-agent Allow override the exact-agent Disallow", () => {
    const robots =
      "User-agent: Kensho\nAllow: /private\n\nUser-agent: KenshoHunter\nDisallow: /\n";
    expect(robotsAllows(robots, "/private/entry")).toBe(false);
  });
  it("does not let a shorter-agent Disallow override the exact-agent Allow", () => {
    const robots =
      "User-agent: Kensho\nDisallow: /private\n\nUser-agent: KenshoHunter\nAllow: /\n";
    expect(robotsAllows(robots, "/private/entry")).toBe(true);
  });
  it("merges groups with equal longest-agent matches", () => {
    const robots =
      "User-agent: KenshoHunter\nDisallow: /private\n\nUser-agent: KenshoHunter\nAllow: /private/public\n";
    expect(robotsAllows(robots, "/private/public/entry")).toBe(true);
    expect(robotsAllows(robots, "/private/entry")).toBe(false);
  });
});
