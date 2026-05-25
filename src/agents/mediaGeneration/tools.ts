import { z } from "zod";

import type { JsonValue } from "../../domain/messageHistory.js";
import type { ModelInfo } from "../../providers/contracts.js";
import type { ProviderCredentialResolver } from "../../providers/credentials.js";
import { GoogleGenAiMediaGateway } from "../../providers/googleGenAiMediaGateway.js";
import { OpenAiMediaGateway } from "../../providers/openAiMediaGateway.js";
import type { ModelRegistry } from "../../providers/modelRegistry.js";
import type { WorkspaceFeatureSettingsRepository } from "../../repositories/workspaceFeatureSettings.js";
import type { AgentToolDefinition } from "../toolContracts.js";

export const defaultImageGenerationFallbackModelIds = [
  "openai:gpt-image-2",
  "openai:gpt-image-1.5",
  "google:gemini-2.5-flash-image",
] as const;

export type MediaGenerationToolContext = {
  channelId: string;
  teamId: string;
  viewerContextChannelIds?: readonly string[];
};

type MediaGateway = {
  generateImage(input: { model: ModelInfo; prompt: string }): Promise<{
    dataBase64?: string;
    mimeType?: string;
    uri?: string;
  }>;
};

export type MediaGenerationToolOptions = {
  context: MediaGenerationToolContext;
  credentialResolver?: ProviderCredentialResolver;
  featureSettingsRepository?: WorkspaceFeatureSettingsRepository;
  imageGenerationFallbackModelIds?: readonly string[];
  imageGenerationModelId: string;
  mediaGatewayFactory?: (
    model: ModelInfo,
    credential: { apiKey: string; baseURL?: string },
  ) => MediaGateway | undefined;
  modelRegistry: Pick<ModelRegistry, "assertCapabilities" | "get">;
};

const generateImageInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
  })
  .strict();

const mediaToolOutputSchema = z
  .object({
    code: z.string().optional(),
    media: z
      .object({
        dataBase64: z.string().optional(),
        kind: z.literal("image"),
        mimeType: z.string().optional(),
        modelId: z.string(),
        prompt: z.string(),
        provider: z.string(),
        status: z.literal("generated"),
        uri: z.string().optional(),
      })
      .optional(),
    message: z.string(),
    ok: z.boolean(),
  })
  .strict();

type GenerateImageInput = z.infer<typeof generateImageInputSchema>;
type MediaToolOutput = z.infer<typeof mediaToolOutputSchema>;

export function createMediaGenerationAgentTools(
  options: MediaGenerationToolOptions,
): AgentToolDefinition[] {
  return [
    {
      description:
        "Generate an image from a text prompt when the user asks to create, draw, render, or generate an image. Use this only for image generation requests.",
      execute: async (input) => generateImageTool(input as GenerateImageInput, options),
      name: "generate_image",
      outputSchema: mediaToolOutputSchema as z.ZodType<JsonValue>,
      parameters: z.toJSONSchema(generateImageInputSchema) as JsonValue,
      schema: generateImageInputSchema as z.ZodType<JsonValue>,
    },
  ];
}

async function generateImageTool(
  input: GenerateImageInput,
  options: MediaGenerationToolOptions,
): Promise<MediaToolOutput> {
  if (options.featureSettingsRepository === undefined) {
    return failure(
      "feature_settings_not_configured",
      "Image generation is not configured for this workspace.",
    );
  }
  const workspaceSetting = await options.featureSettingsRepository.findWorkspaceFeatureSetting({
    featureKey: "image_generation",
    teamId: options.context.teamId,
  });
  if (workspaceSetting?.enabled !== true) {
    return failure("feature_disabled", "Image generation is disabled for this workspace.");
  }
  const channelAllowed = await isImageGenerationAllowedForSlackContext(options, workspaceSetting);
  if (!channelAllowed) {
    return failure(
      "channel_not_allowed",
      "Image generation is not enabled for this Slack channel.",
    );
  }

  const selectedImageGenerationModelId =
    stringPayloadField(workspaceSetting.payload, "image_generation_model_id") ??
    options.imageGenerationModelId;
  const resolution = await resolveImageGenerationModelCredential(
    options,
    selectedImageGenerationModelId,
  );
  if (resolution === undefined) {
    return failure(
      "missing_provider_credential",
      "No active OpenAI or Google API key is configured for image generation in this workspace.",
    );
  }
  const { credential, model } = resolution;

  const gateway = (options.mediaGatewayFactory ?? mediaGatewayForModel)(model, credential);
  if (gateway === undefined) {
    return failure(
      "unsupported_image_provider",
      `Image generation is not supported for provider '${model.provider}'.`,
    );
  }
  const media = await gateway.generateImage({
    model,
    prompt: input.prompt,
  });
  return {
    media: {
      dataBase64: media.dataBase64,
      kind: "image",
      mimeType: media.mimeType,
      modelId: model.id,
      prompt: input.prompt,
      provider: model.provider,
      status: "generated",
      uri: media.uri,
    },
    message: "Image generated.",
    ok: true,
  };
}

