import { GoogleGenAI, type Fetch } from "@google/genai";
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";
import type { AIModel } from "./schemas";

export interface GeminiGenerationInput {
  apiKey: string;
  model: string;
  prompt: string;
  systemInstruction: string;
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
}
export interface GeminiGenerationResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}
/** Injectable only in server tests; no environment switch can replace the production transport. */
export interface GeminiTransport {
  listModels(apiKey: string): Promise<AIModel[]>;
  generate(input: GeminiGenerationInput): Promise<GeminiGenerationResult>;
}
const API_ORIGIN = "https://generativelanguage.googleapis.com";
const MAX_RESPONSE_BYTES = 2_000_000;
let proxyDispatcher: Dispatcher | undefined;
function proxy(): Dispatcher | undefined {
  const address = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!address) return undefined;
  return (proxyDispatcher ??= new ProxyAgent(address));
}
/** Preserve inherited proxy/CA trust and never send a key to a model-supplied endpoint. */
export const fixedGeminiFetch: Fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (
    url.origin !== API_ORIGIN ||
    !/^\/v1beta\/models(?:\/|$)/.test(url.pathname) ||
    url.username ||
    url.password ||
    !["GET", "POST"].includes(request.method)
  )
    throw new Error("Gemini destination rejected");
  const response = await undiciFetch(url, {
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body: request.method === "GET" ? undefined : await request.text(),
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(21000)]),
    dispatcher: proxy(),
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error("Gemini redirect rejected");
  }
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("Gemini response limit");
  }
  const reader = response.body?.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.length;
        if (length > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("Gemini response limit");
        }
        parts.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  return new Response(Buffer.concat(parts), {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
  });
};
function client(apiKey: string) {
  return new GoogleGenAI({
    apiKey,
    vertexai: false,
    enterprise: false,
    apiVersion: "v1beta",
    httpOptions: {
      baseUrl: API_ORIGIN,
      timeout: 20000,
      retryOptions: { attempts: 1 },
      fetch: fixedGeminiFetch,
    },
  });
}
export function createGeminiTransport(): GeminiTransport {
  return {
    async listModels(apiKey) {
      // Only the first bounded page is fetched: automatic pagination would evade per-call accounting.
      const pager = await client(apiKey).models.list({
        config: { pageSize: 1000, queryBase: true },
      });
      const models: AIModel[] = [];
      for (const model of pager.page) {
        if (!model.supportedActions?.includes("generateContent") || !model.name)
          continue;
        const id = model.name.replace(/^models\//, "");
        if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(id))
          models.push({
            id,
            displayName: (model.displayName || id).slice(0, 160),
          });
      }
      return models;
    },
    async generate(input) {
      const result = await client(input.apiKey).models.generateContent({
        model: input.model,
        contents: input.prompt,
        config: {
          systemInstruction: input.systemInstruction,
          responseMimeType: "application/json",
          responseJsonSchema: input.jsonSchema,
          maxOutputTokens: input.maxOutputTokens,
          candidateCount: 1,
          temperature: 0,
        },
      });
      const usage = result.usageMetadata;
      const known =
        Number.isSafeInteger(usage?.promptTokenCount) &&
        Number.isSafeInteger(usage?.totalTokenCount);
      const inputTokens = known
        ? usage!.promptTokenCount!
        : Buffer.byteLength(
            input.prompt +
              input.systemInstruction +
              JSON.stringify(input.jsonSchema),
            "utf8",
          );
      const outputTokens = known
        ? Math.max(0, usage!.totalTokenCount! - inputTokens)
        : input.maxOutputTokens;
      return {
        text: result.text ?? "",
        inputTokens,
        outputTokens,
        estimated: !known,
      };
    },
  };
}
