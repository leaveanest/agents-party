import { createOpenAI } from "@ai-sdk/openai";
import { experimental_generateSpeech as generateSpeech, type SpeechModel } from "ai";

import type { ModelInfo } from "./contracts.js";
import type { ProviderCredential } from "./credentials.js";

export type SpeechGenerationRequest = {
  format?: "mp3" | "wav";
  model: ModelInfo;
  text: string;
  voice?: string;
};

export type GeneratedSpeechAsset = {
  dataBase64?: string;
  mimeType?: string;
  uri?: string;
};

export type SpeechGenerationGateway = {
  generateSpeech(request: SpeechGenerationRequest): Promise<GeneratedSpeechAsset>;
};

export class UnsupportedSpeechGenerationProviderError extends Error {
  constructor(readonly model: ModelInfo) {
    super(`Speech generation provider '${model.provider}' is not supported.`);
    this.name = "UnsupportedSpeechGenerationProviderError";
  }
}

export type GenerateSpeechFunction = typeof generateSpeech;

export class AiSdkSpeechGenerationGateway implements SpeechGenerationGateway {
  constructor(
    private readonly credential: ProviderCredential,
    private readonly generateSpeechFn: GenerateSpeechFunction = generateSpeech,
  ) {}

  async generateSpeech(request: SpeechGenerationRequest): Promise<GeneratedSpeechAsset> {
    const model = aiSdkSpeechModel(request.model, this.credential);
    const result = await this.generateSpeechFn({
      model,
      outputFormat: request.format ?? "mp3",
      text: request.text,
      voice: request.voice ?? defaultVoiceForProvider(request.model),
    });
    return {
      dataBase64: result.audio.base64,
      mimeType: result.audio.mediaType,
    };
  }
}

function aiSdkSpeechModel(model: ModelInfo, credential: ProviderCredential): SpeechModel {
  switch (model.provider) {
    case "openai":
      return createOpenAI({
        apiKey: credential.apiKey,
        baseURL: credential.baseURL,
      }).speech(model.providerModelId);
    default:
      throw new UnsupportedSpeechGenerationProviderError(model);
  }
}

function defaultVoiceForProvider(model: ModelInfo): string | undefined {
  return model.provider === "openai" ? "alloy" : undefined;
}
