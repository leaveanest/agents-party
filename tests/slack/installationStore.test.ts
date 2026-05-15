import { describe, expect, it } from "vite-plus/test";

import {
  RepositorySlackInstallationStore,
  type SlackBotRow,
  type SlackInstallationLookup,
  type SlackInstallationRepository,
  type SlackInstallationRow,
} from "../../src/slack/installationStore.js";

class InMemorySlackInstallationRepository implements SlackInstallationRepository {
  readonly bots: SlackBotRow[] = [];
  readonly installations: SlackInstallationRow[] = [];

  async saveInstallationBundle(
    installation: SlackInstallationRow,
    bot: SlackBotRow | undefined,
  ): Promise<void> {
    this.installations.push(installation);
    if (bot !== undefined) {
      this.bots.push(bot);
    }
  }

  async findInstallation(
    lookup: SlackInstallationLookup,
  ): Promise<SlackInstallationRow | undefined> {
    return newest(
      this.installations.filter(
        (row) =>
          row.enterpriseId === lookup.enterpriseId &&
          row.teamId === lookup.teamId &&
          (lookup.userId === undefined || row.userId === lookup.userId),
      ),
    );
  }

  async findBot(lookup: SlackInstallationLookup): Promise<SlackBotRow | undefined> {
    return newest(
      this.bots.filter(
        (row) => row.enterpriseId === lookup.enterpriseId && row.teamId === lookup.teamId,
      ),
    );
  }

  async listInstalledWorkspaces(input: { enterpriseId?: string }) {
    const latestByTeam = new Map<string, SlackBotRow>();
    for (const bot of this.bots) {
      if (bot.teamId === undefined || bot.botToken === undefined) {
        continue;
      }
      if (bot.enterpriseId !== input.enterpriseId) {
        continue;
      }
      const current = latestByTeam.get(bot.teamId);
      if (current === undefined || current.installedAt < bot.installedAt) {
        latestByTeam.set(bot.teamId, bot);
      }
    }
    return [...latestByTeam.values()].map((bot) => ({
      enterpriseId: bot.enterpriseId,
      installedAt: bot.installedAt,
      teamId: bot.teamId ?? "",
      teamName: bot.teamName,
    }));
  }

  async deleteInstallation(lookup: SlackInstallationLookup): Promise<void> {
    this.installations.splice(
      0,
      this.installations.length,
      ...this.installations.filter(
        (row) =>
          row.enterpriseId !== lookup.enterpriseId ||
          row.teamId !== lookup.teamId ||
          (lookup.userId !== undefined && row.userId !== lookup.userId),
      ),
    );
  }

  async deleteBot(lookup: SlackInstallationLookup): Promise<void> {
    this.bots.splice(
      0,
      this.bots.length,
      ...this.bots.filter(
        (row) => row.enterpriseId !== lookup.enterpriseId || row.teamId !== lookup.teamId,
      ),
    );
  }
}

describe("RepositorySlackInstallationStore", () => {
  it("stores and fetches Slack OAuth installations", async () => {
    const repository = new InMemorySlackInstallationRepository();
    const store = new RepositorySlackInstallationStore(repository);

    await store.storeInstallation({
      appId: "A111",
      authVersion: "v2",
      enterprise: undefined,
      bot: {
        id: "B111",
        scopes: ["chat:write"],
        token: "xoxb-token",
        userId: "UBOT",
      },
      isEnterpriseInstall: false,
      team: { id: "T111", name: "Workspace" },
      tokenType: "bot",
      user: {
        id: "U111",
        scopes: ["channels:history"],
        token: "xoxp-token",
      },
    });

    const installation = await store.fetchInstallation({
      enterpriseId: undefined,
      isEnterpriseInstall: false,
      teamId: "T111",
      userId: "U111",
    });

    expect(installation.team?.id).toBe("T111");
    expect(installation.user.id).toBe("U111");
    expect(installation.bot?.token).toBe("xoxb-token");
    expect(repository.installations).toHaveLength(1);
    expect(repository.bots).toHaveLength(1);
  });

  it("rehydrates user installations with the latest bot credentials", async () => {
    const repository = new InMemorySlackInstallationRepository();
    const store = new RepositorySlackInstallationStore(repository);

    await store.storeInstallation({
      appId: "A111",
      authVersion: "v2",
      enterprise: undefined,
      bot: {
        id: "B111",
        scopes: ["chat:write"],
        token: "xoxb-token",
        userId: "UBOT",
      },
      isEnterpriseInstall: false,
      team: { id: "T111" },
      tokenType: "bot",
      user: { id: "U111", scopes: ["channels:history"], token: "xoxp-U111" },
    });
    await store.storeInstallation({
      appId: "A111",
      authVersion: "v2",
      enterprise: undefined,
      isEnterpriseInstall: false,
      team: { id: "T111" },
      user: { id: "U222", scopes: ["channels:history"], token: "xoxp-U222" },
    });

    const installation = await store.fetchInstallation({
      enterpriseId: undefined,
      isEnterpriseInstall: false,
      teamId: "T111",
      userId: "U222",
    });

    expect(installation.user.id).toBe("U222");
    expect(installation.bot?.id).toBe("B111");
    expect(installation.bot?.token).toBe("xoxb-token");
  });

  it("deletes user installation rows without deleting workspace bot rows", async () => {
    const repository = new InMemorySlackInstallationRepository();
    const store = new RepositorySlackInstallationStore(repository);

    await store.storeInstallation({
      appId: "A111",
      authVersion: "v2",
      enterprise: undefined,
      bot: {
        id: "B111",
        scopes: ["chat:write"],
        token: "xoxb-token",
        userId: "UBOT",
      },
      isEnterpriseInstall: false,
      team: { id: "T111" },
      tokenType: "bot",
      user: { id: "U111", scopes: ["channels:history"], token: "xoxp-U111" },
    });

    await store.deleteInstallation({
      enterpriseId: undefined,
      isEnterpriseInstall: false,
      teamId: "T111",
      userId: "U111",
    });

    await expect(
      store.fetchInstallation({
        enterpriseId: undefined,
        isEnterpriseInstall: false,
        teamId: "T111",
        userId: "U111",
      }),
    ).rejects.toThrow("Slack installation not found");
    expect(repository.bots).toHaveLength(1);
  });

  it("deletes workspace bot rows when deletion is not user-specific", async () => {
    const repository = new InMemorySlackInstallationRepository();
    const store = new RepositorySlackInstallationStore(repository);

    await store.storeInstallation({
      appId: "A111",
      authVersion: "v2",
      bot: {
        id: "B111",
        scopes: ["chat:write"],
        token: "xoxb-token",
        userId: "UBOT",
      },
      enterprise: undefined,
      isEnterpriseInstall: false,
      team: { id: "T111" },
      tokenType: "bot",
      user: { id: "U111", scopes: ["channels:history"], token: "xoxp-U111" },
    });

    await store.deleteInstallation({
      enterpriseId: undefined,
      isEnterpriseInstall: false,
      teamId: "T111",
    });

    expect(repository.installations).toHaveLength(0);
    expect(repository.bots).toHaveLength(0);
  });
});

function newest<TRow extends { installedAt: Date }>(rows: TRow[]): TRow | undefined {
  return rows.sort((left, right) => right.installedAt.getTime() - left.installedAt.getTime())[0];
}
