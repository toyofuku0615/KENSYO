import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("undici", () => ({
  fetch: mocks.request,
  Agent: class {
    async close() {}
  },
  ProxyAgent: class {
    async close() {}
  },
}));
import { safeFetchText } from "../src/core/url-safety";
const response = (
  text: string,
  status = 200,
  headers: Record<string, string> = {},
) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers({ "content-type": "text/plain", ...headers }),
  body: new Blob([text]).stream(),
});
beforeEach(() => {
  mocks.request.mockReset();
  mocks.lookup.mockReset();
  mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  vi.stubEnv("HTTPS_PROXY", "");
  vi.stubEnv("https_proxy", "");
  vi.stubEnv("KENSHO_PROXY_PUBLIC_DESTINATIONS_ONLY", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
describe("remote collector transport boundaries", () => {
  it("fails closed when a configured proxy cannot guarantee public-only destination DNS", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.invalid:8080");
    await expect(
      safeFetchText("https://proxy-case.example/campaign", [
        "proxy-case.example",
      ]),
    ).rejects.toThrow("プロキシ側");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("rejects mixed public/private DNS answers before issuing any request", async () => {
    mocks.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    await expect(
      safeFetchText("https://mixed-dns.example/campaign", [
        "mixed-dns.example",
      ]),
    ).rejects.toThrow("非公開");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("never follows a campaign redirect to a private DNS destination", async () => {
    mocks.lookup.mockImplementation(async (host: string) => [
      {
        address: host === "private.example" ? "127.0.0.1" : "8.8.8.8",
        family: 4,
      },
    ]);
    mocks.request
      .mockResolvedValueOnce(response("User-agent: *\nAllow: /"))
      .mockResolvedValueOnce(
        response("", 302, { location: "https://private.example/internal" }),
      );
    await expect(
      safeFetchText("https://redirect-case.example/campaign", [
        "redirect-case.example",
        "private.example",
      ]),
    ).rejects.toThrow("非公開");
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });
  it("honors robots prohibition before fetching the campaign", async () => {
    mocks.request.mockResolvedValueOnce(
      response("User-agent: KenshoHunter\nDisallow: /campaign"),
    );
    await expect(
      safeFetchText("https://robots-case.example/campaign", [
        "robots-case.example",
      ]),
    ).rejects.toThrow("robots.txt");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("fails closed when robots cannot be fetched", async () => {
    mocks.request.mockResolvedValueOnce(response("missing", 404));
    await expect(
      safeFetchText("https://no-robots.example/campaign", [
        "no-robots.example",
      ]),
    ).rejects.toThrow("HTTP 404");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("cancels responses whose declared size exceeds the bound", async () => {
    mocks.request.mockResolvedValueOnce(
      response("x", 200, { "content-length": "1000001" }),
    );
    await expect(
      safeFetchText("https://oversize-case.example/campaign", [
        "oversize-case.example",
      ]),
    ).rejects.toThrow("取得サイズ");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
});
