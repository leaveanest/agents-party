import { describe, expect, it } from "vite-plus/test";

import { PostgresUserSettingsRepository } from "../../../src/infrastructure/postgres/userSettingsRepository.js";

describe("user settings repository", () => {
  it("upserts app-level user settings keyed by Slack workspace and user", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresUserSettingsRepository(pool as never);

    await repository.saveUserSettings({
      locale: "en",
      payload: { notifications: "mentions" },
      slackUserId: "U1",
      teamId: "T1",
      updatedAt: new Date("2026-05-15T00:00:00Z"),
      updatedBySlackUserId: "UADMIN",
    });

    const [query] = pool.queries;
    expect(query?.text).toContain("insert into app_user_settings");
    expect(query?.text).toContain("on conflict (scope_kind, scope_id, slack_user_id)");
    expect(query?.values).toEqual([
      "team",
      "T1",
      null,
      "T1",
      "U1",
      "en",
      new Date("2026-05-15T00:00:00Z"),
      new Date("2026-05-15T00:00:00Z"),
      "UADMIN",
      JSON.stringify({ notifications: "mentions" }),
    ]);
  });

  it("uses enterprise scope when enterprise id is present", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresUserSettingsRepository(pool as never);

    await repository.saveUserSettings({
      enterpriseId: "E1",
      locale: "ja",
      slackUserId: "U1",
      teamId: "T1",
      updatedAt: new Date("2026-05-15T00:00:00Z"),
    });

    const [query] = pool.queries;
    expect(query?.values?.slice(0, 5)).toEqual(["enterprise", "E1", "E1", "T1", "U1"]);
  });

  it("maps persisted settings documents", async () => {
    const repository = new PostgresUserSettingsRepository(
      new RecordingPool([
        {
          created_at: new Date("2026-05-15T00:00:00Z"),
          enterprise_id: null,
          locale: "ja",
          payload: { theme: "compact" },
          scope_id: "T1",
          scope_kind: "team",
          slack_user_id: "U1",
          team_id: "T1",
          updated_at: new Date("2026-05-15T01:00:00Z"),
          updated_by_slack_user_id: "UADMIN",
        },
      ]) as never,
    );

    await expect(repository.findUserSettings({ slackUserId: "U1", teamId: "T1" })).resolves.toEqual(
      {
        createdAt: new Date("2026-05-15T00:00:00Z"),
        locale: "ja",
        payload: { theme: "compact" },
        scopeId: "T1",
        scopeKind: "team",
        slackUserId: "U1",
        teamId: "T1",
        updatedAt: new Date("2026-05-15T01:00:00Z"),
        updatedBySlackUserId: "UADMIN",
      },
    );
  });
});

class RecordingPool {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];

  constructor(private readonly rows: unknown[] = []) {}

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text: text.trim().replace(/\s+/gu, " "), values });
    if (text.includes("select")) {
      return { rows: this.rows };
    }
    return { rows: [] };
  }
}
