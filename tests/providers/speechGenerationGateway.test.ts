import { describe, expect, it } from "vite-plus/test";

import type { ModelInfo } from "../../src/providers/contracts.js";
import {
  AiSdkSpeechGenerationGateway,
  UnsupportedSpeechGenerationProviderError,
  type GenerateSpeechFunction,
} from "../../src/providers/speechGenerationGateway.js";

describe("AiSdkSpeechGenerationGateway", () => {
  const openAiModel = {
    capabilities: ["text_to_speech"],
    id: "openai:gpt-4o-mini-tts",
    provider: "openai",
    providerModelId: "gpt-4o-mini-tts",
  } satisfies ModelInfo;

  it("maps AI SDK generated speech audio into a generated asset", async () => {
    const calls: unknown[] = [];
    const generateSpeechFn: GenerateSpeechFunction = async (input) => {
      calls.push(input);
      return {
        audio: {
          base64: "YXVkaW8=",
          mediaType: "audio/mpeg",
        },
      } as Awaited<ReturnType<GenerateSpeechFunction>>;
    };
    const gateway = new AiSdkSpeechGenerationGateway({ apiKey: "sk-test" }, generateSpeechFn);

    await expect(
      gateway.generateSpeech({
        format: "mp3",
        model: openAiModel,
        text: "read this",
      }),
    ).resolves.toEqual({
      dataBase64: "YXVkaW8=",
      mimeType: "audio/mpeg",
    });
    expect(calls).toEqual([
      expect.objectContaining({
        outputFormat: "mp3",
        text: "read this",
        voice: "alloy",
      }),
    ]);
  });

  it("rejects unsupported speech providers before calling AI SDK", async () => {
    let calls = 0;
    const generateSpeechFn: GenerateSpeechFunction = async () => {
      calls += 1;
      throw new Error("Unexpected generateSpeech call.");
    };
    const gateway = new AiSdkSpeechGenerationGateway({ apiKey: "key" }, generateSpeechFn);

    await expect(
      gateway.generateSpeech({
        model: {
          capabilities: ["text_to_speech"],
          id: "google:tts-test",
          provider: "google",
          providerModelId: "tts-test",
        },
        text: "read this",
      }),
    ).rejects.toBeInstanceOf(UnsupportedSpeechGenerationProviderError);
    expect(calls).toBe(0);
  });
});
