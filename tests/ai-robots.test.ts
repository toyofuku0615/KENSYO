import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Route } from "playwright";
import { aiProfile } from "./helpers/ai-fixtures";
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
import { fulfillPublicRoute } from "../src/automation/submission-validator";
function response(
  text: string,
  status = 200,
  headers: Record<string, string> = {},
) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ "content-type": "text/plain", ...headers }),
    body: new Blob([text]).stream(),
  };
}
function routeFor(url: string, navigation = true, method = "GET") {
  const fulfill = vi.fn().mockResolvedValue(undefined),
    abort = vi.fn().mockResolvedValue(undefined);
  return {
    route: {
      request: () => ({
        url: () => url,
        method: () => method,
        postData: () => (method === "POST" ? "name=fixture" : null),
        isNavigationRequest: () => navigation,
        headers: () => ({}),
      }),
      fulfill,
      abort,
    } as unknown as Route,
    fulfill,
    abort,
  };
}
beforeEach(() => {
  mocks.request.mockReset();
  mocks.lookup.mockReset();
  mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  vi.stubEnv("HTTPS_PROXY", "");
  vi.stubEnv("https_proxy", "");
});
afterEach(() => vi.unstubAllEnvs());
describe("browser robots compliance on every document transition", () => {
  it.each([false, true])(
    "blocks initial/next document before fetching when sendingWindow=%s",
    async (sending) => {
      const host = `ai-document-${sending ? "next" : "initial"}.example`;
      vi.stubEnv("LIVE_SUBMISSION_HOSTS", host);
      mocks.request.mockResolvedValueOnce(
        response("User-agent: *\nDisallow: /form"),
      );
      const { route, fulfill } = routeFor(`https://${host}/form`);
      await expect(
        fulfillPublicRoute(
          route,
          `https://${host}`,
          sending,
          async () => true,
          aiProfile,
          sending,
        ),
      ).rejects.toThrow("robots.txt");
      expect(mocks.request).toHaveBeenCalledTimes(1);
      expect(mocks.request.mock.calls[0][0].pathname).toBe("/robots.txt");
      expect(fulfill).not.toHaveBeenCalled();
    },
  );
  it("rechecks the redirected destination before issuing its page request", async () => {
    const host = "ai-redirect-robots.example";
    vi.stubEnv("LIVE_SUBMISSION_HOSTS", host);
    mocks.request
      .mockResolvedValueOnce(
        response("User-agent: *\nAllow: /\nDisallow: /blocked"),
      )
      .mockResolvedValueOnce(response("", 302, { location: "/blocked" }));
    const initial = routeFor(`https://${host}/start`);
    await fulfillPublicRoute(
      initial.route,
      `https://${host}`,
      false,
      async () => true,
      aiProfile,
    );
    expect(initial.fulfill).toHaveBeenCalledWith(
      expect.objectContaining({ status: 302 }),
    );
    const redirect = routeFor(`https://${host}/blocked`);
    await expect(
      fulfillPublicRoute(
        redirect.route,
        `https://${host}`,
        false,
        async () => true,
        aiProfile,
      ),
    ).rejects.toThrow("robots.txt");
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(redirect.fulfill).not.toHaveBeenCalled();
  });
  it("blocks a POST target disallowed by robots even when it is an XHR submission", async () => {
    const host = "ai-post-robots.example";
    vi.stubEnv("LIVE_SUBMISSION_HOSTS", host);
    mocks.request.mockResolvedValueOnce(
      response("User-agent: *\nDisallow: /submit"),
    );
    const { route, fulfill } = routeFor(
      `https://${host}/submit`,
      false,
      "POST",
    );
    await expect(
      fulfillPublicRoute(
        route,
        `https://${host}`,
        true,
        async () => true,
        aiProfile,
        true,
      ),
    ).rejects.toThrow("robots.txt");
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(fulfill).not.toHaveBeenCalled();
  });
});
