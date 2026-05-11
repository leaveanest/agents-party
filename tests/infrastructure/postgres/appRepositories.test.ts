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
      attentionIndexes: [{ attention: true }],
      calendarLinks: [{ calendar: "primary" }],
      item: { title: "Follow up" },
      participants: [{ user: "U1" }],
      recentEvents: [{ event: "created" }],
      viewerRelation: undefined,
    });
  });

  it("updates enabled agents and honors channel/thread routing settings", async () => {
    const agentPool = new RecordingPool([
      { payload: { agent_id: "assistant", enabled: true } },
      { payload: { agent_id: "research", enabled: false } },
    ]);

    await expect(
      new PostgresAgentRoutingRepository(agentPool as never).setEnabledAgents(["research"]),
    ).resolves.toEqual([
      expect.objectContaining({ agent_id: "assistant", enabled: false }),
      expect.objectContaining({ agent_id: "research", enabled: true }),
    ]);
    await expect(
      new PostgresAgentRoutingRepository(
        new RecordingPool([
          { payload: { enabled_channel_ids: ["C1"], thread_auto_reply: true } },
        ]) as never,
      ).isChannelEnabled("T1", "C1"),
    ).resolves.toBe(true);
    await expect(
      new PostgresAgentRoutingRepository(
        new RecordingPool([
          { payload: { enabled_channel_ids: ["C1"], thread_auto_reply: true } },
          { payload: { thread_auto_reply: false } },
        ]) as never,
      ).isThreadAutoReplyEnabled("T1", "C1"),
    ).resolves.toBe(false);

    expect(agentPool.queries.map((query) => query.text)).toEqual(
      expect.arrayContaining(["begin", expect.stringContaining('insert into "agents"'), "commit"]),
    );
  });

  it("creates work items with participants, events, and derived attention indexes", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresWorkItemRepository(pool as never);

    const aggregate = await repository.createWorkItem(
      {
        created_by_user_id: "U1",
        source_channel_id: "C1",
        status: "captured",
        team_id: "T1",
        title: "Follow up",
        updated_at: "2026-05-11T00:00:00.000Z",
        visibility_kind: "context",
        work_item_id: "W1",
      },
      [
        {
          attention_profile: "track",
          role: "follower",
          user_id: "U1",
          work_item_id: "W1",
        },
      ],
      [
        {
          event_id: "E1",
          occurred_at: "2026-05-11T00:00:00.000Z",
          type: "mentioned",
          work_item_id: "W1",
        },
      ],
    );

    expect(aggregate.attentionIndexes[0]).toEqual(
      expect.objectContaining({
        attention_reason: "directed_event",
        needs_attention_now: true,
        team_id: "T1",
        user_id: "U1",
        work_item_id: "W1",
      }),
    );
    expect(pool.queries.map((query) => query.text)).toEqual(
      expect.arrayContaining([
        "begin",
        expect.stringContaining('insert into "work_items"'),
        expect.stringContaining('delete from "work_item_participants"'),
        expect.stringContaining('insert into "work_item_attention_index"'),
        "commit",
      ]),
    );
  });
});

class RecordingPool {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];

  constructor(private readonly rows: Array<{ payload: unknown }> = []) {}

  async connect() {
    return this;
  }

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text: text.trim().replace(/\s+/gu, " "), values });
    if (text.includes("select")) {
      return { rows: this.rows.splice(0, text.includes("where") ? 1 : this.rows.length) };
    }
    return { rows: [] };
  }

  release(): void {}
}
