import { z } from "zod";

import type { AppSettings } from "../config.js";
import type { ConversationHistory, JsonValue } from "../domain/messageHistory.js";
import type { LlmRequest, ModelInfo } from "../providers/contracts.js";
import { GoogleGenAiMediaGateway } from "../providers/googleGenAiMediaGateway.js";
import type { MediaGenerationGateway } from "../providers/mediaGenerationGateway.js";
import type { ProviderRouter } from "../providers/providerRouter.js";
import type { AgentSpecialist, SlackAgentInvocation } from "./schemas.js";

export type AgentSpecialistRuntimeInput = {
  invocation: SlackAgentInvocation;
  model: ModelInfo;
  providerRouter: Pick<ProviderRouter, "generate" | "registry">;
};

export type AgentSpecialistRuntimeResult = {
  message: string;
  raw?: unknown;
  structuredResult: JsonValue;
};

export type AgentSpecialistRuntime = (
  input: AgentSpecialistRuntimeInput,
) => Promise<AgentSpecialistRuntimeResult>;

export type GoogleMapsGateway = {
  computeRoute(input: {
    destination: string;
    origin: string;
    travelMode?: string;
  }): Promise<GoogleMapsRoute>;
  searchNearby(input: {
    anchor: string;
    query: string;
    radiusMeters?: number;
  }): Promise<GoogleMapsPlace[]>;
  searchPlaces(query: string): Promise<GoogleMapsPlace[]>;
};

