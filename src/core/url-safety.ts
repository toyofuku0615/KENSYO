import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, ProxyAgent, fetch as request, type Dispatcher } from "undici";

const MAX_BYTES = 1_000_000;
/** Only globally routable addresses. Reject transition, mapped and special-use IPv6. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) === 6) {
    // Expand hextets before range tests so padded variants cannot bypass a textual prefix.
    if (address.includes(".") || address.includes("%")) return false;
    const halves = address.toLowerCase().split("::");
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const groups =
      halves.length === 2
        ? [
            ...left,
            ...Array(8 - left.length - right.length).fill("0"),
            ...right,
          ]
        : left;
    const [first, second] = groups.map((group) => parseInt(group, 16));
    return (
      first >= 0x2000 &&
      first <= 0x3fff &&
      first !== 0x2002 &&
      first !== 0x3fff &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
    );
  }
  return false;
}

export async function validatePublicUrl(
  raw: string,
  allowedHosts: string[],
): Promise<URL> {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    raw.length > 2048
  ) {
    throw new Error("安全な HTTPS URL のみ取得できます");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    isIP(hostname.replace(/^\[|\]$/g, "")) ||
    !hostname.includes(".") ||
    hostname.endsWith(".") ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|onion)$/.test(hostname) ||
    hostname.split(".").some((label) => label.startsWith("xn--")) ||
    !allowedHosts.some((host) => host.toLowerCase() === hostname)
  )
    throw new Error("未承認または不審なホストです");
  const addresses = await lookup(hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some((item) => !isPublicAddress(item.address))
  )
    throw new Error("非公開ネットワークのアドレスは取得できません");
  url.hash = "";
  return url;
}

/** Exact-host allowlist + DNS validation. Direct transport pins the validated lookup. */
function dispatcher(): Dispatcher {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) {
    // A proxy resolves the hostname independently. Do not trust a preflight DNS check alone.
    // Only an operator-managed proxy that rejects nonpublic destinations on every resolution is supported.
    if (process.env.KENSHO_PROXY_PUBLIC_DESTINATIONS_ONLY !== "1")
      throw new Error("プロキシ側の非公開IP拒否設定の確認が必要です");
    return new ProxyAgent(proxy);
  }
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        lookup(hostname, { all: true })
          .then((addresses) => {
            if (
              !addresses.length ||
              addresses.some((address) => !isPublicAddress(address.address))
            ) {
              callback(new Error("DNS address is not public"), []);
              return;
            }
            // undici requests all addresses on modern Node; keep the validated set in this connection.
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0].address, addresses[0].family);
          })
          .catch((error) => callback(error, []));
      },
    },
  });
}

const nextRequest = new Map<string, number>();
const hostQueues = new Map<string, Promise<unknown>>();
async function fetchBounded(
  url: URL,
): Promise<{ status: number; location: string | null; text: string }> {
  const previous = hostQueues.get(url.hostname) || Promise.resolve();
  const work = previous
    .catch(() => {})
    .then(async () => {
      const wait = (nextRequest.get(url.hostname) || 0) - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      nextRequest.set(url.hostname, Date.now() + 2000);
      const transport = dispatcher();
      try {
        const response = await request(url, {
          dispatcher: transport,
          redirect: "manual",
          signal: AbortSignal.timeout(15000),
          headers: {
            "user-agent":
              "KenshoHunter/0.1 (+respect-robots; campaign-discovery)",
            accept:
              "text/html,application/rss+xml,application/atom+xml,application/xml,text/plain",
          },
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          return {
            status: response.status,
            location: response.headers.get("location"),
            text: "",
          };
        }
        if (Number(response.headers.get("content-length")) > MAX_BYTES) {
          await response.body?.cancel();
          throw new Error("取得サイズの上限を超えています");
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`取得先が HTTP ${response.status} を返しました`);
        }
        const contentType = response.headers.get("content-type") || "";
        if (!/(?:text\/|xml|html|json)/i.test(contentType)) {
          await response.body?.cancel();
          throw new Error("テキスト以外の応答です");
        }
        const reader = response.body?.getReader();
        let size = 0;
        const parts: Uint8Array[] = [];
        if (reader)
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > MAX_BYTES) {
              await reader.cancel();
              throw new Error("取得サイズの上限を超えています");
            }
            parts.push(part.value);
          }
        return {
          status: response.status,
          location: null,
          text: Buffer.concat(parts).toString("utf8"),
        };
      } finally {
        await transport.close();
      }
    });
  hostQueues.set(url.hostname, work);
  try {
    return await work;
  } finally {
    if (hostQueues.get(url.hostname) === work) hostQueues.delete(url.hostname);
  }
}

