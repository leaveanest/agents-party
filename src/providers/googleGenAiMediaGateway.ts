import { GoogleGenAI } from "@google/genai";

import type { ModelInfo } from "./contracts.js";
import type {
  GeneratedImageAsset,
  GeneratedVideoAsset,
  MediaGenerationGateway,
} from "./mediaGenerationGateway.js";

export class GoogleGenAiMediaGateway implements MediaGenerationGateway {
  private readonly client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async generateImage(input: { model: ModelInfo; prompt: string }): Promise<GeneratedImageAsset> {
    const response = await this.client.models.generateImages({
      config: { numberOfImages: 1 },
      model: input.model.providerModelId,
      prompt: input.prompt,
    });
    const image = response.generatedImages?.[0]?.image;
    if (image?.imageBytes === undefined && image?.gcsUri === undefined) {
      throw new Error("Google image generation did not return an image.");
    }
    return {
      dataBase64: image.imageBytes,
      mimeType: image.mimeType,
      uri: image.gcsUri,
    };
  }

  async generateVideo(input: {
    aspectRatio: "16:9" | "9:16";
    durationSeconds: number;
    model: ModelInfo;
    prompt: string;
  }): Promise<GeneratedVideoAsset> {
    const operation = await this.client.models.generateVideos({
      config: {
        aspectRatio: input.aspectRatio,
        durationSeconds: input.durationSeconds,
        numberOfVideos: 1,
      },
      model: input.model.providerModelId,
      prompt: input.prompt,
    });
    const video = operation.response?.generatedVideos?.[0]?.video;
    return {
      dataBase64: video?.videoBytes,
      mimeType: video?.mimeType,
      operationName: operation.name,
      status: operation.done === true ? "generated" : "in_progress",
      uri: video?.uri,
    };
  }
}
