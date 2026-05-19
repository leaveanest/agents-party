import { describe, expect, it } from "vite-plus/test";

import { PostgresSlackInstallationRepository } from "../../../src/infrastructure/postgres/slackInstallationRepository.js";

describe("PostgresSlackInstallationRepository", () => {
  it("finds workspace installations by team when Slack events omit enterprise id", async () => {
    const pool = new RecordingPool([
      {
        ...installationRecord(),
        enterprise_id: "E1",
        team_id: "T1",
      },
    ]);
    const repository = new PostgresSlackInstallationRepository("C1", { pool: pool as never });

    await expect(
      repository.findInstallation({
        enterpriseId: undefined,
        isEnterpriseInstall: false,
        teamId: "T1",
      }),
    ).resolves.toMatchObject({
      enterpriseId: "E1",
      teamId: "T1",
      userId: "U1",
    });

    expect(pool.queries[0]?.text).toContain(
      "and ($2::text is null or enterprise_id is not distinct from $2)",
    );
    expect(pool.queries[0]?.values).toEqual(["C1", undefined, "T1", undefined]);
  });

  it("falls back to the workspace installation when an event user did not install the app", async () => {
    const pool = new QueuedRecordingPool([
      [],
      [
        {
          ...installationRecord(),
          enterprise_id: "E1",
          team_id: "T1",
          user_id: "UINSTALLER",
        },
      ],
    ]);
    const repository = new PostgresSlackInstallationRepository("C1", { pool: pool as never });

    await expect(
      repository.findInstallation({
        enterpriseId: undefined,
        isEnterpriseInstall: false,
        teamId: "T1",
        userId: "UREACTOR",
      }),
    ).resolves.toMatchObject({
      teamId: "T1",
      userId: "UINSTALLER",
    });

    expect(pool.queries.map((query) => query.values)).toEqual([
      ["C1", undefined, "T1", "UREACTOR"],
      ["C1", undefined, "T1", undefined],
    ]);
  });

  it("finds workspace bots by team when Slack events omit enterprise id", async () => {
    const pool = new RecordingPool([
      {
        ...botRecord(),
        enterprise_id: "E1",
        team_id: "T1",
      },
    ]);
    const repository = new PostgresSlackInstallationRepository("C1", { pool: pool as never });

    await expect(
      repository.findBot({
        enterpriseId: undefined,
        isEnterpriseInstall: false,
        teamId: "T1",
      }),
    ).resolves.toMatchObject({
      botId: "B1",
      enterpriseId: "E1",
      teamId: "T1",
    });

    expect(pool.queries[0]?.text).toContain(
      "and ($2::text is null or enterprise_id is not distinct from $2)",
    );
    expect(pool.queries[0]?.values).toEqual(["C1", undefined, "T1"]);
  });

  it("does not run broad installation lookups without enterprise or team scope", async () => {
    const pool = new RecordingPool([installationRecord()]);
    const repository = new PostgresSlackInstallationRepository("C1", { pool: pool as never });

    await expect(
      repository.findInstallation({
        enterpriseId: undefined,
        isEnterpriseInstall: false,
        teamId: undefined,
      }),
    ).resolves.toBeUndefined();
    await expect(
      repository.findBot({
        enterpriseId: undefined,
        isEnterpriseInstall: false,
        teamId: undefined,
      }),
    ).resolves.toBeUndefined();

    expect(pool.queries).toEqual([]);
  });

  it("lists installed workspaces from latest bot rows with installation name fallback", async () => {
    const pool = new RecordingPool([
      {
        enterprise_id: "E1",
        installed_at: new Date("2026-05-15T00:00:00Z"),
        team_id: "T1",
        team_name: "Workspace One",
      },
    ]);
    const repository = new PostgresSlackInstallationRepository("C1", { pool: pool as never });

    await expect(repository.listInstalledWorkspaces({ enterpriseId: "E1" })).resolves.toEqual([
      {
        enterpriseId: "E1",
        installedAt: new Date("2026-05-15T00:00:00Z"),
        teamId: "T1",
        teamName: "Workspace One",
      },
    ]);

    expect(pool.queries[0]?.text).toContain("from slack_bots");
    expect(pool.queries[0]?.text).toContain("left join latest_names");
    expect(pool.queries[0]?.values).toEqual(["C1", "E1"]);
  });
});

function installationRecord(): Record<string, unknown> {
  return {
    app_id: "A1",
    bot_id: "B1",
    bot_refresh_token: null,
    bot_scopes: "chat:write",
    bot_token: "xoxb-token",
    bot_token_expires_at: null,
    bot_user_id: "UBOT",
    enterprise_id: null,
    enterprise_name: null,
    enterprise_url: null,
    incoming_webhook_channel: null,
    incoming_webhook_channel_id: null,
    incoming_webhook_configuration_url: null,
    incoming_webhook_url: null,
    installed_at: new Date("2026-05-15T00:00:00Z"),
    is_enterprise_install: false,
    payload: {},
    team_id: null,
    team_name: null,
    token_type: "bot",
    user_id: "U1",
    user_refresh_token: null,
    user_scopes: null,
    user_token: null,
    user_token_expires_at: null,
  };
}

function botRecord(): Record<string, unknown> {
  return {
    app_id: "A1",
    bot_id: "B1",
    bot_refresh_token: null,
    bot_scopes: "chat:write",
    bot_token: "xoxb-token",
    bot_token_expires_at: null,
    bot_user_id: "UBOT",
    enterprise_id: null,
    enterprise_name: null,
    installed_at: new Date("2026-05-15T00:00:00Z"),
    is_enterprise_install: false,
    payload: {},
    team_id: null,
    team_name: null,
  };
}

class RecordingPool {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];

  constructor(private readonly rows: unknown[] = []) {}

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text: text.trim().replace(/\s+/gu, " "), values });
    return { rows: this.rows };
  }
}

class QueuedRecordingPool {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];

  constructor(private readonly queuedRows: unknown[][]) {}

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text: text.trim().replace(/\s+/gu, " "), values });
    return { rows: this.queuedRows.shift() ?? [] };
  }
}