async function resolveImageGenerationModelCredential(
  options: MediaGenerationToolOptions,
  imageGenerationModelId: string,
): Promise<{ credential: { apiKey: string; baseURL?: string }; model: ModelInfo } | undefined> {
  const configuredModel = options.modelRegistry.get(imageGenerationModelId);
  options.modelRegistry.assertCapabilities(configuredModel, ["image_generation"]);
  const models = [
    configuredModel,
    ...candidateFallbackModelIds(options)
      .map((modelId) => resolveFallbackImageGenerationModel(modelId, options))
      .filter((model): model is ModelInfo => model !== undefined),
  ];
  const seenProviders = new Set<string>();
  for (const model of models) {
    if (seenProviders.has(model.provider)) {
      continue;
    }
    seenProviders.add(model.provider);
    const credential = await options.credentialResolver?.resolveProviderCredential({
      credentialName: "api_key",
      provider: model.provider,
      workspaceId: options.context.teamId,
    });
    if (credential !== undefined) {
      return { credential, model };
    }
  }
  return undefined;
}

function candidateFallbackModelIds(options: MediaGenerationToolOptions): string[] {
  return [...new Set(options.imageGenerationFallbackModelIds ?? [])].filter(
    (modelId) => modelId !== options.imageGenerationModelId,
  );
}

function resolveFallbackImageGenerationModel(
  modelId: string,
  options: MediaGenerationToolOptions,
): ModelInfo | undefined {
  try {
    const model = options.modelRegistry.get(modelId);
    options.modelRegistry.assertCapabilities(model, ["image_generation"]);
    return model.provider === "openai" || model.provider === "google" ? model : undefined;
  } catch {
    return undefined;
  }
}

function mediaGatewayForModel(model: ModelInfo, credential: { apiKey: string; baseURL?: string }) {
  switch (model.provider) {
    case "openai":
      return new OpenAiMediaGateway(credential);
    case "google":
      return new GoogleGenAiMediaGateway(credential.apiKey);
    default:
      return undefined;
  }
}

function failure(code: string, message: string): MediaToolOutput {
  return {
    code,
    message,
    ok: false,
  };
}

function isSlackDirectMessageChannel(channelId: string): boolean {
  return channelId.startsWith("D");
}

async function isImageGenerationAllowedForSlackContext(
  options: MediaGenerationToolOptions,
  workspaceSetting: { payload: Record<string, JsonValue> },
): Promise<boolean> {
  const contextChannelIds = [
    ...new Set([options.context.channelId, ...(options.context.viewerContextChannelIds ?? [])]),
  ];
  const sourceChannelIds = contextChannelIds.filter(
    (channelId) => !isSlackDirectMessageChannel(channelId),
  );
  if (sourceChannelIds.length > 0) {
    for (const channelId of sourceChannelIds) {
      if (
        await options.featureSettingsRepository?.isChannelAllowed({
          channelId,
          featureKey: "image_generation",
          teamId: options.context.teamId,
        })
      ) {
        return true;
      }
    }
    return false;
  }
  return (
    isSlackDirectMessageChannel(options.context.channelId) &&
    booleanPayloadField(workspaceSetting.payload, "allow_direct_messages") === true
  );
}

function stringPayloadField(payload: Record<string, JsonValue>, field: string): string | undefined {
  const value = payload[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanPayloadField(
  payload: Record<string, JsonValue>,
  field: string,
): boolean | undefined {
  const value = payload[field];
  return typeof value === "boolean" ? value : undefined;
}
