import { describe, expect, it } from "vite-plus/test";

import {
  PostgresAgentRoutingRepository,
  PostgresOAuthRepository,
  PostgresSalesforcePdfWorkflowRepository,
} from "../../../src/infrastructure/postgres/appRepositories.js";

describe("Postgres app repositories", () => {
  it("writes routing and OAuth documents through concrete repositories", async () => {
    const pool = new RecordingPool();

    await new PostgresAgentRoutingRepository(pool as never).saveWorkspaceSettings({
      defaultAgentId: "triage",
      defaultModelId: "google:gemini-2.5-flash",
      enabledModelIds: ["google:gemini-2.5-flash"],
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

    expect(pool.queries.map((query) => query.text)).toEqual([
      expect.stringContaining('insert into "workspace_app_settings"'),
      expect.stringContaining('insert into "google_oauth_states"'),
    ]);
    expect(JSON.parse(String(pool.queries[0]?.values?.[3]))).toEqual(["google:gemini-2.5-flash"]);
    expect(JSON.parse(String(pool.queries[0]?.values?.at(-1)))).toMatchObject({
      default_agent_id: "triage",
      default_model_id: "google:gemini-2.5-flash",
      enabled_model_ids: ["google:gemini-2.5-flash"],
      thread_auto_reply: true,
    });
  });

  it("keeps enabled model ids workspace-only when channel settings are saved", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresAgentRoutingRepository(pool as never);

    await repository.saveChannelSettings({
      channelId: "C1",
      defaultModelId: "google:gemini-2.5-flash",
      payload: { enabled_model_ids: ["should-not-persist"], untouched: "keep" },
      teamId: "T1",
      updatedAt: new Date("2026-05-11T00:00:00Z"),
    });

    expect(pool.queries[0]?.text).toContain('insert into "channel_app_settings"');
    expect(pool.queries[0]?.text).not.toContain("enabled_model_ids");
    expect(JSON.parse(String(pool.queries[0]?.values?.at(-1)))).toEqual({
      default_model_id: "google:gemini-2.5-flash",
      untouched: "keep",
      updated_at: "2026-05-11T00:00:00.000Z",
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

  it("reads OAuth connections and auth configs", async () => {
    const pool = new RecordingPool([
      { payload: { subject: "google-subject" } },
      { payload: { org: "salesforce-org" } },
    ]);
    const oauth = new PostgresOAuthRepository(pool as never);

    await expect(oauth.findGoogleConnection("T1", "U1", "google-subject")).resolves.toEqual({
      subject: "google-subject",
    });
    await expect(oauth.findSalesforceAuthConfig("T1", "org-1")).resolves.toEqual({
      org: "salesforce-org",
    });
  });

  it("writes Salesforce PDF workflow settings and template metadata", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresSalesforcePdfWorkflowRepository(pool as never);

    await repository.saveSalesforcePdfWorkflowSetting({
      action: "quote_pdf",
      enabled: true,
      payload: {
        action: "quote_pdf",
        enabled: true,
        salesforce_org_id: "00DORG",
        team_id: "T1",
        template_id: "quote_v1",
      },
      salesforceOrgId: "00DORG",
      teamId: "T1",
      templateId: "quote_v1",
      updatedAt: new Date("2026-05-13T00:00:00Z"),
    });
    await repository.saveSalesforcePdfTemplate({
      action: "quote_pdf",
      payload: {
        action: "quote_pdf",
        display_name: "Quote",
        salesforce_org_id: "00DORG",
        team_id: "T1",
        template_id: "quote_v1",
      },
      salesforceOrgId: "00DORG",
      status: "active",
      teamId: "T1",
      templateId: "quote_v1",
      updatedAt: new Date("2026-05-13T00:00:00Z"),
    });

    expect(pool.queries.map((query) => query.text)).toEqual([
      expect.stringContaining('insert into "salesforce_pdf_workflow_settings"'),
      expect.stringContaining('insert into "salesforce_pdf_templates"'),
    ]);
    expect(JSON.parse(String(pool.queries[0]?.values?.at(-1)))).toMatchObject({
      action: "quote_pdf",
      enabled: true,
      template_id: "quote_v1",
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

  it("falls back to the next enabled upper model when a lower route is disabled", async () => {
    await expect(
      new PostgresAgentRoutingRepository(
        new RecordingPool([
          { payload: {} },
          {
            payload: {
              default_agent_id: "workspace",
              default_model_id: "workspace-model",
              enabled_model_ids: ["workspace-model"],
            },
          },
          { payload: { default_model_id: "disabled-channel-model" } },
          {
            payload: {
              agent_id: "workspace",
              model_id: "disabled-thread-model",
              model_scope: "thread",
              status: "active",
            },
          },
          { payload: { agent_id: "workspace", enabled: true } },
        ]) as never,
      ).resolveAgent({ channelId: "C1", teamId: "T1", threadTs: "1.0" }),
    ).resolves.toEqual(
      expect.objectContaining({
        modelFallback: {
          fromModelId: "disabled-thread-model",
          fromScope: "thread",
          toModelId: "workspace-model",
          toScope: "workspace",
        },
        modelId: "workspace-model",
        modelScope: "workspace",
      }),
    );
  });

  it("fails closed when configured models are all disabled by the workspace allowlist", async () => {
    await expect(
      new PostgresAgentRoutingRepository(
        new RecordingPool([
          { payload: {} },
          {
            payload: {
              default_agent_id: "workspace",
              default_model_id: "disabled-workspace-model",
              enabled_model_ids: ["other-model"],
            },
          },
          { payload: { default_model_id: "disabled-channel-model" } },
          {
            payload: {
              agent_id: "workspace",
              model_id: "disabled-thread-model",
              model_scope: "thread",
              status: "active",
            },
          },
          { payload: { agent_id: "workspace", enabled: true } },
        ]) as never,
      ).resolveAgent({ channelId: "C1", teamId: "T1", threadTs: "1.0" }),
    ).resolves.toBeUndefined();
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
});

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
