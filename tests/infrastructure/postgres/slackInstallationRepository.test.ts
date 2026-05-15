import { describe, expect, it } from "vite-plus/test";

import { PostgresSlackInstallationRepository } from "../../../src/infrastructure/postgres/slackInstallationRepository.js";

describe("PostgresSlackInstallationRepository", () => {
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

class RecordingPool {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];

  constructor(private readonly rows: unknown[] = []) {}

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text: text.trim().replace(/\s+/gu, " "), values });
    return { rows: this.rows };
  }
}
