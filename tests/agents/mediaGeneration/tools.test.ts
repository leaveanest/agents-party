import { describe, expect, it } from "vite-plus/test";

import { createMediaGenerationAgentTools } from "../../../src/agents/mediaGeneration/tools.js";
import type { ModelInfo } from "../../../src/providers/contracts.js";
import { ModelRegistry } from "../../../src/providers/modelRegistry.js";
import type {
  ChannelFeatureSettingDocument,
  WorkspaceFeatureKey,
  WorkspaceFeatureSettingDocument,
  WorkspaceFeatureSettingsRepository,
} from "../../../src/repositories/workspaceFeatureSettings.js";

describe("createMediaGenerationAgentTools", () => {
  const model = {
    capabilities: ["image_generation"],
    id: "openai:gpt-image-test",
    provider: "openai",
    providerModelId: "gpt-image-test",
  } satisfies ModelInfo;

  it("fails closed when the workspace feature is disabled", async () => {
    let credentialCalls = 0;
    const tool = createMediaGenerationAgentTools({
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
      imageGenerationModelId: model.id,
      modelRegistry: new ModelRegistry([model]),
    })[0];

    await expect(tool.execute({ prompt: "draw a diagram" })).resolves.toMatchObject({
      code: "feature_disabled",
      ok: false,
    });
    expect(credentialCalls).toBe(0);
  });

  it("fails closed when the Slack channel is not allowlisted", async () => {
    let credentialCalls = 0;
    const tool = createMediaGenerationAgentTools({
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
      imageGenerationModelId: model.id,
      modelRegistry: new ModelRegistry([model]),
    })[0];

    await expect(tool.execute({ prompt: "draw a diagram" })).resolves.toMatchObject({
      code: "channel_not_allowed",
      ok: false,
    });
    expect(credentialCalls).toBe(0);
  });

  it("fails closed for Slack direct messages unless direct messages are explicitly enabled", async () => {
    let credentialCalls = 0;
    const tool = createMediaGenerationAgentTools({
      context: { channelId: "D1", teamId: "T1" },
      credentialResolver: {
        async resolveProviderCredential() {
          credentialCalls += 1;
          return { apiKey: "sk-test" };
        },
      },
      featureSettingsRepository: new MemoryFeatureSettingsRepository({
        allowedChannelIds: [],
        workspaceEnabled: true,
      }),
      imageGenerationModelId: model.id,
      modelRegistry: new ModelRegistry([model]),
    })[0];

    await expect(tool.execute({ prompt: "draw a diagram" })).resolves.toMatchObject({
      code: "channel_not_allowed",
      ok: false,
    });
    expect(credentialCalls).toBe(0);
  });

  it("allows Slack direct messages when direct messages are explicitly enabled", async () => {
    const credentialCalls: unknown[] = [];
    const generatedPrompts: unknown[] = [];
    const tool = createMediaGenerationAgentTools({
      context: { channelId: "D1", teamId: "T1" },
      credentialResolver: {
        async resolveProviderCredential(input) {
          credentialCalls.push(input);
          return { apiKey: "sk-test" };
        },
      },
      featureSettingsRepository: new MemoryFeatureSettingsRepository({
        allowedChannelIds: [],
        allowDirectMessages: true,
        workspaceEnabled: true,
      }),
      imageGenerationModelId: model.id,
      mediaGatewayFactory: () => ({
        async generateImage(input) {
          generatedPrompts.push(input.prompt);
          return { dataBase64: "ZmFrZQ==", mimeType: "image/png" };
        },
      }),
      modelRegistry: new ModelRegistry([model]),
    })[0];

    await expect(tool.execute({ prompt: "draw a dog" })).resolves.toMatchObject({
      media: {
        mimeType: "image/png",
        modelId: model.id,
      },
      ok: true,
    });
    expect(credentialCalls).toEqual([
      {
        credentialName: "api_key",
        provider: "openai",
        workspaceId: "T1",
      },
    ]);
    expect(generatedPrompts).toEqual(["draw a dog"]);
  });

  it("notifies when image generation is about to start", async () => {
    const notifications: unknown[] = [];
    const operations: string[] = [];
    const tool = createMediaGenerationAgentTools({
      context: { channelId: "C1", teamId: "T1" },
      credentialResolver: {
        async resolveProviderCredential() {
          return { apiKey: "sk-test" };
        },
      },
      featureSettingsRepository: new MemoryFeatureSettingsRepository({
        allowedChannelIds: ["C1"],
        workspaceEnabled: true,
      }),
      imageGenerationModelId: model.id,
      mediaGatewayFactory: () => ({
        async generateImage() {
          operations.push("generate");
          return { dataBase64: "ZmFrZQ==", mimeType: "image/png" };
        },
      }),
      modelRegistry: new ModelRegistry([model]),
      onGenerationStart: async (input) => {
        operations.push("notify");
        notifications.push(input);
      },
    })[0];

    await expect(tool.execute({ prompt: "draw a diagram" })).resolves.toMatchObject({
      ok: true,
    });
    expect(operations).toEqual(["notify", "generate"]);
    expect(notifications).toEqual([
      {
        channelId: "C1",
        modelId: model.id,
        prompt: "draw a diagram",
        provider: "openai",
        teamId: "T1",
      },
    ]);
  });

  it("keeps generated image bytes out of the model-visible tool output", async () => {
    const tool = createMediaGenerationAgentTools({
      context: { channelId: "C1", teamId: "T1" },
      credentialResolver: {
        async resolveProviderCredential() {
          return { apiKey: "sk-test" };
        },
      },
      featureSettingsRepository: new MemoryFeatureSettingsRepository({
        allowedChannelIds: ["C1"],
        workspaceEnabled: true,
      }),
      imageGenerationModelId: model.id,
      mediaGatewayFactory: () => ({
        async generateImage() {
          return { dataBase64: "ZmFrZQ==", mimeType: "image/png", uri: "https://example.test/x" };
        },
      }),
      modelRegistry: new ModelRegistry([model]),
    })[0];

    const output = await tool.execute({ prompt: "draw a diagram" });

    await expect(
      tool.toModelOutput?.({
        input: { prompt: "draw a diagram" },
        output,
        toolCallId: "call-1",
      }),
    ).resolves.toEqual({
      type: "json",
      value: {
        media: {
          kind: "image",
          mimeType: "image/png",
          modelId: model.id,
          provider: "openai",
          status: "generated",
        },
        message: "Image generated.",
        ok: true,
      },
    });
    expect(JSON.stringify(output)).toContain("ZmFrZQ==");
  });

  it("uses the Assistant source channel allowlist before direct message settings", async () => {
    let credentialCalls = 0;
    const tool = createMediaGenerationAgentTools({
      context: { channelId: "D1", teamId: "T1", viewerContextChannelIds: ["C1", "D1"] },
      credentialResolver: {
        async resolveProviderCredential() {
          credentialCalls += 1;
          return { apiKey: "sk-test" };
        },
      },
      featureSettingsRepository: new MemoryFeatureSettingsRepository({
        allowedChannelIds: ["C2"],
        allowDirectMessages: true,
        workspaceEnabled: true,
      }),
      imageGenerationModelId: model.id,
      modelRegistry: new ModelRegistry([model]),
    })[0];

    await expect(tool.execute({ prompt: "draw a diagram" })).resolves.toMatchObject({
      code: "channel_not_allowed",
      ok: false,
    });
    expect(credentialCalls).toBe(0);
  });

  it("allows Assistant direct message requests when the source channel is allowlisted", async () => {
    const credentialCalls: unknown[] = [];
    const generatedPrompts: unknown[] = [];
    const tool = createMediaGenerationAgentTools({
      context: { channelId: "D1", teamId: "T1", viewerContextChannelIds: ["C1", "D1"] },
      credentialResolver: {
        async resolveProviderCredential(input) {
          credentialCalls.push(input);
          return { apiKey: "sk-test" };
        },
      },
      featureSettingsRepository: new MemoryFeatureSettingsRepository({
        allowedChannelIds: ["C1"],
        allowDirectMessages: false,
        workspaceEnabled: true,
      }),
      imageGenerationModelId: model.id,
      mediaGatewayFactory: () => ({
        async generateImage(input) {
          generatedPrompts.push(input.prompt);
          return { dataBase64: "ZmFrZQ==", mimeType: "image/png" };
        },
      }),
      modelRegistry: new ModelRegistry([model]),
    })[0];

    await expect(tool.execute({ prompt: "draw a diagram" })).resolves.toMatchObject({
      ok: true,
    });
    expect(credentialCalls).toEqual([
      {
        credentialName: "api_key",
        provider: "openai",
        workspaceId: "T1",
      },
    ]);
    expect(generatedPrompts).toEqual(["draw a diagram"]);
  });

  it("resolves the configured provider API key before generation", async () => {
    const calls: unknown[] = [];
    const tool = createMediaGenerationAgentTools({
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
      imageGenerationModelId: model.id,
      modelRegistry: new ModelRegistry([model]),
    })[0];

    await expect(tool.execute({ prompt: "draw a diagram" })).resolves.toMatchObject({
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

  it("falls back to another supported image provider when the configured provider key is missing", async () => {
    const googleModel = {
      capabilities: ["image_generation"],
      id: "google:image-test",
      provider: "google",
      providerModelId: "image-test",
    } satisfies ModelInfo;
    const credentialCalls: unknown[] = [];
    const tool = createMediaGenerationAgentTools({
      context: { channelId: "C1", teamId: "T1" },
      credentialResolver: {
        async resolveProviderCredential(input) {
          credentialCalls.push(input);
          return input.provider === "openai" ? { apiKey: "sk-test" } : undefined;
        },
      },
      featureSettingsRepository: new MemoryFeatureSettingsRepository({
        allowedChannelIds: ["C1"],
        workspaceEnabled: true,
      }),
      imageGenerationFallbackModelIds: [model.id],
      imageGenerationModelId: googleModel.id,
      mediaGatewayFactory: (selectedModel) => ({
        async generateImage(input) {
          return {
            dataBase64: "ZmFrZQ==",
            mimeType: selectedModel.provider === input.model.provider ? "image/png" : undefined,
          };
        },
      }),
      modelRegistry: new ModelRegistry([googleModel, model]),
    })[0];

    await expect(tool.execute({ prompt: "draw a diagram" })).resolves.toMatchObject({
      media: {
        mimeType: "image/png",
        modelId: model.id,
        provider: "openai",
      },
      ok: true,
    });
    expect(credentialCalls).toEqual([
      {
        credentialName: "api_key",
        provider: "google",
        workspaceId: "T1",
      },
      {
        credentialName: "api_key",
        provider: "openai",
        workspaceId: "T1",
      },
    ]);
  });
});

class MemoryFeatureSettingsRepository implements WorkspaceFeatureSettingsRepository {
  constructor(
    private readonly input: {
      allowedChannelIds: string[];
      allowDirectMessages?: boolean;
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
      payload: { allow_direct_messages: this.input.allowDirectMessages ?? false },
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
