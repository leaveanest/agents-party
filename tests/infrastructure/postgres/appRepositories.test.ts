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
      defaultModelId: "google:gemini-2.5-flash",
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
    expect(JSON.parse(String(pool.queries[0]?.values?.at(-1)))).toMatchObject({
      default_agent_id: "triage",
      default_model_id: "google:gemini-2.5-flash",
      thread_auto_reply: true,
    });
  });

  it("removes stale routing fields from persisted payloads when values are cleared", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresAgentRoutingRepository(pool as never);

    await repository.saveWorkspaceSettings({
      payload: {
        default_agent_id: "old-agent",
        default_model_id: "old-model",
        thread_auto_reply: true,
        untouched: "keep",
      },
      teamId: "T1",
      updatedAt: new Date("2026-05-11T00:00:00Z"),
    });
    await repository.saveSlackThread({
      channelId: "C1",
      createdAt: new Date("2026-05-11T00:00:00Z"),
      payload: {
        agent_id: "old-agent",
        model_id: "old-model",
        untouched: "keep",
      },
      rootMessageTs: "1.0",
      status: "active",
      teamId: "T1",
      threadTs: "1.0",
      updatedAt: new Date("2026-05-11T00:00:00Z"),
    });

    expect(JSON.parse(String(pool.queries[0]?.values?.at(-1)))).toEqual({
      untouched: "keep",
      updated_at: "2026-05-11T00:00:00.000Z",
    });
    expect(JSON.parse(String(pool.queries[1]?.values?.at(-1)))).toEqual({
      channel_id: "C1",
      created_at: "2026-05-11T00:00:00.000Z",
      root_message_ts: "1.0",
      status: "active",
      team_id: "T1",
      thread_ts: "1.0",
      untouched: "keep",
      updated_at: "2026-05-11T00:00:00.000Z",
    });
  });

  it("reads OAuth connections, auth configs, and work-item aggregates", async () => {
    const pool = new RecordingPool([
      { payload: { subject: "google-subject" } },
      { payload: { org: "salesforce-org" } },
      { payload: { title: "Follow up" } },
      { payload: { user: "U1" } },
      [
        { payload: { event: "second", event_id: "E2", occurred_at: "2026-05-11T00:02:00.000Z" } },
        { payload: { event: "first", event_id: "E1", occurred_at: "2026-05-11T00:01:00.000Z" } },
      ],
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
      recentEvents: [
        { event: "first", event_id: "E1", occurred_at: "2026-05-11T00:01:00.000Z" },
        { event: "second", event_id: "E2", occurred_at: "2026-05-11T00:02:00.000Z" },
      ],
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

  it("normalizes saved agent enabled state into payloads used by routing", async () => {
    const pool = new RecordingPool();

    await new PostgresAgentRoutingRepository(pool as never).saveAgent({
      agentId: "assistant",
      enabled: false,
      payload: { enabled: true, untouched: "keep" },
      updatedAt: new Date("2026-05-11T00:00:00Z"),
    });

    expect(JSON.parse(String(pool.queries[0]?.values?.at(-1)))).toMatchObject({
      agent_id: "assistant",
      enabled: false,
      untouched: "keep",
      updated_at: "2026-05-11T00:00:00.000Z",
    });
  });

  it("does not resolve disabled agents when routing payload omits column data", async () => {
    await expect(
      new PostgresAgentRoutingRepository(
        new RecordingPool([
          { payload: {} },
          { payload: { default_agent_id: "assistant" } },
          { payload: {} },
          { payload: {} },
          { agent_id: "assistant", enabled: false, payload: { agent_id: "assistant" } },
        ]) as never,
      ).resolveAgent({ channelId: "C1", teamId: "T1", threadTs: "1.0" }),
    ).resolves.toBeUndefined();
  });

  it("resolves configured agents and models from thread, channel, and workspace settings", async () => {
    await expect(
      new PostgresAgentRoutingRepository(
        new RecordingPool([
          { payload: { enabled_channel_ids: ["C1"] } },
          { payload: { default_agent_id: "workspace", default_model_id: "workspace-model" } },
          { payload: { default_agent_id: "channel", default_model_id: "channel-model" } },
          {
            payload: {
              agent_id: "thread",
              model_id: "thread-model",
              model_scope: "thread",
              status: "active",
            },
          },
          { payload: { agent_id: "thread", enabled: true } },
        ]) as never,
      ).resolveAgent({ channelId: "C1", teamId: "T1", threadTs: "1.0" }),
    ).resolves.toEqual(
      expect.objectContaining({
        agentId: "thread",
        modelId: "thread-model",
        modelScope: "thread",
        scope: "thread",
      }),
    );

    await expect(
      new PostgresAgentRoutingRepository(
        new RecordingPool([
          { payload: {} },
          { payload: { default_agent_id: "workspace", default_model_id: "workspace-model" } },
          { payload: { default_agent_id: "channel", default_model_id: "channel-model" } },
          { payload: {} },
          { payload: { agent_id: "channel", enabled: true } },
        ]) as never,
      ).resolveAgent({ channelId: "C1", teamId: "T1", threadTs: "1.0" }),
    ).resolves.toEqual(
      expect.objectContaining({
        agentId: "channel",
        modelId: "channel-model",
        modelScope: "channel",
        scope: "channel",
      }),
    );

    await expect(
      new PostgresAgentRoutingRepository(
        new RecordingPool([
          { payload: {} },
          { payload: { default_agent_id: "workspace", default_model_id: "workspace-model" } },
          { payload: {} },
          { payload: {} },
          { payload: { agent_id: "workspace", enabled: true } },
        ]) as never,
      ).resolveAgent({ channelId: "C1", teamId: "T1", threadTs: "1.0" }),
    ).resolves.toEqual(
      expect.objectContaining({
        agentId: "workspace",
        modelId: "workspace-model",
        modelScope: "workspace",
        scope: "workspace",
      }),
    );
  });

  it("ignores unscoped stale thread model ids when resolving configured models", async () => {
    await expect(
      new PostgresAgentRoutingRepository(
        new RecordingPool([
          { payload: {} },
          { payload: { default_agent_id: "workspace", default_model_id: "workspace-model" } },
          { payload: { default_model_id: "channel-model" } },
          { payload: { agent_id: "workspace", model_id: "stale-thread-model" } },
          { payload: { agent_id: "workspace", enabled: true } },
        ]) as never,
      ).resolveAgent({ channelId: "C1", teamId: "T1", threadTs: "1.0" }),
    ).resolves.toEqual(
      expect.objectContaining({
        modelId: "channel-model",
        modelScope: "channel",
        scope: "workspace",
      }),
    );
  });

  it("ignores blank higher-precedence model ids when resolving configured models", async () => {
    await expect(
      new PostgresAgentRoutingRepository(
        new RecordingPool([
          { payload: {} },
          { payload: { default_agent_id: "workspace", default_model_id: "workspace-model" } },
          { payload: { default_model_id: "  " } },
          {
            payload: {
              agent_id: "workspace",
              model_id: "",
              model_scope: "thread",
              status: "active",
            },
          },
          { payload: { agent_id: "workspace", enabled: true } },
        ]) as never,
      ).resolveAgent({ channelId: "C1", teamId: "T1", threadTs: "1.0" }),
    ).resolves.toEqual(
      expect.objectContaining({
        modelId: "workspace-model",
        modelScope: "workspace",
      }),
    );
  });

  it("ignores inactive thread agent and model routes", async () => {
    await expect(
      new PostgresAgentRoutingRepository(
        new RecordingPool([
          { payload: {} },
          { payload: { default_agent_id: "workspace", default_model_id: "workspace-model" } },
          { payload: { default_agent_id: "channel", default_model_id: "channel-model" } },
          {
            payload: {
              agent_id: "thread",
              model_id: "thread-model",
              model_scope: "thread",
              status: "closed",
            },
          },
          { payload: { agent_id: "channel", enabled: true } },
        ]) as never,
      ).resolveAgent({ channelId: "C1", teamId: "T1", threadTs: "1.0" }),
    ).resolves.toEqual(
      expect.objectContaining({
        agentId: "channel",
        modelId: "channel-model",
        modelScope: "channel",
        scope: "channel",
      }),
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

  it("treats an empty status filter as no filter for work-item queries", async () => {
    const pool = new RecordingPool([
      { payload: { work_item_id: "W1" } },
      {
        payload: {
          status: "captured",
          team_id: "T1",
          title: "Visible",
          updated_at: "2026-05-11T00:00:00.000Z",
          visibility_kind: "private",
          work_item_id: "W1",
        },
      },
      { payload: { role: "follower", user_id: "U1", work_item_id: "W1" } },
      [],
      [],
      [],
    ]);
    const repository = new PostgresWorkItemRepository(pool as never);

    await expect(
      repository.listWorkItemAggregates({
        statusIn: [],
        teamId: "T1",
        view: "inbox",
        viewerUserId: "U1",
      }),
    ).resolves.toHaveLength(1);
  });

  it("links calendar events transactionally without changing due or attention by default", async () => {
    const pool = new RecordingPool(emptyAggregateRows());
    const repository = new PostgresWorkItemRepository(pool as never);

    const aggregate = await repository.linkCalendarEvent({
      actorUserId: "U1",
      calendarLink: calendarLink({ starts_at: "2026-05-12T10:00:00.000Z" }),
      teamId: "T1",
      workItemId: "W1",
    });

    expect(aggregate.item).not.toHaveProperty("due_at");
    expect(aggregate.participants[0]).not.toHaveProperty("next_attention_at");
    expect(aggregate.calendarLinks).toEqual([
      expect.objectContaining({
        external_calendar_id: "primary",
        external_event_id: "event-1",
        provider_kind: "google_calendar",
      }),
    ]);
    expect(aggregate.recentEvents.map((event) => event.type)).toContain("calendar_event_linked");
    expect(pool.queries.map((query) => query.text)).toEqual(
      expect.arrayContaining([
        "begin",
        expect.stringContaining('insert into "work_item_calendar_links"'),
        expect.stringContaining('insert into "work_item_events"'),
        "commit",
      ]),
    );
  });

  it("applies calendar start time only when explicitly requested", async () => {
    const repository = new PostgresWorkItemRepository(
      new RecordingPool(emptyAggregateRows()) as never,
    );

    const aggregate = await repository.linkCalendarEvent({
      actorUserId: "U1",
      applyStartsAtToDueAt: true,
      applyStartsAtToNextAttentionAtForUserId: "U1",
      calendarLink: calendarLink({ starts_at: "2026-05-12T10:00:00.000Z" }),
      teamId: "T1",
      workItemId: "W1",
    });

    expect(aggregate.item).toMatchObject({ due_at: "2026-05-12T10:00:00.000Z" });
    expect(aggregate.participants[0]).toMatchObject({
      next_attention_at: "2026-05-12T10:00:00.000Z",
    });
    expect(aggregate.recentEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining(["attention_scheduled", "calendar_event_linked", "due_at_changed"]),
    );
  });

  it("records canceled and not-found sync statuses without deleting the work item", async () => {
    const canceledAggregate = await new PostgresWorkItemRepository(
      new RecordingPool(emptyAggregateRows()) as never,
    ).linkCalendarEvent({
      actorUserId: "U1",
      calendarLink: calendarLink({ sync_status: "canceled" }),
      teamId: "T1",
      workItemId: "W1",
    });
    const notFoundAggregate = await new PostgresWorkItemRepository(
      new RecordingPool(emptyAggregateRows()) as never,
    ).linkCalendarEvent({
      actorUserId: "U1",
      calendarLink: calendarLink({ link_id: "calendar-link-2", sync_status: "not_found" }),
      teamId: "T1",
      workItemId: "W1",
    });

    expect(canceledAggregate.item).toMatchObject({ work_item_id: "W1" });
    expect(canceledAggregate.calendarLinks[0]).toMatchObject({ sync_status: "canceled" });
    expect(canceledAggregate.recentEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining(["calendar_event_canceled", "calendar_event_linked"]),
    );
    expect(notFoundAggregate.item).toMatchObject({ work_item_id: "W1" });
    expect(notFoundAggregate.calendarLinks[0]).toMatchObject({ sync_status: "not_found" });
  });

  it("unlinks calendar events transactionally without deleting the work item", async () => {
    const pool = new RecordingPool(emptyAggregateRows([calendarLink()]));
    const repository = new PostgresWorkItemRepository(pool as never);

    const aggregate = await repository.unlinkCalendarEvent({
      actorUserId: "U1",
      linkId: "calendar-link-1",
      teamId: "T1",
      workItemId: "W1",
    });

    expect(aggregate.item).toMatchObject({ work_item_id: "W1" });
    expect(aggregate.calendarLinks).toEqual([]);
    expect(aggregate.recentEvents.map((event) => event.type)).toContain("calendar_event_unlinked");
    expect(pool.queries.map((query) => query.text)).toEqual(
      expect.arrayContaining([
        "begin",
        expect.stringContaining('delete from "work_item_calendar_links"'),
        expect.stringContaining('insert into "work_item_events"'),
        "commit",
      ]),
    );
  });
});

function emptyAggregateRows(calendarLinks: unknown[] = []) {
  return [
    {
      payload: {
        created_by_user_id: "U1",
        status: "captured",
        team_id: "T1",
        title: "Follow up",
        updated_at: "2026-05-11T00:00:00.000Z",
        visibility_kind: "private",
        work_item_id: "W1",
      },
    },
    [
      {
        payload: {
          attention_profile: "track",
          role: "follower",
          user_id: "U1",
          work_item_id: "W1",
        },
      },
    ],
    [],
    [],
    calendarLinks.map((payload) => ({ payload })),
  ];
}

function calendarLink(overrides: Record<string, unknown> = {}) {
  return {
    created_at: "2026-05-11T00:00:00.000Z",
    ends_at: "2026-05-12T11:00:00.000Z",
    event_title_snapshot: "Calendar event",
    external_calendar_id: "primary",
    external_event_id: "event-1",
    is_all_day: false,
    link_id: "calendar-link-1",
    provider_kind: "google_calendar",
    response_status: "accepted",
    starts_at: "2026-05-12T10:00:00.000Z",
    sync_status: "active",
    team_id: "T1",
    updated_at: "2026-05-11T00:00:00.000Z",
    work_item_id: "W1",
    ...overrides,
  };
}

class RecordingPool {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];

  constructor(
    private readonly rows: Array<Record<string, unknown> | Array<Record<string, unknown>>> = [],
  ) {}

  async connect() {
    return this;
  }

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text: text.trim().replace(/\s+/gu, " "), values });
    if (text.includes("select")) {
      const next = this.rows.splice(0, text.includes("where") ? 1 : this.rows.length);
      return { rows: next.flat() };
    }
    return { rows: [] };
  }

  release(): void {}
}
