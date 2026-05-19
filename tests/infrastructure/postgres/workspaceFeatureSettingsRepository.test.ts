import { describe, expect, it } from "vite-plus/test";

import { PostgresWorkspaceFeatureSettingsRepository } from "../../../src/infrastructure/postgres/workspaceFeatureSettingsRepository.js";

describe("workspace feature settings repository", () => {
  it("stores workspace feature settings scoped by Slack team", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresWorkspaceFeatureSettingsRepository(pool as never);

    await repository.saveWorkspaceFeatureSetting({
      enabled: true,
      featureKey: "image_generation",
      payload: { source: "test" },
      teamId: "T1",
      updatedAt: new Date("2026-05-19T00:00:00Z"),
      updatedByUserId: "U1",
    });

    expect(pool.queries[0]).toMatchObject({
      values: [
        "T1",
        "image_generation",
        true,
        new Date("2026-05-19T00:00:00Z"),
        "U1",
        JSON.stringify({ source: "test" }),
      ],
    });
    expect(pool.queries[0]?.text).toContain("workspace_feature_settings");
  });

  it("replaces channel allowlist inside one transaction", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresWorkspaceFeatureSettingsRepository(pool as never);

    await repository.replaceAllowedChannels({
      channelIds: ["C1", "C2", "C1"],
      featureKey: "image_generation",
      teamId: "T1",
      updatedAt: new Date("2026-05-19T00:00:00Z"),
      updatedByUserId: "U1",
    });

    expect(pool.queries.map((query) => query.text)).toEqual([
      "begin",
      expect.stringContaining("delete from channel_feature_settings"),
      expect.stringContaining("insert into channel_feature_settings"),
      expect.stringContaining("insert into channel_feature_settings"),
      "commit",
    ]);
    expect(pool.queries[2]?.values?.slice(0, 3)).toEqual(["T1", "C1", "image_generation"]);
    expect(pool.queries[3]?.values?.slice(0, 3)).toEqual(["T1", "C2", "image_generation"]);
  });
});

class RecordingPool {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text: text.trim().replace(/\s+/gu, " "), values });
    return { rows: [] };
  }

  async connect() {
    return {
      query: async (text: string, values?: unknown[]) => this.query(text, values),
      release() {},
    };
  }
}
