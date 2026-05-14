import { z } from "zod";

import type { JsonValue } from "../../domain/messageHistory.js";

export type SoracomCoverageType = "global" | "japan";

export type SoracomCredential = {
  authKey: string;
  authKeyId: string;
  coverageType: SoracomCoverageType;
  operatorId?: string;
};

export type SoracomRateLimit = {
  limit?: number;
  remaining?: number;
  secondsBeforeRefresh?: number;
};

export type SoracomPagination = {
  nextKey?: string;
};

export type SoracomResponse = {
  body: unknown;
  pagination?: SoracomPagination;
  rateLimit?: SoracomRateLimit;
};

export type SoracomRequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
};

export class SoracomApiError extends Error {
  constructor(
    message: string,
    readonly details: {
      code?: string;
      rateLimit?: SoracomRateLimit;
      retriable: boolean;
      status: number;
    },
  ) {
    super(message);
    this.name = "SoracomApiError";
  }
}

type SoracomAuthToken = {
  apiKey: string;
  expiresAt: number;
  token: string;
};

const soracomAuthResponseSchema = z
  .object({
    apiKey: z.string().min(1),
    operatorId: z.string().optional(),
    token: z.string().min(1),
  })
  .passthrough();

const soracomErrorResponseSchema = z
  .object({
    code: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

export class SoracomClient {
  private token: SoracomAuthToken | undefined;

  constructor(
    private readonly input: {
      credential: SoracomCredential;
      fetchFn?: typeof fetch;
      now?: () => number;
      tokenTtlSeconds?: number;
    },
  ) {}

  async getSim(simId: string): Promise<SoracomResponse> {
    return this.requestJson(`/sims/${encodeURIComponent(simId)}`);
  }

  async listSims(
    input: {
      limit?: number;
      lastEvaluatedKey?: string;
    } = {},
  ): Promise<SoracomResponse> {
    return this.requestJson("/sims", {
      query: {
        last_evaluated_key: input.lastEvaluatedKey,
        limit: input.limit,
      },
    });
  }

  async listSimSessionEvents(input: {
    from?: number;
    limit?: number;
    simId: string;
    to?: number;
  }): Promise<SoracomResponse> {
    return this.requestJson(`/sims/${encodeURIComponent(input.simId)}/events/sessions`, {
      query: {
        from: input.from,
        limit: input.limit,
        to: input.to,
      },
    });
  }

  async listSimStatusHistory(input: {
    from?: number;
    limit?: number;
    simId: string;
    to?: number;
  }): Promise<SoracomResponse> {
    return this.requestJson(`/sims/${encodeURIComponent(input.simId)}/statuses/history`, {
      query: {
        from: input.from,
        limit: input.limit,
        to: input.to,
      },
    });
  }

  async listSoraCamDevices(): Promise<SoracomResponse> {
    return this.requestJson("/sora_cam/devices");
  }

  async listSoraCamDeviceEvents(
    input: {
      deviceId?: string;
      from?: number;
      limit?: number;
      sort?: "asc" | "desc";
      to?: number;
    } = {},
  ): Promise<SoracomResponse> {
    return this.requestJson("/sora_cam/devices/events", {
      query: {
        device_id: input.deviceId,
        from: input.from,
        limit: input.limit,
        sort: input.sort,
        to: input.to,
      },
    });
  }

  async getSoraCamDeviceExportUsage(deviceId: string): Promise<SoracomResponse> {
    return this.requestJson(`/sora_cam/devices/${encodeURIComponent(deviceId)}/exports/usage`);
  }

  private async requestJson(
    path: string,
    options: SoracomRequestOptions = {},
  ): Promise<SoracomResponse> {
    const auth = await this.authenticate();
    const response = await this.fetchFn()(this.url(path, options.query), {
      headers: {
        "X-Soracom-API-Key": auth.apiKey,
        "X-Soracom-Lang": "en",
        "X-Soracom-Token": auth.token,
      },
      method: "GET",
    });
    const rateLimit = rateLimitFromHeaders(response.headers);
    const body = await responseJson(response);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.token = undefined;
      }
      throw soracomApiError(response.status, body, rateLimit);
    }
    return { body, pagination: paginationFromHeaders(response.headers), rateLimit };
  }

  private async authenticate(): Promise<SoracomAuthToken> {
    const now = this.now();
    if (this.token !== undefined && this.token.expiresAt > now + 30_000) {
      return this.token;
    }
    const response = await this.fetchFn()(this.url("/auth"), {
      body: JSON.stringify({
        authKey: this.input.credential.authKey,
        authKeyId: this.input.credential.authKeyId,
      }),
      headers: { "Content-Type": "application/json", "X-Soracom-Lang": "en" },
      method: "POST",
    });
    const body = await responseJson(response);
    if (!response.ok) {
      throw soracomApiError(response.status, body, rateLimitFromHeaders(response.headers));
    }
    const parsed = soracomAuthResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new SoracomApiError("SORACOM auth response did not include an API key and token.", {
        retriable: false,
        status: response.status,
      });
    }
    this.token = {
      apiKey: parsed.data.apiKey,
      expiresAt: now + (this.input.tokenTtlSeconds ?? 3600) * 1000,
      token: parsed.data.token,
    };
    return this.token;
  }

  private url(path: string, query: SoracomRequestOptions["query"] = {}): string {
    const url = new URL(`/v1${path}`, soracomBaseUrl(this.input.credential.coverageType));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private fetchFn(): typeof fetch {
    return this.input.fetchFn ?? fetch;
  }

  private now(): number {
    return this.input.now?.() ?? Date.now();
  }
}

