import type { ModelInfo } from "./contracts.js";

export type GeneratedImageAsset = {
  dataBase64?: string;
  mimeType?: string;
  uri?: string;
};

export type GeneratedVideoAsset = {
  dataBase64?: string;
  mimeType?: string;
  operationName?: string;
  status: "generated" | "in_progress";
  uri?: string;
};

export type MediaGenerationGateway = {
  generateImage(input: { model: ModelInfo; prompt: string }): Promise<GeneratedImageAsset>;
  generateVideo(input: {
    aspectRatio: "16:9" | "9:16";
    durationSeconds: number;
    model: ModelInfo;
    prompt: string;
  }): Promise<GeneratedVideoAsset>;
};