/** Conservative robots parser: most specific matching group and longest rule win. */
export function robotsAllows(
  text: string,
  pathname: string,
  agent = "kenshohunter",
): boolean {
  const groups: {
    agents: string[];
    rules: { allow: boolean; path: string }[];
  }[] = [];
  let group: (typeof groups)[number] | undefined;
  let hasRules = false;
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/#.*$/, "").trim();
    const split = clean.indexOf(":");
    if (split < 0) continue;
    const name = clean.slice(0, split).trim().toLowerCase(),
      value = clean.slice(split + 1).trim();
    if (name === "user-agent") {
      if (!group || hasRules) {
        group = { agents: [], rules: [] };
        groups.push(group);
        hasRules = false;
      }
      group.agents.push(value.toLowerCase());
    } else if (group && (name === "allow" || name === "disallow")) {
      hasRules = true;
      if (value) group.rules.push({ allow: name === "allow", path: value });
    }
  }
  const lengths = groups.map((item) =>
    Math.max(
      0,
      ...item.agents
        .filter((value) => value !== "*" && agent.includes(value))
        .map((value) => value.length),
    ),
  );
  const longest = Math.max(0, ...lengths);
  const selected = longest
    ? groups.filter((_, index) => lengths[index] === longest)
    : groups.filter((item) => item.agents.includes("*"));
  const matches = selected
    .flatMap((item) => item.rules)
    .filter((rule) => {
      const expression = rule.path
        .split("*")
        .map((part) => part.replace(/[.+?^{}()|[\]\\]/g, "\\$&"))
        .join(".*")
        .replace(/\$$/, "$");
      try {
        return new RegExp(`^${expression}`).test(pathname);
      } catch {
        return false;
      }
    })
    .sort(
      (a, b) =>
        b.path.length - a.path.length || Number(b.allow) - Number(a.allow),
    );
  return matches[0]?.allow ?? true;
}

const robotsCache = new Map<string, { text: string; until: number }>();
async function checkRobots(url: URL, allowedHosts: string[]): Promise<void> {
  let cached = robotsCache.get(url.origin);
  if (!cached || cached.until < Date.now()) {
    const robots = await validatePublicUrl(
      new URL("/robots.txt", url).href,
      allowedHosts,
    );
    // An unavailable robots file is intentionally fail closed. Owners can publish an explicit empty file.
    const response = await fetchBounded(robots);
    if (response.status !== 200) throw new Error("robots.txt を確認できません");
    cached = { text: response.text, until: Date.now() + 3600_000 };
    robotsCache.set(url.origin, cached);
  }
  if (!robotsAllows(cached.text, url.pathname + url.search))
    throw new Error("robots.txt により取得が禁止されています");
}

/** Validate a navigation target and its current robots policy without fetching the page itself. */
export async function assertRobotsAllowed(
  raw: string,
  allowedHosts: string[],
): Promise<void> {
  const url = await validatePublicUrl(raw, allowedHosts);
  await checkRobots(url, allowedHosts);
}

export async function safeFetchText(
  raw: string,
  allowedHosts: string[],
): Promise<{ text: string; url: string }> {
  let current = raw;
  for (let hops = 0; hops < 5; hops++) {
    const url = await validatePublicUrl(current, allowedHosts);
    await checkRobots(url, allowedHosts);
    const response = await fetchBounded(url);
    if (response.status >= 300 && response.status < 400) {
      if (!response.location) throw new Error("不正なリダイレクトです");
      current = new URL(response.location, url).href;
      continue;
    }
    return { text: response.text, url: url.href };
  }
  throw new Error("リダイレクト回数が上限を超えました");
}
