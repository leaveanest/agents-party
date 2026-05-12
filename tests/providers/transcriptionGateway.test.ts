import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import {
  GoogleSpeechToTextTranscriptionGateway,
  TranscriptionProviderError,
  WorkspaceCredentialTranscriptionGateway,
  UnsupportedTranscriptionMediaTypeError,
  type AiSdkTranscribeFunction,
} from "../../src/providers/transcriptionGateway.js";
import type { ModelInfo } from "../../src/providers/contracts.js";

const model: ModelInfo = {
  capabilities: ["transcription"],
  id: "google:speech-to-text-latest-long",
  provider: "google",
  providerModelId: "latest_long",
};
const openAiTranscriptionModel: ModelInfo = {
  capabilities: ["transcription"],
  id: "openai:gpt-4o-mini-transcribe",
  provider: "openai",
  providerModelId: "gpt-4o-mini-transcribe",
};

describe("GoogleSpeechToTextTranscriptionGateway", () => {
  it("maps audio bytes to Google Speech-to-Text recognize requests with bearer auth", async () => {
    const calls: Array<{ body: unknown; headers: unknown; url: string }> = [];
    const gateway = new GoogleSpeechToTextTranscriptionGateway({
      alternativeLanguageCodes: ["en-US"],
      credential: { apiKey: "google-access-token" },
      fetchFn: async (url, init) => {
        calls.push({
          body: JSON.parse(String(init?.body)),
          headers: init?.headers,
          url: String(url),
        });
        return Response.json({
          results: [{ alternatives: [{ transcript: "こんにちは" }] }],
        });
      },
      languageCode: "ja-JP",
      model,
    });

    const result = await gateway.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      context: { workspaceId: "T1" },
      filename: "voice.mp3",
      mediaType: "audio/mpeg",
    });

    expect(result).toEqual({
      model: "google:speech-to-text-latest-long",
      provider: "google",
      text: "こんにちは",
    });
    expect(calls).toEqual([
      {
        body: {
          audio: { content: Buffer.from([1, 2, 3]).toString("base64") },
          config: {
            alternativeLanguageCodes: ["en-US"],
            enableAutomaticPunctuation: true,
            encoding: "MP3",
            languageCode: "ja-JP",
            model: "latest_long",
          },
        },
        headers: {
          authorization: "Bearer google-access-token",
          "content-type": "application/json",
        },
        url: "https://speech.googleapis.com/v1p1beta1/speech:recognize",
      },
    ]);
  });

  it("exchanges Google service account credentials from the DB before transcription", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const serviceAccountJson = JSON.stringify({
      client_email: "speech@example.iam.gserviceaccount.com",
      private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
      token_uri: "https://oauth2.googleapis.com/token",
    });
    const calls: Array<{ body: string; headers: unknown; url: string }> = [];
    const gateway = new GoogleSpeechToTextTranscriptionGateway({
      credential: { apiKey: serviceAccountJson },
      fetchFn: async (url, init) => {
        calls.push({
          body: String(init?.body),
          headers: init?.headers,
          url: String(url),
        });
        if (String(url) === "https://oauth2.googleapis.com/token") {
          return Response.json({ access_token: "minted-token" });
        }
        return Response.json({
          results: [{ alternatives: [{ transcript: "service account transcript" }] }],
        });
      },
      languageCode: "ja-JP",
      model,
    });

    await expect(
      gateway.transcribe({
        audio: new Uint8Array([1]),
        context: { workspaceId: "T1" },
        mediaType: "audio/mpeg",
      }),
    ).resolves.toMatchObject({
      text: "service account transcript",
    });
    expect(calls[0]).toMatchObject({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      url: "https://oauth2.googleapis.com/token",
    });
    expect(calls[0]?.body).toContain(
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer",
    );
    expect(calls[0]?.body).toContain("assertion=");
    expect(calls[1]).toMatchObject({
      headers: {
        authorization: "Bearer minted-token",
        "content-type": "application/json",
      },
      url: "https://speech.googleapis.com/v1p1beta1/speech:recognize",
    });
  });

  it("rejects unsupported audio media types before provider calls", async () => {
    const gateway = new GoogleSpeechToTextTranscriptionGateway({
      credential: { apiKey: "google-key" },
      fetchFn: async () => {
        throw new Error("Unexpected fetch.");
      },
      languageCode: "ja-JP",
      model,
    });

    await expect(
      gateway.transcribe({
        audio: new Uint8Array([1]),
        context: { workspaceId: "T1" },
        mediaType: "audio/mp4",
      }),
    ).rejects.toBeInstanceOf(UnsupportedTranscriptionMediaTypeError);
  });

  it("maps provider failures without exposing request content", async () => {
    const gateway = new GoogleSpeechToTextTranscriptionGateway({
      credential: { apiKey: "google-key" },
      fetchFn: async () => new Response("bad", { status: 503 }),
      languageCode: "ja-JP",
      model,
    });

    await expect(
      gateway.transcribe({
        audio: new Uint8Array([1]),
        context: { workspaceId: "T1" },
        mediaType: "audio/mpeg",
      }),
    ).rejects.toMatchObject({
      modelId: "google:speech-to-text-latest-long",
      name: "TranscriptionProviderError",
      provider: "google",
      status: 503,
    } satisfies Partial<TranscriptionProviderError>);
  });

  it("maps transport failures without exposing credential-bearing URLs", async () => {
    const gateway = new GoogleSpeechToTextTranscriptionGateway({
      credential: { apiKey: "google-access-token" },
      fetchFn: async () => {
        throw new Error("https://speech.googleapis.com/v1p1beta1/speech:recognize");
      },
      languageCode: "ja-JP",
      model,
    });

    await expect(
      gateway.transcribe({
        audio: new Uint8Array([1]),
        context: { workspaceId: "T1" },
        mediaType: "audio/mpeg",
      }),
    ).rejects.toMatchObject({
      message: "Google Speech-to-Text request failed.",
      modelId: "google:speech-to-text-latest-long",
      provider: "google",
    } satisfies Partial<TranscriptionProviderError>);
  });

  it("uses provider-specific DB credential names for transcription providers", async () => {
    const lookups: unknown[] = [];
    const transcribeFn: AiSdkTranscribeFunction = async () =>
      ({
        durationInSeconds: undefined,
        language: undefined,
        providerMetadata: {},
        responses: [],
        segments: [],
        text: "openai transcript",
        warnings: [],
      }) as Awaited<ReturnType<AiSdkTranscribeFunction>>;
    const gateway = new WorkspaceCredentialTranscriptionGateway({
      credentialResolver: {
        async resolveProviderCredential(input) {
          lookups.push(input);
          return { apiKey: "openai-key" };
        },
      },
      languageCode: "ja-JP",
      model: openAiTranscriptionModel,
      transcribeFn,
    });

    await expect(
      gateway.transcribe({
        audio: new Uint8Array([1]),
        context: { workspaceId: "T1" },
        mediaType: "audio/mpeg",
      }),
    ).resolves.toMatchObject({
      provider: "openai",
      text: "openai transcript",
    });
    expect(lookups).toEqual([
      {
        credentialName: "api_key",
        provider: "openai",
        workspaceId: "T1",
      },
    ]);
  });
});
