import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createLocalStore, type LocalStore } from "../src/lib/local-store";
import { ApiError } from "../src/lib/auth";
import { GET, POST, DELETE } from "../src/app/api/settings/ai/route";

const mocks = vi.hoisted(() => ({ getStore: vi.fn(), requireUser: vi.fn() }));
vi.mock("../src/lib/store", () => ({ getStore: mocks.getStore }));
vi.mock("../src/lib/auth", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/auth")>("../src/lib/auth");
  return { ...actual, requireUser: mocks.requireUser };
});
let store: LocalStore;
const fakeKey = "TEST_ONLY_NOT_A_REAL_GEMINI_KEY_0123456789";
function request(
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
  url = "http://127.0.0.1:3000/api/settings/ai",
) {
  return new NextRequest(url, {
    method,
    headers: {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "content-type": "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeEach(() => {
  vi.stubEnv("KENSHO_MODE", "demo");
  vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3000");
  vi.stubEnv("GEMINI_API_KEY", "");
  store = createLocalStore(":memory:");
  mocks.getStore.mockReturnValue(store);
  mocks.requireUser.mockResolvedValue("alice");
});
afterEach(() => {
  store.close();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
describe("AI credential API authorization and secure transport", () => {
  it("stores only for authenticated owner and never returns plaintext or ciphertext", async () => {
    expect((await POST(request("POST", { apiKey: fakeKey }))).status).toBe(200);
    const owner = await GET(request("GET"));
    const text = await owner.text();
    expect(text).not.toContain(fakeKey);
    expect(text).not.toContain("ciphertext");
    expect(JSON.parse(text).keyConfigured).toBe(true);
    expect(owner.headers.get("cache-control")).toContain("no-store");
    mocks.requireUser.mockResolvedValue("bob");
    expect((await (await GET(request("GET"))).json()).keyConfigured).toBe(
      false,
    );
    await DELETE(request("DELETE"));
    expect(await store.ai.getKey("alice")).toBe(fakeKey);
  });
  it("requires a session before returning even masked settings", async () => {
    mocks.requireUser.mockRejectedValue(
      new ApiError("ログインしてください。", 401),
    );
    const response = await GET(request("GET"));
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(fakeKey);
  });
  it("rejects cross-origin key registration before persistence", async () => {
    const response = await POST(
      request(
        "POST",
        { apiKey: fakeKey },
        { origin: "https://attacker.example" },
      ),
    );
    expect(response.status).toBe(403);
    expect(await store.ai.getKey("alice")).toBeNull();
  });
  it("requires HTTPS for Supabase writes even with a matching configured Origin", async () => {
    vi.stubEnv("KENSHO_MODE", "supabase");
    vi.stubEnv("APP_ORIGIN", "https://app.example.com");
    const response = await POST(
      request(
        "POST",
        { apiKey: fakeKey },
        {
          host: "app.example.com",
          origin: "https://app.example.com",
          "x-forwarded-proto": "http",
        },
        "http://app.example.com/api/settings/ai",
      ),
    );
    expect(response.status).toBe(403);
    expect(await store.ai.getKey("alice")).toBeNull();
  });
  it("permits HTTPS Supabase registration after verified owner authentication", async () => {
    vi.stubEnv("KENSHO_MODE", "supabase");
    vi.stubEnv("APP_ORIGIN", "https://app.example.com");
    const response = await POST(
      request(
        "POST",
        { apiKey: fakeKey },
        {
          host: "app.example.com",
          origin: "https://app.example.com",
          "x-forwarded-proto": "https",
        },
        "https://app.example.com/api/settings/ai",
      ),
    );
    expect(response.status).toBe(200);
    expect(await store.ai.getKey("alice")).toBe(fakeKey);
  });
  it("rejects oversized key payload without reflecting the submitted value", async () => {
    const response = await POST(
      request("POST", { apiKey: fakeKey.repeat(1000) }),
    );
    expect(response.status).toBe(413);
    expect(await response.text()).not.toContain(fakeKey);
  });
});
