import { describe, expect, it } from "vite-plus/test";

import { createSpeechGenerationAgentTools } from "../../../src/agents/speechGeneration/tools.js";
import type { ModelInfo } from "../../../src/providers/contracts.js";
import { ModelRegistry } from "../../../src/providers/modelRegistry.js";
import type {
  ChannelFeatureSettingDocument,
  WorkspaceFeatureKey,
  WorkspaceFeatureSettingDocument,
  WorkspaceFeatureSettingsRepository,
} from "../../../src/repositories/workspaceFeatureSettings.js";

describe("createSpeechGenerationAgentTools", () => {
  const model = {
    capabilities: ["text_to_speech"],
    id: "openai:gpt-4o-mini-tts",
    provider: "openai",
    providerModelId: "gpt-4o-mini-tts",
  } satisfies ModelInfo;

  it("fails closed when the workspace feature is disabled", async () => {
    let credentialCalls = 0;
    const tool = createSpeechGenerationAgentTools({
      context: { channelId: "C1", teamId: "T1" },
      credentialResolver: {
        async resolveProviderCredential() {
          credentialCalls += 1;
          return { apiKey: "sk-test" };
        },
      },
      featureSettingsRepository: new MemoryFeatureSettingsRepository({
        allowedChannelIds: ["C1"],
        workspaceEnabled: false,
      }),
      modelRegistry: new ModelRegistry([model]),
      textToSpeechModelId: model.id,
    })[0];

    await expect(tool.execute({ text: "read this" })).resolves.toMatchObject({
      code: "feature_disabled",
      ok: false,
    });
    expect(credentialCalls).toBe(0);
  });

  it("fails closed when the Slack channel is not allowlisted", async () => {
    let credentialCalls = 0;
    const tool = createSpeechGenerationAgentTools({
      context: { channelId: "C2", teamId: "T1" },
      credentialResolver: {
        async resolveProviderCredential() {
          credentialCalls += 1;
          return { apiKey: "sk-test" };
        },
      },
      featureSettingsRepository: new MemoryFeatureSettingsRepository({
        allowedChannelIds: ["C1"],
        workspaceEnabled: true,
      }),
      modelRegistry: new ModelRegistry([model]),
      textToSpeechModelId: model.id,
    })[0];

    await expect(tool.execute({ text: "read this" })).resolves.toMatchObject({
      code: "channel_not_allowed",
      ok: false,
    });
    expect(credentialCalls).toBe(0);
  });

  it("resolves the OpenAI API key before generation", async () => {
    const calls: unknown[] = [];
    const tool = createSpeechGenerationAgentTools({
      context: { channelId: "C1", teamId: "T1" },
      credentialResolver: {
        async resolveProviderCredential(input) {
          calls.push(input);
          return undefined;
        },
      },
      featureSettingsRepository: new MemoryFeatureSettingsRepository({
        allowedChannelIds: ["C1"],
        workspaceEnabled: true,
      }),
      modelRegistry: new ModelRegistry([model]),
      textToSpeechModelId: model.id,
    })[0];

    await expect(tool.execute({ text: "read this" })).resolves.toMatchObject({
      code: "missing_provider_credential",
      ok: false,
    });
    expect(calls).toEqual([
      {
        credentialName: "api_key",
        provider: "openai",
        workspaceId: "T1",
      },
    ]);
  });

  it("fails closed when no text-to-speech model is selected", async () => {
    let credentialCalls = 0;
    const tool = createSpeechGenerationAgentTools({
      context: { channelId: "C1", teamId: "T1" },
      credentialResolver: {
        async resolveProviderCredential() {
          credentialCalls += 1;
          return { apiKey: "sk-test" };
        },
      },
      featureSettingsRepository: new MemoryFeatureSettingsRepository({
        allowedChannelIds: ["C1"],
        workspaceEnabled: true,
      }),
      modelRegistry: new ModelRegistry([model]),
    })[0];

    await expect(tool.execute({ text: "read this" })).resolves.toMatchObject({
      code: "model_not_configured",
      ok: false,
    });
    expect(credentialCalls).toBe(0);
  });

  it("returns generated audio media when the feature and credential are available", async () => {
    const gatewayRequests: unknown[] = [];
    const tool = createSpeechGenerationAgentTools({
      context: { channelId: "C1", teamId: "T1" },
      credentialResolver: {
        async resolveProviderCredential() {
          return { apiKey: "sk-test" };
        },
      },
      featureSettingsRepository: new MemoryFeatureSettingsRepository({
        allowedChannelIds: ["C1"],
        modelId: model.id,
        workspaceEnabled: true,
      }),
      modelRegistry: new ModelRegistry([model]),
      speechGatewayFactory: () => ({
        async generateSpeech(input) {
          gatewayRequests.push(input);
          return {
            dataBase64: "YXVkaW8=",
            mimeType: "audio/mpeg",
          };
        },
      }),
      textToSpeechModelId: model.id,
    })[0];

    await expect(
      tool.execute({ format: "mp3", text: "read this", voice: "alloy" }),
    ).resolves.toMatchObject({
      media: {
        dataBase64: "YXVkaW8=",
        kind: "audio",
        mimeType: "audio/mpeg",
        modelId: model.id,
        provider: "openai",
      },
      ok: true,
    });
    expect(gatewayRequests).toEqual([
      expect.objectContaining({
        format: "mp3",
        model: expect.objectContaining({
          id: model.id,
          provider: model.provider,
          providerModelId: model.providerModelId,
        }),
        text: "read this",
        voice: "alloy",
      }),
    ]);
  });
});

class MemoryFeatureSettingsRepository implements WorkspaceFeatureSettingsRepository {
  constructor(
    private readonly input: {
      allowedChannelIds: string[];
      modelId?: string;
      workspaceEnabled: boolean;
    },
  ) {}

  async findWorkspaceFeatureSetting(input: {
    featureKey: WorkspaceFeatureKey;
    teamId: string;
  }): Promise<WorkspaceFeatureSettingDocument | undefined> {
    return {
      enabled: this.input.workspaceEnabled,
      featureKey: input.featureKey,
      payload:
        this.input.modelId === undefined ? {} : { text_to_speech_model_id: this.input.modelId },
      teamId: input.teamId,
      updatedAt: new Date("2026-05-19T00:00:00Z"),
    };
  }

  async isChannelAllowed(input: {
    channelId: string;
    featureKey: WorkspaceFeatureKey;
    teamId: string;
  }): Promise<boolean> {
    return this.input.allowedChannelIds.includes(input.channelId);
  }

  async listAllowedChannels(input: {
    featureKey: WorkspaceFeatureKey;
    teamId: string;
  }): Promise<ChannelFeatureSettingDocument[]> {
    return this.input.allowedChannelIds.map((channelId) => ({
      channelId,
      featureKey: input.featureKey,
      payload: {},
      teamId: input.teamId,
      updatedAt: new Date("2026-05-19T00:00:00Z"),
    }));
  }

  async replaceAllowedChannels(): Promise<void> {}

  async saveWorkspaceFeatureConfiguration(): Promise<void> {}

  async saveWorkspaceFeatureConfigurations(): Promise<void> {}

  async saveWorkspaceFeatureSetting(): Promise<void> {}
}