export function soracomBaseUrl(coverageType: SoracomCoverageType): string {
  return coverageType === "global" ? "https://g.api.soracom.io" : "https://api.soracom.io";
}

export function soracomRateLimitToJson(rateLimit: SoracomRateLimit | undefined): JsonValue {
  return compactJson({
    limit: rateLimit?.limit,
    remaining: rateLimit?.remaining,
    secondsBeforeRefresh: rateLimit?.secondsBeforeRefresh,
  });
}

function soracomApiError(
  status: number,
  body: unknown,
  rateLimit: SoracomRateLimit | undefined,
): SoracomApiError {
  const parsed = soracomErrorResponseSchema.safeParse(body);
  const code = parsed.success ? parsed.data.code : undefined;
  const message =
    parsed.success && parsed.data.message !== undefined
      ? `SORACOM API error ${status}: ${parsed.data.message}`
      : `SORACOM API error ${status}.`;
  return new SoracomApiError(message, {
    code,
    rateLimit,
    retriable: status === 429 || status >= 500,
    status,
  });
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function rateLimitFromHeaders(headers: Headers): SoracomRateLimit | undefined {
  const limit = numberHeader(headers, "x-soracom-ratelimit-limit");
  const remaining = numberHeader(headers, "x-soracom-ratelimit-remaining");
  const secondsBeforeRefresh = numberHeader(headers, "x-soracom-ratelimit-seconds-before-refresh");
  if (limit === undefined && remaining === undefined && secondsBeforeRefresh === undefined) {
    return undefined;
  }
  return { limit, remaining, secondsBeforeRefresh };
}

function paginationFromHeaders(headers: Headers): SoracomPagination | undefined {
  const nextKey = headers.get("x-soracom-next-key") ?? nextKeyFromLinkHeader(headers.get("link"));
  return nextKey === undefined || nextKey.trim() === "" ? undefined : { nextKey };
}

function nextKeyFromLinkHeader(linkHeader: string | null): string | undefined {
  if (linkHeader === null) {
    return undefined;
  }
  const nextLink = linkHeader
    .split(",")
    .map((value) => value.trim())
    .find((value) => /;\s*rel="?next"?/iu.test(value));
  const match = /[?&]last_evaluated_key=([^&>]+)/u.exec(nextLink ?? "");
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

function numberHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compactJson(input: Record<string, JsonValue | undefined>): JsonValue {
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}
