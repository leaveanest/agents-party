import { describe, expect, it } from "vite-plus/test";

import {
  PostgresAgentRoutingRepository,
  PostgresOAuthRepository,
  PostgresWorkItemRepository,
} from "../../../src/infrastructure/postgres/appRepositories.js";

describe("Postgres app repositories", () => {
  it("writes routing, OAuth, and work-item documents through concrete repositories", async () => {
    const pool = new RecordingPool();

    await new PostgresAgentRoutingRepository(pool as never).saveWorkspaceSettings({
      defaultAgentId: "triage",
      payload: { defaultAgentId: "triage" },
      teamId: "T1",
      threadAutoReply: true,
      updatedAt: new Date("2026-05-11T00:00:00Z"),
    });
    await new PostgresOAuthRepository(pool as never).saveGoogleOAuthState({
      createdAt: new Date("2026-05-11T00:00:00Z"),
      expiresAt: new Date("2026-05-11T00:10:00Z"),
      payload: { nonce: "abc" },
      slackUserId: "U1",
      stateId: "S1",
      teamId: "T1",
    });
    await new PostgresWorkItemRepository(pool as never).saveAttentionIndex({
      needsAttentionNow: true,
      payload: { title: "Follow up" },
      status: "open",
      teamId: "T1",
      updatedAt: new Date("2026-05-11T00:00:00Z"),
      userId: "U1",
      visibilityKind: "channel",
      workItemId: "W1",
    });

    expect(pool.queries.map((query) => query.text)).toEqual([
      expect.stringContaining('insert into "workspace_app_settings"'),
      expect.stringContaining('insert into "google_oauth_states"'),
      expect.stringContaining('insert into "work_item_attention_index"'),
    ]);
  });

  it("reads OAuth connections, auth configs, and work-item aggregates", async () => {
    const pool = new RecordingPool([
      { payload: { subject: "google-subject" } },
      { payload: { org: "salesforce-org" } },
      { payload: { title: "Follow up" } },
      { payload: { user: "U1" } },
      { payload: { event: "created" } },
      { payload: { attention: true } },
      { payload: { calendar: "primary" } },
    ]);
    const oauth = new PostgresOAuthRepository(pool as never);
    const workItems = new PostgresWorkItemRepository(pool as never);

    await expect(oauth.findGoogleConnection("T1", "U1", "google-subject")).resolves.toEqual({
      subject: "google-subject",
    });
    await expect(oauth.findSalesforceAuthConfig("T1", "org-1")).resolves.toEqual({
      org: "salesforce-org",
    });
    await expect(workItems.getWorkItemAggregate("T1", "W1")).resolves.toEqual({
      attention: [{ attention: true }],
      calendarLinks: [{ calendar: "primary" }],
      events: [{ event: "created" }],
      item: { title: "Follow up" },
      participants: [{ user: "U1" }],
    });
  });
});

class RecordingPool {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];

  constructor(private readonly rows: Array<{ payload: unknown }> = []) {}

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text: text.trim().replace(/\s+/gu, " "), values });
    if (text.includes("select")) {
      return { rows: this.rows.splice(0, text.includes("where") ? 1 : this.rows.length) };
    }
    return { rows: [] };
  }
}
