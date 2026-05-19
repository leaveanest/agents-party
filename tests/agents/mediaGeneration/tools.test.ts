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
});

class MemoryFeatureSettingsRepository implements WorkspaceFeatureSettingsRepository {
  constructor(private readonly input: { allowedChannelIds: string[]; workspaceEnabled: boolean }) {}

  async findWorkspaceFeatureSetting(input: {
    featureKey: WorkspaceFeatureKey;
    teamId: string;
  }): Promise<WorkspaceFeatureSettingDocument | undefined> {
    return {
      enabled: this.input.workspaceEnabled,
      featureKey: input.featureKey,
      payload: {},
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

  async saveWorkspaceFeatureSetting(): Promise<void> {}
}
