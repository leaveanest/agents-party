import { z } from "zod";

import type { AppSettings } from "../config.js";
import type { ConversationHistory, JsonValue } from "../domain/messageHistory.js";
import type { LlmRequest, ModelInfo } from "../providers/contracts.js";
import type { ProviderRouter } from "../providers/providerRouter.js";
import type { AgentSpecialist, SlackAgentInvocation } from "./schemas.js";

export type AgentSpecialistRuntimeInput = {
  invocation: SlackAgentInvocation;
  model: ModelInfo;
  providerRouter: Pick<ProviderRouter, "generate">;
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
  })
  .strict();

export const imageGenerationResultSchema = z
  .object({
    action: z.enum(["media_handoff"]).default("media_handoff"),
    media: z
      .object({
        kind: z.literal("image"),
        modelId: z.string().min(1),
        prompt: z.string().min(1),
        provider: z.string().min(1),
        status: z.literal("ready_for_native_generation"),
      })
      .strict(),
    message: z.string().min(1),
  })
  .strict();

export const videoGenerationResultSchema = z
  .object({
    action: z.enum(["media_handoff"]).default("media_handoff"),
    media: z
      .object({
        aspectRatio: z.enum(["16:9", "9:16"]).default("16:9"),
        durationSeconds: z.number().int().positive().default(8),
        kind: z.literal("video"),
        modelId: z.string().min(1),
        prompt: z.string().min(1),
        provider: z.string().min(1),
        status: z.literal("ready_for_native_generation"),
      })
      .strict(),
    message: z.string().min(1),
  })
  .strict();

export type GoogleMapsPlace = z.infer<typeof googleMapsPlaceSchema>;

export function createDefaultSpecialistRuntimes(
  settings: AppSettings,
): Partial<Record<AgentSpecialist, AgentSpecialistRuntime>> {
  const googleMapsGateway =
    settings.googleMapsApiKey === undefined
      ? undefined
      : new FetchGoogleMapsGateway(settings.googleMapsApiKey);
  return {
    google_maps: createGoogleMapsRuntime(googleMapsGateway),
    image_generation: createImageGenerationRuntime(),
    video_generation: createVideoGenerationRuntime(),
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
    const parsed = webResearchResultSchema.parse(parseJsonOrAnswer(result.content));
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
    const places = await gateway.searchPlaces(invocation.text);
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

export function createImageGenerationRuntime(): AgentSpecialistRuntime {
  return async ({ invocation, model }) => {
    const structured = imageGenerationResultSchema.parse({
      media: {
        kind: "image",
        modelId: model.id,
        prompt: invocation.text,
        provider: model.provider,
        status: "ready_for_native_generation",
      },
      message: "Image generation request prepared for the native provider path.",
    });
    return {
      message: structured.message,
      structuredResult: structured,
    };
  };
}

export function createVideoGenerationRuntime(): AgentSpecialistRuntime {
  return async ({ invocation, model }) => {
    const structured = videoGenerationResultSchema.parse({
      media: {
        aspectRatio: /\b(vertical|portrait|reels|shorts|9:16)\b/iu.test(invocation.text)
          ? "9:16"
          : "16:9",
        durationSeconds: 8,
        kind: "video",
        modelId: model.id,
        prompt: invocation.text,
        provider: model.provider,
        status: "ready_for_native_generation",
      },
      message: "Video generation request prepared for the native provider path.",
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
    return result.answer;
  }
  return `${result.answer}\n${result.places
    .map((place) => {
      const details = [place.name, place.address, place.googleMapsUri].filter(Boolean);
      return `- ${details.join(" | ")}`;
    })
    .join("\n")}`;
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