export const webResearchResultSchema = z
  .object({
    action: z.enum(["answered", "clarification_needed"]).default("answered"),
    answer: z.string().default(""),
    caveats: z.array(z.string()).default([]),
    followUpQuestion: z.string().optional(),
    sources: z
      .array(
        z
          .object({
            title: z.string().min(1),
            url: z.string().url(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const googleMapsPlaceSchema = z
  .object({
    address: z.string().optional(),
    googleMapsUri: z.string().url().optional(),
    name: z.string().min(1),
    placeId: z.string().optional(),
    rating: z.number().optional(),
  })
  .strict();

export const googleMapsResultSchema = z
  .object({
    action: z.enum(["answered", "clarification_needed", "unconfigured"]).default("answered"),
    answer: z.string().default(""),
    followUpQuestion: z.string().optional(),
    places: z.array(googleMapsPlaceSchema).default([]),
    route: z
      .object({
        destination: z.string().min(1),
        distanceMeters: z.number().optional(),
        durationSeconds: z.number().optional(),
        googleMapsUri: z.string().url().optional(),
        origin: z.string().min(1),
        summary: z.string().optional(),
        travelMode: z.string().default("driving"),
      })
      .strict()
      .optional(),
  })
  .strict();

export const imageGenerationResultSchema = z
  .object({
    action: z.enum(["generated", "unconfigured"]).default("generated"),
    media: z
      .object({
        dataBase64: z.string().optional(),
        kind: z.literal("image"),
        mimeType: z.string().optional(),
        modelId: z.string().min(1),
        prompt: z.string().min(1),
        provider: z.string().min(1),
        status: z.literal("generated"),
        uri: z.string().url().optional(),
      })
      .strict(),
    message: z.string().min(1),
  })
  .strict();

export const videoGenerationResultSchema = z
  .object({
    action: z.enum(["generated", "in_progress", "unconfigured"]).default("generated"),
    media: z
      .object({
        aspectRatio: z.enum(["16:9", "9:16"]).default("16:9"),
        dataBase64: z.string().optional(),
        durationSeconds: z.number().int().positive().default(8),
        kind: z.literal("video"),
        mimeType: z.string().optional(),
        modelId: z.string().min(1),
        operationName: z.string().optional(),
        prompt: z.string().min(1),
        provider: z.string().min(1),
        status: z.enum(["generated", "in_progress"]),
        uri: z.string().url().optional(),
      })
      .strict(),
    message: z.string().min(1),
  })
  .strict();

export type GoogleMapsPlace = z.infer<typeof googleMapsPlaceSchema>;
export type GoogleMapsRoute = NonNullable<z.infer<typeof googleMapsResultSchema>["route"]>;

export function createDefaultSpecialistRuntimes(
  settings: AppSettings,
): Partial<Record<AgentSpecialist, AgentSpecialistRuntime>> {
  const googleMapsGateway =
    settings.googleMapsApiKey === undefined
      ? undefined
      : new FetchGoogleMapsGateway(settings.googleMapsApiKey);
  const mediaGateway =
    settings.googleGenerativeAiApiKey === undefined
      ? undefined
      : new GoogleGenAiMediaGateway(settings.googleGenerativeAiApiKey);
  return {
    google_maps: createGoogleMapsRuntime(googleMapsGateway),
    image_generation: createImageGenerationRuntime(settings.imageGenerationModelId, mediaGateway),
    video_generation: createVideoGenerationRuntime(settings.videoGenerationModelId, mediaGateway),
    web_research: createWebResearchRuntime(),
  };
}

export function createWebResearchRuntime(): AgentSpecialistRuntime {
  return async ({ invocation, model, providerRouter }) => {
    const result = await providerRouter.generate({
      history: specialistHistory(
        "You are a web research specialist. Use native web search when available. Return concise JSON with action, answer, sources, and caveats.",
        invocation,
      ),
      maxOutputTokens: 1600,
      metadata: baseMetadata(invocation, "web_research"),
      model,
      providerOptions: {
        google: { grounding: true },
      },
      requiredCapabilities: ["web_search"],
    });
    const parsed = webResearchResultSchema.parse({
      ...asRecord(parseJsonOrAnswer(result.content)),
      sources: normalizeSources(parseJsonOrAnswer(result.content), result.sources),
    });
    return {
      message: renderWebResearch(parsed),
      raw: result.raw,
      structuredResult: parsed,
    };
  };
}

export function createGoogleMapsRuntime(
  gateway: GoogleMapsGateway | undefined,
): AgentSpecialistRuntime {
  return async ({ invocation }) => {
    if (gateway === undefined) {
      const structured = googleMapsResultSchema.parse({
        action: "unconfigured",
        answer: "Google Maps is not configured. Set GOOGLE_MAPS_API_KEY to enable maps lookup.",
      });
      return {
        message: structured.answer,
        structuredResult: structured,
      };
    }
    const routeRequest = parseRouteRequest(invocation.text);
    if (routeRequest !== undefined) {
      const route = await gateway.computeRoute(routeRequest);
      const structured = googleMapsResultSchema.parse({
        action: "answered",
        answer: "Google Maps route:",
        route,
      });
      return {
        message: renderGoogleMaps(structured),
        structuredResult: structured,
      };
    }

    const nearbyRequest = parseNearbyRequest(invocation.text);
    const places =
      nearbyRequest === undefined
        ? await gateway.searchPlaces(invocation.text)
        : await gateway.searchNearby(nearbyRequest);
    const structured = googleMapsResultSchema.parse({
      action: "answered",
      answer:
        places.length === 0 ? "Google Maps returned no matching places." : "Google Maps results:",
      places,
    });
    return {
      message: renderGoogleMaps(structured),
      structuredResult: structured,
    };
  };
}

export function createImageGenerationRuntime(
  modelId: string,
  gateway?: MediaGenerationGateway,
): AgentSpecialistRuntime {
  return async ({ invocation, providerRouter }) => {
    const model = providerRouter.registry.get(modelId);
    providerRouter.registry.assertCapabilities(model, ["image_generation"]);
    if (gateway === undefined) {
      const structured = imageGenerationResultSchema.parse({
        action: "unconfigured",
        media: {
          kind: "image",
          modelId: model.id,
          prompt: invocation.text,
          provider: model.provider,
          status: "generated",
        },
        message:
          "Image generation is not configured. Set GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY.",
      });
      return {
        message: structured.message,
        structuredResult: structured,
      };
    }
    const generated = await gateway.generateImage({ model, prompt: invocation.text });
    const structured = imageGenerationResultSchema.parse({
      action: "generated",
      media: {
        dataBase64: generated.dataBase64,
        kind: "image",
        mimeType: generated.mimeType,
        modelId: model.id,
        prompt: invocation.text,
        provider: model.provider,
        status: "generated",
        uri: generated.uri,
      },
      message: "Image generated by the native provider path.",
    });
    return {
      message: structured.message,
      structuredResult: structured,
    };
  };
}

export function createVideoGenerationRuntime(
  modelId: string,
  gateway?: MediaGenerationGateway,
): AgentSpecialistRuntime {
  return async ({ invocation, providerRouter }) => {
    const model = providerRouter.registry.get(modelId);
    providerRouter.registry.assertCapabilities(model, ["video_generation"]);
    const aspectRatio = /\b(vertical|portrait|reels|shorts|9:16)\b/iu.test(invocation.text)
      ? "9:16"
      : "16:9";
    const durationSeconds = 8;
    if (gateway === undefined) {
      const structured = videoGenerationResultSchema.parse({
        action: "unconfigured",
        media: {
          aspectRatio,
          durationSeconds,
          kind: "video",
          modelId: model.id,
          prompt: invocation.text,
          provider: model.provider,
          status: "in_progress",
        },
        message:
          "Video generation is not configured. Set GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY.",
      });
      return {
        message: structured.message,
        structuredResult: structured,
      };
    }
    const generated = await gateway.generateVideo({
      aspectRatio,
      durationSeconds,
      model,
      prompt: invocation.text,
    });
    const structured = videoGenerationResultSchema.parse({
      action: generated.status,
      media: {
        aspectRatio,
        dataBase64: generated.dataBase64,
        durationSeconds,
        kind: "video",
        mimeType: generated.mimeType,
        modelId: model.id,
        operationName: generated.operationName,
        prompt: invocation.text,
        provider: model.provider,
        status: generated.status,
        uri: generated.uri,
      },
      message:
        generated.status === "generated"
          ? "Video generated by the native provider path."
          : "Video generation started by the native provider path.",
    });
    return {
      message: structured.message,
      structuredResult: structured,
    };
  };
}

export class FetchGoogleMapsGateway implements GoogleMapsGateway {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async searchPlaces(query: string): Promise<GoogleMapsPlace[]> {
    const response = await this.fetchFn("https://places.googleapis.com/v1/places:searchText", {
      body: JSON.stringify({ maxResultCount: 5, textQuery: query }),
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this.apiKey,
        "x-goog-fieldmask":
          "places.id,places.displayName,places.formattedAddress,places.googleMapsUri,places.rating",
      },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`Google Maps search failed with HTTP ${response.status}.`);
    }
    const payload = (await response.json()) as { places?: unknown[] };
    return (payload.places ?? []).slice(0, 5).flatMap((place) => {
      const parsed = parseGooglePlace(place);
      return parsed === undefined ? [] : [parsed];
    });
  }

  async searchNearby(input: {
    anchor: string;
    query: string;
    radiusMeters?: number;
  }): Promise<GoogleMapsPlace[]> {
    return this.searchPlaces(`${input.query} near ${input.anchor}`);
  }

  async computeRoute(input: {
    destination: string;
    origin: string;
    travelMode?: string;
  }): Promise<GoogleMapsRoute> {
    const response = await this.fetchFn(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        body: JSON.stringify({
          destination: { address: input.destination },
          origin: { address: input.origin },
          travelMode: (input.travelMode ?? "driving").toUpperCase(),
        }),
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
          "x-goog-fieldmask": "routes.distanceMeters,routes.duration,routes.description",
        },
        method: "POST",
      },
    );
    if (!response.ok) {
      throw new Error(`Google Maps route failed with HTTP ${response.status}.`);
    }
    const payload = (await response.json()) as { routes?: unknown[] };
    const route = payload.routes?.[0];
    if (route === null || typeof route !== "object") {
      throw new Error("Google Maps route response did not contain a route.");
    }
    const record = route as Record<string, unknown>;
    return {
      destination: input.destination,
      distanceMeters: typeof record.distanceMeters === "number" ? record.distanceMeters : undefined,
      durationSeconds: parseDurationSeconds(record.duration),
      googleMapsUri: `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(input.origin)}&destination=${encodeURIComponent(input.destination)}&travelmode=${encodeURIComponent(input.travelMode ?? "driving")}`,
      origin: input.origin,
      summary: typeof record.description === "string" ? record.description : undefined,
      travelMode: input.travelMode ?? "driving",
    };
  }
}

function specialistHistory(prompt: string, invocation: SlackAgentInvocation): ConversationHistory {
  return {
    messages: [
      { content: prompt, id: "system", role: "system" },
      ...invocation.threadMessages.map((message, index) => ({
        author: { id: "slack-thread", kind: "user" as const },
        content: [{ text: message, type: "text" as const }],
        id: `thread-${index}`,
        role: "user" as const,
      })),
      {
        author: { id: invocation.userId, kind: "user" as const },
        content: [{ text: invocation.text, type: "text" as const }],
        id: invocation.messageTs,
        role: "user" as const,
      },
    ],
  };
}

function baseMetadata(
  invocation: SlackAgentInvocation,
  specialist: AgentSpecialist,
): LlmRequest["metadata"] {
  return {
    slack_channel_id: invocation.channelId,
    slack_team_id: invocation.teamId,
    slack_user_id: invocation.userId,
    specialist,
  };
}

function parseJsonOrAnswer(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return {
      action: "answered",
      answer: content,
      sources: [],
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeSources(
  parsedContent: unknown,
  resultSources: readonly { title?: string; url: string }[] | undefined,
) {
  if (resultSources !== undefined && resultSources.length > 0) {
    return resultSources.map((source) => ({
      title: source.title ?? source.url,
      url: source.url,
    }));
  }
  const sources = asRecord(parsedContent).sources;
  return Array.isArray(sources) ? sources : [];
}

function renderWebResearch(result: z.infer<typeof webResearchResultSchema>): string {
  if (result.action === "clarification_needed") {
    return result.followUpQuestion ?? "What exactly should I verify on the web?";
  }
  const sections = [result.answer];
  if (result.sources.length > 0) {
    sections.push(
      `Sources:\n${result.sources.map((source) => `- ${source.title}: ${source.url}`).join("\n")}`,
    );
  }
  if (result.caveats.length > 0) {
    sections.push(`Caveats:\n${result.caveats.map((caveat) => `- ${caveat}`).join("\n")}`);
  }
  return sections.filter((section) => section.trim() !== "").join("\n\n");
}

function renderGoogleMaps(result: z.infer<typeof googleMapsResultSchema>): string {
  if (result.action === "clarification_needed") {
    return result.followUpQuestion ?? "Which place or route should I look up?";
  }
  if (result.places.length === 0) {
    if (result.route === undefined) {
      return result.answer;
    }
    return `${result.answer}\n- ${result.route.origin} -> ${result.route.destination}${result.route.durationSeconds === undefined ? "" : ` (${Math.round(result.route.durationSeconds / 60)} min)`}${result.route.googleMapsUri === undefined ? "" : `\n- ${result.route.googleMapsUri}`}`;
  }
  return `${result.answer}\n${result.places
    .map((place) => {
      const details = [place.name, place.address, place.googleMapsUri].filter(Boolean);
      return `- ${details.join(" | ")}`;
    })
    .join("\n")}`;
}

function parseRouteRequest(
  text: string,
): { destination: string; origin: string; travelMode?: string } | undefined {
  const trimmed = text.trim();
  const englishMatch = /\b(?:route|directions?)\s+from\s+(.+?)\s+to\s+(.+)$/iu.exec(trimmed);
  if (englishMatch?.[1] !== undefined && englishMatch[2] !== undefined) {
    return {
      destination: englishMatch[2].trim(),
      origin: englishMatch[1].trim(),
      travelMode: /\b(walk|walking)\b/iu.test(text) ? "walking" : "driving",
    };
  }
  const japaneseMatch = /^(.+?)から(.+?)(?:まで|への|の)?経路/u.exec(trimmed);
  if (japaneseMatch?.[1] === undefined || japaneseMatch[2] === undefined) {
    return undefined;
  }
  return {
    destination: japaneseMatch[2].trim(),
    origin: japaneseMatch[1].trim(),
    travelMode: /徒歩/u.test(text) ? "walking" : "driving",
  };
}

function parseNearbyRequest(
  text: string,
): { anchor: string; query: string; radiusMeters?: number } | undefined {
  const match = /\b(?:nearby|near)\s+(.+?)\s+(?:around|near)\s+(.+)$/iu.exec(text.trim());
  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined;
  }
  return {
    anchor: match[2].trim(),
    query: match[1].trim(),
  };
}

function parseDurationSeconds(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^(\d+)s$/u.exec(value);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function parseGooglePlace(value: unknown): GoogleMapsPlace | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const displayName = record.displayName;
  const name =
    displayName !== null && typeof displayName === "object"
      ? (displayName as Record<string, unknown>).text
      : undefined;
  if (typeof name !== "string" || name.length === 0) {
    return undefined;
  }
  return googleMapsPlaceSchema.parse({
    address: typeof record.formattedAddress === "string" ? record.formattedAddress : undefined,
    googleMapsUri: typeof record.googleMapsUri === "string" ? record.googleMapsUri : undefined,
    name,
    placeId: typeof record.id === "string" ? record.id : undefined,
    rating: typeof record.rating === "number" ? record.rating : undefined,
  });
}
