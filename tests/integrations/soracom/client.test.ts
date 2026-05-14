import { describe, expect, it } from "vite-plus/test";

import {
  SoracomApiError,
  SoracomClient,
  soracomBaseUrl,
} from "../../../src/integrations/soracom/index.js";

describe("SoracomClient", () => {
  it("authenticates with AuthKey and sends SORACOM token headers", async () => {
    const fetch = new RecordingFetch([
      jsonResponse({ apiKey: "api-key", token: "token" }),
      jsonResponse(
        { simId: "sim-1", status: "active" },
        {
          "x-soracom-ratelimit-limit": "60",
          "x-soracom-ratelimit-remaining": "59",
          "x-soracom-ratelimit-seconds-before-refresh": "10",
        },
      ),
    ]);
    const client = new SoracomClient({
      credential: {
        authKey: "secret-1",
        authKeyId: "keyId-1",
        coverageType: "global",
      },
      fetchFn: fetch.call,
      now: () => 1000,
    });

    await expect(client.getSim("sim-1")).resolves.toEqual({
      body: { simId: "sim-1", status: "active" },
      rateLimit: {
        limit: 60,
        remaining: 59,
        secondsBeforeRefresh: 10,
      },
    });

    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls[0]?.url).toBe("https://g.api.soracom.io/v1/auth");
    expect(fetch.calls[0]?.init.body).toBe(
      JSON.stringify({ authKey: "secret-1", authKeyId: "keyId-1" }),
    );
    expect(fetch.calls[1]?.url).toBe("https://g.api.soracom.io/v1/sims/sim-1");
    const headers = fetch.calls[1]?.init.headers as Record<string, string>;
    expect(headers["X-Soracom-API-Key"]).toBe("api-key");
    expect(headers["X-Soracom-Token"]).toBe("token");
  });

  it("caches auth tokens for subsequent requests", async () => {
    const fetch = new RecordingFetch([
      jsonResponse({ apiKey: "api-key", token: "token" }),
      jsonResponse({ simId: "sim-1" }),
      jsonResponse({ simId: "sim-2" }),
    ]);
    const client = new SoracomClient({
      credential: { authKey: "secret-1", authKeyId: "keyId-1", coverageType: "japan" },
      fetchFn: fetch.call,
      now: () => 1000,
    });

    await client.getSim("sim-1");
    await client.getSim("sim-2");

    expect(fetch.calls.map((call) => call.url)).toEqual([
      "https://api.soracom.io/v1/auth",
      "https://api.soracom.io/v1/sims/sim-1",
      "https://api.soracom.io/v1/sims/sim-2",
    ]);
  });

  it("extracts pagination next keys from SORACOM response headers", async () => {
    const fetch = new RecordingFetch([
      jsonResponse({ apiKey: "api-key", token: "token" }),
      jsonResponse([{ simId: "sim-1" }], { "x-soracom-next-key": "next-1" }),
      jsonResponse([{ simId: "sim-2" }], {
        link: "</v1/sims?last_evaluated_key=next-2>; rel=next",
      }),
    ]);
    const client = new SoracomClient({
      credential: { authKey: "secret-1", authKeyId: "keyId-1", coverageType: "global" },
      fetchFn: fetch.call,
    });

    await expect(client.listSims()).resolves.toMatchObject({
      pagination: { nextKey: "next-1" },
    });
    await expect(client.listSims({ lastEvaluatedKey: "next-1" })).resolves.toMatchObject({
      pagination: { nextKey: "next-2" },
    });
    expect(fetch.calls[2]?.url).toBe("https://g.api.soracom.io/v1/sims?last_evaluated_key=next-1");
  });

  it("throws redacted API errors with retry and rate limit metadata", async () => {
    const fetch = new RecordingFetch([
      jsonResponse({ apiKey: "api-key", token: "token" }),
      jsonResponse(
        { code: "SEM0001", message: "Too many requests" },
        { "x-soracom-ratelimit-remaining": "0" },
        429,
      ),
    ]);
    const client = new SoracomClient({
      credential: { authKey: "secret-1", authKeyId: "keyId-1", coverageType: "global" },
      fetchFn: fetch.call,
    });

    await expect(client.listSims()).rejects.toMatchObject({
      details: {
        code: "SEM0001",
        rateLimit: { remaining: 0 },
        retriable: true,
        status: 429,
      },
      message: "SORACOM API error 429: Too many requests",
    } satisfies Partial<SoracomApiError>);
  });

  it("resolves official coverage base URLs", () => {
    expect(soracomBaseUrl("global")).toBe("https://g.api.soracom.io");
    expect(soracomBaseUrl("japan")).toBe("https://api.soracom.io");
  });
});

class RecordingFetch {
  readonly calls: Array<{ init: RequestInit; url: string }> = [];

  constructor(private readonly responses: Response[]) {}

  readonly call = async (input: string | URL | Request, init: RequestInit = {}) => {
    this.calls.push({ init, url: input.toString() });
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error("Unexpected fetch call.");
    }
    return response;
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}
