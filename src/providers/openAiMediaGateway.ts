import { createOpenAI } from "@ai-sdk/openai";
import { generateImage, type ImageModel } from "ai";

import type { ModelInfo } from "./contracts.js";
import type { ProviderCredential } from "./credentials.js";
import type {
  GeneratedImageAsset,
  GeneratedVideoAsset,
  MediaGenerationGateway,
} from "./mediaGenerationGateway.js";

export type GenerateImageFunction = typeof generateImage;

export class UnsupportedOpenAiMediaGenerationError extends Error {
  constructor(readonly capability: "video_generation") {
    super(`OpenAI media gateway does not support ${capability}.`);
    this.name = "UnsupportedOpenAiMediaGenerationError";
  }
}

export class OpenAiMediaGateway implements MediaGenerationGateway {
  constructor(
    private readonly credential: ProviderCredential,
    private readonly generateImageFn: GenerateImageFunction = generateImage,
  ) {}

  async generateImage(input: { model: ModelInfo; prompt: string }): Promise<GeneratedImageAsset> {
    const provider = createOpenAI({
      apiKey: this.credential.apiKey,
      baseURL: this.credential.baseURL,
    });
    const result = await this.generateImageFn({
      model: provider.image(input.model.providerModelId) as ImageModel,
      prompt: input.prompt,
      providerOptions: {
        openai: { quality: "high" },
      },
      size: "1024x1024",
    });
    const image = result.image;
    return {
      dataBase64: image.base64,
      mimeType: image.mediaType,
    };
  }

  async generateVideo(): Promise<GeneratedVideoAsset> {
    throw new UnsupportedOpenAiMediaGenerationError("video_generation");
  }
}
