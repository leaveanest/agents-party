import { z } from "zod";

import type { JsonValue } from "../../domain/messageHistory.js";
import type { ModelInfo } from "../../providers/contracts.js";
import type { ProviderCredentialResolver } from "../../providers/credentials.js";
import {
  AiSdkSpeechGenerationGateway,
  type SpeechGenerationGateway,
} from "../../providers/speechGenerationGateway.js";
import type { ModelRegistry } from "../../providers/modelRegistry.js";
import type { WorkspaceFeatureSettingsRepository } from "../../repositories/workspaceFeatureSettings.js";
import type { AgentToolDefinition } from "../toolContracts.js";

export type SpeechGenerationToolContext = {
  channelId: string;
  teamId: string;
};

export type SpeechGenerationToolOptions = {
  context: SpeechGenerationToolContext;
  credentialResolver?: ProviderCredentialResolver;
  featureSettingsRepository?: WorkspaceFeatureSettingsRepository;
  modelRegistry: Pick<ModelRegistry, "assertCapabilities" | "get">;
  speechGatewayFactory?: (
    model: ModelInfo,
    credential: { apiKey: string; baseURL?: string },
  ) => SpeechGenerationGateway | undefined;
  textToSpeechModelId?: string;
};

const textToSpeechInputSchema = z
  .object({
    format: z.enum(["mp3", "wav"]).optional(),
    text: z.string().trim().min(1).max(4000),
    voice: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

const speechToolOutputSchema = z
  .object({
    code: z.string().optional(),
    media: z
      .object({
        dataBase64: z.string().optional(),
        kind: z.literal("audio"),
        mimeType: z.string().optional(),
        modelId: z.string(),
        provider: z.string(),
        status: z.literal("generated"),
        uri: z.string().optional(),
      })
      .optional(),
    message: z.string(),
    ok: z.boolean(),
  })
  .strict();

type TextToSpeechInput = z.infer<typeof textToSpeechInputSchema>;
type SpeechToolOutput = z.infer<typeof speechToolOutputSchema>;

export function createSpeechGenerationAgentTools(
  options: SpeechGenerationToolOptions,
): AgentToolDefinition[] {
  return [
    {
      description:
        "Convert text to spoken audio when the user asks to create, read aloud, narrate, or generate speech audio. Use this only for text-to-speech requests.",
      execute: async (input) => textToSpeechTool(input as TextToSpeechInput, options),
      name: "text_to_speech",
      outputSchema: speechToolOutputSchema as z.ZodType<JsonValue>,
      parameters: z.toJSONSchema(textToSpeechInputSchema) as JsonValue,
      schema: textToSpeechInputSchema as z.ZodType<JsonValue>,
      toModelOutput: async ({ output }) => ({
        type: "json",
        value: modelVisibleSpeechToolOutput(speechToolOutputSchema.parse(output)),
      }),
    },
  ];
}

async function textToSpeechTool(
  input: TextToSpeechInput,
  options: SpeechGenerationToolOptions,
): Promise<SpeechToolOutput> {
  if (options.featureSettingsRepository === undefined) {
    return failure(
      "feature_settings_not_configured",
      "Text-to-speech is not configured for this workspace.",
    );
  }
  const workspaceSetting = await options.featureSettingsRepository.findWorkspaceFeatureSetting({
    featureKey: "text_to_speech",
    teamId: options.context.teamId,
  });
  if (workspaceSetting?.enabled !== true) {
    return failure("feature_disabled", "Text-to-speech is disabled for this workspace.");
  }
  const channelAllowed = await options.featureSettingsRepository.isChannelAllowed({
    channelId: options.context.channelId,
    featureKey: "text_to_speech",
    teamId: options.context.teamId,
  });
  if (!channelAllowed) {
    return failure("channel_not_allowed", "Text-to-speech is not enabled for this Slack channel.");
  }

  const selectedTextToSpeechModelId =
    stringPayloadField(workspaceSetting.payload, "text_to_speech_model_id") ??
    options.textToSpeechModelId;
  if (selectedTextToSpeechModelId === undefined) {
    return failure(
      "model_not_configured",
      "Text-to-speech has no selected model for this workspace.",
    );
  }
  const model = options.modelRegistry.get(selectedTextToSpeechModelId);
  options.modelRegistry.assertCapabilities(model, ["text_to_speech"]);
  const credential = await options.credentialResolver?.resolveProviderCredential({
    credentialName: "api_key",
    provider: model.provider,
    workspaceId: options.context.teamId,
  });
  if (credential === undefined) {
    return failure(
      "missing_provider_credential",
      "No active OpenAI API key is configured for text-to-speech in this workspace.",
    );
  }

  const gateway = (options.speechGatewayFactory ?? speechGatewayForModel)(model, credential);
  if (gateway === undefined) {
    return failure(
      "unsupported_speech_provider",
      `Text-to-speech is not supported for provider '${model.provider}'.`,
    );
  }
  const media = await gateway.generateSpeech({
    format: input.format,
    model,
    text: input.text,
    voice: input.voice,
  });
  return {
    media: {
      dataBase64: media.dataBase64,
      kind: "audio",
      mimeType: media.mimeType,
      modelId: model.id,
      provider: model.provider,
      status: "generated",
      uri: media.uri,
    },
    message: "Speech generated.",
    ok: true,
  };
}

function speechGatewayForModel(
  model: ModelInfo,
  credential: { apiKey: string; baseURL?: string },
): SpeechGenerationGateway | undefined {
  return model.provider === "openai" ? new AiSdkSpeechGenerationGateway(credential) : undefined;
}

function failure(code: string, message: string): SpeechToolOutput {
  return {
    code,
    message,
    ok: false,
  };
}

function modelVisibleSpeechToolOutput(output: SpeechToolOutput): JsonValue {
  if (output.media === undefined) {
    return output;
  }
  return {
    ...output,
    media: {
      kind: output.media.kind,
      ...(output.media.mimeType === undefined ? {} : { mimeType: output.media.mimeType }),
      modelId: output.media.modelId,
      provider: output.media.provider,
      status: output.media.status,
    },
  };
}

function stringPayloadField(payload: Record<string, JsonValue>, field: string): string | undefined {
  const value = payload[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
