import { describe, expect, it } from "vite-plus/test";

import { createSlackInstallationMcpTokenResolver } from "../../src/slack/mcpTokenResolver.js";
import type {
  SlackBotRow,
  SlackInstalledWorkspace,
  SlackInstallationLookup,
  SlackInstallationRepository,
  SlackInstallationRow,
} from "../../src/slack/installationStore.js";

describe("createSlackInstallationMcpTokenResolver", () => {
  it("resolves the installing user's Slack MCP token from installation storage", async () => {
    const repository = new RecordingInstallationRepository({
      userScopes: "search:read.public,channels:history",
      userToken: "xoxp-user",
    });
    const resolver = createSlackInstallationMcpTokenResolver(repository);

    await expect(
      resolver.resolve({
        enterpriseId: "E1",
        isEnterpriseInstall: false,
        teamId: "T1",
        userId: "U1",
      }),
    ).resolves.toEqual({
      scopes: ["search:read.public", "channels:history"],
      token: "xoxp-user",
    });
    expect(repository.lookups).toEqual([
      {
        enterpriseId: "E1",
        isEnterpriseInstall: false,
        teamId: "T1",
        userId: "U1",
      },
    ]);
  });

  it("does not fall back to a workspace installation without a user token", async () => {
    const repository = new RecordingInstallationRepository({
      userToken: undefined,
    });
    const resolver = createSlackInstallationMcpTokenResolver(repository);

    await expect(
      resolver.resolve({
        isEnterpriseInstall: false,
        teamId: "T1",
        userId: "U1",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a stored token for a different installation user", async () => {
    const repository = new RecordingInstallationRepository({
      userId: "U2",
      userToken: "xoxp-other-user",
    });
    const resolver = createSlackInstallationMcpTokenResolver(repository);

    await expect(
      resolver.resolve({
        isEnterpriseInstall: false,
        teamId: "T1",
        userId: "U1",
      }),
    ).resolves.toBeUndefined();
  });

  it("preserves team scope for Enterprise Grid token lookups before falling back", async () => {
    const repository = new RecordingInstallationRepository({
      userToken: "xoxp-enterprise-user",
    });
    const resolver = createSlackInstallationMcpTokenResolver(repository);

    await expect(
      resolver.resolve({
        enterpriseId: "E1",
        isEnterpriseInstall: true,
        teamId: "T1",
        userId: "U1",
      }),
    ).resolves.toMatchObject({ token: "xoxp-enterprise-user" });
    expect(repository.lookups).toEqual([
      {
        enterpriseId: "E1",
        isEnterpriseInstall: false,
        teamId: "T1",
        userId: "U1",
      },
    ]);
  });
});

class RecordingInstallationRepository implements SlackInstallationRepository {
  readonly lookups: SlackInstallationLookup[] = [];

  constructor(private readonly installation: Partial<SlackInstallationRow>) {}

  async deleteBot(): Promise<void> {}

  async deleteInstallation(): Promise<void> {}

  async findBot(): Promise<SlackBotRow | undefined> {
    return undefined;
  }

  async findInstallation(
    lookup: SlackInstallationLookup,
  ): Promise<SlackInstallationRow | undefined> {
    this.lookups.push(lookup);
    return {
      appId: "A1",
      botId: undefined,
      botRefreshToken: undefined,
      botScopes: undefined,
      botToken: undefined,
      botTokenExpiresAt: undefined,
      botUserId: undefined,
      enterpriseId: lookup.enterpriseId,
      enterpriseName: undefined,
      enterpriseUrl: undefined,
      incomingWebhookChannel: undefined,
      incomingWebhookChannelId: undefined,
      incomingWebhookConfigurationUrl: undefined,
      incomingWebhookUrl: undefined,
      installedAt: new Date("2026-05-19T00:00:00.000Z"),
      isEnterpriseInstall: lookup.isEnterpriseInstall,
      payload: {},
      teamId: lookup.teamId,
      teamName: undefined,
      tokenType: undefined,
      userId: lookup.userId ?? "U1",
      userRefreshToken: undefined,
      userScopes: undefined,
      userToken: undefined,
      userTokenExpiresAt: undefined,
      ...this.installation,
    };
  }

  async listInstalledWorkspaces(): Promise<SlackInstalledWorkspace[]> {
    return [];
  }

  async saveInstallationBundle(): Promise<void> {}
}
