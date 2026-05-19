import { z } from "zod";

import type { JsonValue } from "../../domain/messageHistory.js";
import type { ModelInfo } from "../../providers/contracts.js";
import type { ProviderCredentialResolver } from "../../providers/credentials.js";
import { GoogleGenAiMediaGateway } from "../../providers/googleGenAiMediaGateway.js";
import { OpenAiMediaGateway } from "../../providers/openAiMediaGateway.js";
import type { ModelRegistry } from "../../providers/modelRegistry.js";
import type { WorkspaceFeatureSettingsRepository } from "../../repositories/workspaceFeatureSettings.js";
import type { AgentToolDefinition } from "../toolContracts.js";

export type MediaGenerationToolContext = {
  channelId: string;
  teamId: string;
};

export type MediaGenerationToolOptions = {
  context: MediaGenerationToolContext;
  credentialResolver?: ProviderCredentialResolver;
  featureSettingsRepository?: WorkspaceFeatureSettingsRepository;
  imageGenerationModelId: string;
  modelRegistry: Pick<ModelRegistry, "assertCapabilities" | "get">;
};

const generateImageInputSchema = z
  .object({
    aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).optional(),
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
  const channelAllowed = await options.featureSettingsRepository.isChannelAllowed({
    channelId: options.context.channelId,
    featureKey: "image_generation",
    teamId: options.context.teamId,
  });
  if (!channelAllowed) {
    return failure(
      "channel_not_allowed",
      "Image generation is not enabled for this Slack channel.",
    );
  }

  const model = options.modelRegistry.get(options.imageGenerationModelId);
  options.modelRegistry.assertCapabilities(model, ["image_generation"]);
  const credential = await options.credentialResolver?.resolveProviderCredential({
    credentialName: "api_key",
    provider: model.provider,
    workspaceId: options.context.teamId,
  });
  if (credential === undefined) {
    return failure(
      "missing_provider_credential",
      `No active ${model.provider} API key is configured for image generation in this workspace.`,
    );
  }

  const gateway = mediaGatewayForModel(model, credential);
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
