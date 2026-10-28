import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  ApiError,
  checkOrigin,
  mode,
  readJson,
  requireUser,
  apiError,
} from "../src/lib/auth";
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
afterEach(() => vi.unstubAllEnvs());
const request = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/profile", {
    method: "PUT",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
describe("bounded private API requests", () => {
  it("parses a small JSON request", async () =>
    expect(await readJson(request('{"ok":true}'))).toEqual({ ok: true }));
  it("rejects oversized declared length before reading", async () => {
    await expect(
      readJson(request("{}", { "content-length": "20000" })),
    ).rejects.toMatchObject({ status: 413 });
  });
  it("rejects oversized streamed bodies even with absent/forged content length", async () => {
    await expect(
      readJson(
        request('"' + "x".repeat(17_000) + '"', { "content-length": "1" }),
      ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      readJson(request('"' + "x".repeat(17_000) + '"')),
    ).rejects.toMatchObject({ status: 413 });
  });
  it("requires JSON and hides invalid sensitive input", async () => {
    await expect(
      readJson(request("private address", { "content-type": "text/plain" })),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      readJson(request('{"secret":"private-address"')),
    ).rejects.toMatchObject({ message: "JSON データを確認してください。" });
  });
  it("enforces exact origin and rejects cross-site writes", () => {
    vi.stubEnv("KENSHO_MODE", "supabase");
    vi.stubEnv("APP_ORIGIN", "https://kensho.example.com");
    expect(() =>
      checkOrigin(
        new NextRequest("https://kensho.example.com/api/profile", {
          headers: { origin: "https://evil.example" },
        }),
      ),
    ).toThrow(ApiError);
    expect(() =>
      checkOrigin(
        new NextRequest("https://kensho.example.com/api/profile", {
          headers: {
            origin: "https://kensho.example.com",
            "sec-fetch-site": "cross-site",
          },
        }),
      ),
    ).toThrow(ApiError);
    expect(() =>
      checkOrigin(
        new NextRequest("https://kensho.example.com/api/profile", {
          headers: { origin: "https://kensho.example.com" },
        }),
      ),
    ).not.toThrow();
  });
  it("never exposes raw SQL/credentials/profile details on unknown errors", async () => {
    const response = apiError(
      new Error("postgres password secret; address private"),
    );
    expect(await response.text()).not.toMatch(
      /postgres|password|secret|address private/,
    );
  });
  it("demo auth is limited to loopback hosts", async () => {
    vi.stubEnv("KENSHO_MODE", "demo");
    await expect(
      requireUser(new NextRequest("https://public.example/api/dashboard")),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      requireUser(
        new NextRequest("http://127.0.0.1:3000/api/dashboard", {
          headers: { host: "127.0.0.1:3000" },
        }),
      ),
    ).resolves.toBe("local-demo-user");
  });
  it("accepts the raw loopback Host origin when Next normalizes its URL", () => {
    vi.stubEnv("KENSHO_MODE", "demo");
    vi.stubEnv("APP_ORIGIN", "");
    const req = new NextRequest("http://localhost:3000/api/profile", {
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
    });
    expect(req.nextUrl.hostname).toBe("localhost");
    expect(() => checkOrigin(req)).not.toThrow();
  });
  it("rejects attacker Host even when Next URL has normalized to localhost", async () => {
    vi.stubEnv("KENSHO_MODE", "demo");
    vi.stubEnv("APP_ORIGIN", "");
    const req = new NextRequest("http://localhost:3000/api/profile", {
      headers: {
        host: "evil.example",
        origin: "http://evil.example",
        "x-forwarded-host": "localhost:3000",
      },
    });
    expect(() => checkOrigin(req)).toThrow(ApiError);
    await expect(requireUser(req)).rejects.toMatchObject({ status: 403 });
  });
  it("rejects an absent raw Host in demo instead of trusting a normalized URL", async () => {
    vi.stubEnv("KENSHO_MODE", "demo");
    await expect(
      requireUser(new NextRequest("http://localhost:3000/api/dashboard")),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("pins production origin and ignores spoofed forwarding headers", () => {
    vi.stubEnv("KENSHO_MODE", "supabase");
    vi.stubEnv("APP_ORIGIN", "");
    expect(() =>
      checkOrigin(
        new NextRequest("https://localhost/api/profile", {
          headers: {
            host: "evil.example",
            origin: "https://evil.example",
            "x-forwarded-host": "evil.example",
            "x-forwarded-proto": "https",
          },
        }),
      ),
    ).toThrow("APP_ORIGIN");
    vi.stubEnv("APP_ORIGIN", "https://kensho.example.com");
    expect(() =>
      checkOrigin(
        new NextRequest("https://localhost/api/profile", {
          headers: {
            host: "evil.example",
            origin: "https://evil.example",
            "x-forwarded-host": "evil.example",
          },
        }),
      ),
    ).toThrow(ApiError);
  });
  it("production does not silently fall back to demo auth", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("KENSHO_MODE", "");
    expect(mode()).toBe("supabase");
  });
});
