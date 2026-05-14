import { describe, expect, it } from "vite-plus/test";

import { AgentRunnerExecutionError } from "../../src/agents/runner.js";
import type { JsonObject } from "../../src/infrastructure/postgres/jsonDocumentRepository.js";
import {
  createAgentSlackHandlers,
  postAgentResult,
  processSlackAgentJob,
} from "../../src/slack/agentHandlers.js";

describe("createAgentSlackHandlers", () => {
  it("publishes Salesforce connection status and connect entry points on App Home", async () => {
    const publishedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      salesforceConnectionHome: {
        buildStartUrl(input) {
          return `https://app.example.com/oauth/salesforce/start?org=${input.salesforceOrgId}`;
        },
        repository: {
          async listSalesforceAuthConfigs(): Promise<JsonObject[]> {
            return [
              {
                default_scopes: ["api", "refresh_token"],
                oauth_client_id: "salesforce-client",
                redirect_uri: "https://app.example.com/oauth/salesforce/callback",
                salesforce_my_domain_host: "example.my.salesforce.com",
                salesforce_org_id: "00DORG",
                salesforce_org_name: "Salesforce Production",
                status: "active",
                team_id: "T1",
              },
            ];
          },
          async listSalesforceConnections(): Promise<JsonObject[]> {
            return [
              {
                access_token_encrypted: "encrypted-access",
                connection_status: "active",
                created_at: "2026-05-01T00:00:00.000Z",
                granted_scopes: ["api"],
                last_refresh_error_at: null,
                last_refresh_error_code: null,
                last_refreshed_at: null,
                last_successful_access_at: "2026-05-01T00:00:00.000Z",
                refresh_token_encrypted: "encrypted-refresh",
                salesforce_identity_url: "https://example.my.salesforce.com/id/00DORG/005USER",
                salesforce_instance_url: "https://example.my.salesforce.com",
                salesforce_org_id: "00DORG",
                salesforce_user_email: "sf@example.com",
                salesforce_user_id: "005USER",
                salesforce_username: "sf@example.com",
                slack_user_id: "U1",
                team_id: "T1",
                token_expires_at: "2026-05-01T01:00:00.000Z",
                updated_at: "2026-05-01T00:00:00.000Z",
              },
            ];
          },
        },
      },
    });

    await handlers.handleAppHomeOpened({
      body: { team_id: "T1" },
      client: {
        views: {
          publish: async (payload: unknown) => {
            publishedViews.push(payload);
            return {};
          },
        },
      },
      event: { user: "U1" },
      logger: { warn() {} },
    } as never);

    expect(JSON.stringify(publishedViews[0])).toContain("Salesforce Production");
    expect(JSON.stringify(publishedViews[0])).toContain("Connected as sf@example.com");
    expect(JSON.stringify(publishedViews[0])).toContain(
      "https://app.example.com/oauth/salesforce/start?org=00DORG",
    );
  });

  it("publishes Salesforce PDF workflow settings on App Home", async () => {
    const publishedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      salesforceConnectionHome: salesforceConnectionHomeFixture(),
      salesforcePdfWorkflowHome: {
        repository: {
          async findSalesforcePdfWorkflowSetting() {
            return undefined;
          },
          async listSalesforcePdfWorkflowSettings(): Promise<JsonObject[]> {
            return [
              {
                action: "quote_pdf",
                allowed_record_type_ids: [],
                allowed_record_type_names: [],
                allowed_stages: ["Proposal"],
                allowed_statuses: [],
                attach_to: "quote",
                created_at: "2026-05-13T00:00:00.000Z",
                enabled: true,
                field_mapping: {},
                required_fields: ["AccountId"],
                require_confirmation_before_attach: true,
                salesforce_org_id: "00DORG",
                slack_channel_allowlist: [],
                slack_user_group_allowlist: [],
                team_id: "T1",
                template_id: "quote_v1",
                updated_at: "2026-05-13T00:00:00.000Z",
              },
            ];
          },
          async saveSalesforcePdfWorkflowSetting() {},
        },
      },
    });

    await handlers.handleAppHomeOpened({
      body: { team_id: "T1" },
      client: {
        views: {
          publish: async (payload: unknown) => {
            publishedViews.push(payload);
            return {};
          },
        },
      },
      event: { user: "U1" },
      logger: { warn() {} },
    } as never);

    const serialized = JSON.stringify(publishedViews[0]);
    expect(serialized).toContain("Quote PDF");
    expect(serialized).toContain("Enabled - template: quote_v1");
    expect(serialized).toContain("Deal Review Pack");
    expect(serialized).toContain("salesforce_pdf_workflow_configure");
  });

  it("opens the Salesforce PDF workflow modal for Slack workspace admins", async () => {
    const openedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      salesforcePdfWorkflowHome: {
        repository: {
          async findSalesforcePdfWorkflowSetting(): Promise<JsonObject> {
            return validSalesforcePdfWorkflowSetting();
          },
          async listSalesforcePdfWorkflowSettings(): Promise<JsonObject[]> {
            return [];
          },
          async saveSalesforcePdfWorkflowSetting() {},
        },
      },
    });

    await handlers.handleSalesforcePdfWorkflowConfigureAction({
      ack: async () => undefined,
      body: {
        actions: [{ value: JSON.stringify({ action: "quote_pdf", salesforceOrgId: "00DORG" }) }],
        team: { id: "T1" },
        trigger_id: "TRIGGER1",
        user: { id: "UADMIN" },
      },
      client: {
        users: {
          info: async () => ({ user: { is_admin: true } }),
        },
        views: {
          open: async (payload: unknown) => {
            openedViews.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    expect(openedViews).toEqual([
      expect.objectContaining({
        trigger_id: "TRIGGER1",
        view: expect.objectContaining({
          callback_id: "salesforce_pdf_workflow_modal",
          private_metadata: JSON.stringify({
            action: "quote_pdf",
            salesforceOrgId: "00DORG",
            teamId: "T1",
          }),
        }),
      }),
    ]);
    expect(JSON.stringify(openedViews[0])).toContain("quote_v1");
    expect(JSON.stringify(openedViews[0])).toContain("012000000000001AAA");
  });

  it("saves Salesforce PDF workflow settings from modal submissions", async () => {
    const acks: unknown[] = [];
    const saves: unknown[] = [];
    const updates: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      salesforcePdfWorkflowHome: {
        repository: {
          async findSalesforcePdfWorkflowSetting() {
            return undefined;
          },
          async listSalesforcePdfWorkflowSettings(): Promise<JsonObject[]> {
            return [];
          },
          async saveSalesforcePdfWorkflowSetting(input: unknown) {
            saves.push(input);
          },
        },
      },
    });

    await handlers.handleSalesforcePdfWorkflowModalSubmission({
      ack: async (payload?: unknown) => {
        acks.push(payload);
      },
      body: { team: { id: "T1" }, user: { id: "UADMIN" } },
      client: {
        users: {
          info: async () => ({ user: { is_owner: true } }),
        },
        views: {
          update: async (payload: unknown) => {
            updates.push(payload);
            return {};
          },
        },
      },
      logger: { error() {}, info() {}, warn() {} },
      view: validSalesforcePdfWorkflowView(),
    } as never);

    expect(acks).toEqual([
      expect.objectContaining({
        response_action: "update",
      }),
    ]);
    expect(saves).toEqual([
      expect.objectContaining({
        action: "quote_pdf",
        enabled: true,
        salesforceOrgId: "00DORG",
        teamId: "T1",
        templateId: "quote_v1",
      }),
    ]);
    expect(saves[0]).toMatchObject({
      payload: expect.objectContaining({
        allowed_stages: ["Proposal", "Negotiation"],
        field_mapping: { customerName: "Account.Name" },
        required_fields: ["AccountId", "Amount"],
      }),
    });
    expect(JSON.stringify(updates[0])).toContain("Quote PDF is enabled");
  });

  it("saves Deal Review Pack approval and AI summary settings from modal submissions", async () => {
    const saves: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      salesforcePdfWorkflowHome: {
        repository: {
          async findSalesforcePdfWorkflowSetting() {
            return undefined;
          },
          async listSalesforcePdfWorkflowSettings(): Promise<JsonObject[]> {
            return [];
          },
          async saveSalesforcePdfWorkflowSetting(input: unknown) {
            saves.push(input);
          },
        },
      },
    });

    await handlers.handleSalesforcePdfWorkflowModalSubmission({
      ack: async () => undefined,
      body: { team: { id: "T1" }, user: { id: "UADMIN" } },
      client: {
        users: {
          info: async () => ({ user: { is_owner: true } }),
        },
        views: {
          update: async () => ({}),
        },
      },
      logger: { error() {}, info() {}, warn() {} },
      view: validSalesforcePdfWorkflowView({
        action: "deal_review_pack",
        allowedApprovalStatuses: "Approved, Accepted",
        approvalStatusField: "Approval_Status__c",
        attachTo: "opportunity",
        includeAiSummary: "true",
        templateId: "deal_review_pack_v1",
      }),
    } as never);

    expect(saves[0]).toMatchObject({
      action: "deal_review_pack",
      payload: expect.objectContaining({
        allowed_approval_statuses: ["Approved", "Accepted"],
        approval_status_field: "Approval_Status__c",
        attach_to: "opportunity",
        include_ai_summary: true,
      }),
      templateId: "deal_review_pack_v1",
    });
  });

  it("preserves Salesforce PDF workflow creation and enable audit fields on updates", async () => {
    const saves: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      salesforcePdfWorkflowHome: {
        repository: {
          async findSalesforcePdfWorkflowSetting(): Promise<JsonObject> {
            return {
              ...validSalesforcePdfWorkflowSetting(),
              created_at: "2026-05-01T00:00:00.000Z",
              enabled_at: "2026-05-02T00:00:00.000Z",
              enabled_by_slack_user_id: "UORIGINAL",
            };
          },
          async listSalesforcePdfWorkflowSettings(): Promise<JsonObject[]> {
            return [];
          },
          async saveSalesforcePdfWorkflowSetting(input: unknown) {
            saves.push(input);
          },
        },
      },
    });

    await handlers.handleSalesforcePdfWorkflowModalSubmission({
      ack: async () => undefined,
      body: { team: { id: "T1" }, user: { id: "UADMIN" } },
      client: {
        users: {
          info: async () => ({ user: { is_admin: true } }),
        },
        views: {
          update: async () => ({}),
        },
      },
      logger: { error() {}, info() {}, warn() {} },
      view: validSalesforcePdfWorkflowView(),
    } as never);

    expect(saves[0]).toMatchObject({
      payload: expect.objectContaining({
        created_at: "2026-05-01T00:00:00.000Z",
        enabled_at: "2026-05-02T00:00:00.000Z",
        enabled_by_slack_user_id: "UORIGINAL",
      }),
    });
  });

  it("rejects Salesforce PDF workflow submissions from non-admin Slack users", async () => {
    const saves: unknown[] = [];
    const updates: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      salesforcePdfWorkflowHome: {
        repository: {
          async findSalesforcePdfWorkflowSetting() {
            return undefined;
          },
          async listSalesforcePdfWorkflowSettings(): Promise<JsonObject[]> {
            return [];
          },
          async saveSalesforcePdfWorkflowSetting(input: unknown) {
            saves.push(input);
          },
        },
      },
    });

    await handlers.handleSalesforcePdfWorkflowModalSubmission({
      ack: async () => undefined,
      body: { team: { id: "T1" }, user: { id: "U1" } },
      client: {
        users: {
          info: async () => ({ user: { is_admin: false, is_owner: false } }),
        },
        views: {
          update: async (payload: unknown) => {
            updates.push(payload);
            return {};
          },
        },
      },
      logger: { error() {}, warn() {} },
      view: validSalesforcePdfWorkflowView(),
    } as never);

    expect(JSON.stringify(updates[0])).toContain(
      "Only Slack workspace admins and owners can configure Salesforce PDF workflows.",
    );
    expect(saves).toEqual([]);
  });

  it("publishes an App Home API key configuration entry point when credential storage is configured", async () => {
    const publishedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      workspaceCredentialSettings: {
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleAppHomeOpened({
      body: { team_id: "T1" },
      client: {
        views: {
          publish: async (payload: unknown) => {
            publishedViews.push(payload);
            return {};
          },
        },
      },
      event: { user: "U1" },
      logger: { warn() {} },
    } as never);

    expect(JSON.stringify(publishedViews[0])).toContain("API keys");
    expect(JSON.stringify(publishedViews[0])).toContain("workspace_credential_configure");
  });

  it("opens the API key modal for Slack workspace admins", async () => {
    const acks: unknown[] = [];
    const openedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      workspaceCredentialSettings: {
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleWorkspaceCredentialConfigureAction({
      ack: async (payload?: unknown) => {
        acks.push(payload);
      },
      body: { team: { id: "T1" }, trigger_id: "TRIGGER1", user: { id: "UADMIN" } },
      client: {
        users: {
          info: async () => ({ user: { is_admin: true } }),
        },
        views: {
          open: async (payload: unknown) => {
            openedViews.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    expect(acks).toEqual([undefined]);
    expect(openedViews).toEqual([
      expect.objectContaining({
        trigger_id: "TRIGGER1",
        view: expect.objectContaining({
          callback_id: "workspace_credential_modal",
          private_metadata: "T1",
        }),
      }),
    ]);
  });

  it("saves workspace provider API keys from modal submissions", async () => {
    const acks: unknown[] = [];
    const saves: unknown[] = [];
    const updates: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      workspaceCredentialSettings: {
        async saveProviderApiKey(input: unknown) {
          saves.push(input);
        },
      },
    });

    await handlers.handleWorkspaceCredentialModalSubmission({
      ack: async (payload?: unknown) => {
        acks.push(payload);
      },
      body: { team: { id: "T1" }, user: { id: "UADMIN" } },
      client: {
        users: {
          info: async () => ({ user: { is_owner: true } }),
        },
        views: {
          update: async (payload: unknown) => {
            updates.push(payload);
            return {};
          },
        },
      },
      logger: { error() {}, info() {}, warn() {} },
      view: {
        hash: "HASH1",
        id: "VIEW1",
        private_metadata: "T1",
        state: {
          values: {
            workspace_credential_base_url: {
              base_url: { value: "https://proxy.example.com/v1" },
            },
            workspace_credential_provider: {
              provider_kind: { selected_option: { value: "openai" } },
            },
            workspace_credential_secret: {
              api_key: { value: "sk-test" },
            },
          },
        },
      },
    } as never);

    expect(acks).toEqual([
      expect.objectContaining({
        response_action: "update",
        view: expect.objectContaining({
          type: "modal",
        }),
      }),
    ]);
    expect(saves).toEqual([
      {
        createdByUserId: "UADMIN",
        payload: {
          base_url: "https://proxy.example.com/v1",
          source: "slack_app_home",
        },
        providerKind: "openai",
        secret: "sk-test",
        teamId: "T1",
      },
    ]);
    expect(updates).toEqual([
      expect.objectContaining({
        view_id: "VIEW1",
        view: expect.objectContaining({
          title: { text: "API key saved", type: "plain_text" },
        }),
      }),
    ]);
    expect(updates[0]).not.toHaveProperty("hash");
  });

  it("returns modal field errors for invalid workspace API key input", async () => {
    const acks: unknown[] = [];
    const saves: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      workspaceCredentialSettings: {
        async saveProviderApiKey(input: unknown) {
          saves.push(input);
        },
      },
    });

    await handlers.handleWorkspaceCredentialModalSubmission({
      ack: async (payload?: unknown) => {
        acks.push(payload);
      },
      body: { team: { id: "T1" }, user: { id: "UADMIN" } },
      client: {
        users: {
          info: async () => ({ user: { is_primary_owner: true } }),
        },
      },
      logger: { error() {}, warn() {} },
      view: {
        private_metadata: "T1",
        state: {
          values: {
            workspace_credential_base_url: {
              base_url: { value: "not a url" },
            },
            workspace_credential_provider: {
              provider_kind: { selected_option: { value: "openai" } },
            },
            workspace_credential_secret: {
              api_key: { value: "   " },
            },
          },
        },
      },
    } as never);

    expect(acks).toEqual([
      {
        errors: {
          workspace_credential_base_url: "Enter a valid http or https URL.",
          workspace_credential_secret: "Enter an API key.",
        },
        response_action: "errors",
      },
    ]);
    expect(saves).toEqual([]);
  });

  it("rejects workspace API key submissions from non-admin Slack users", async () => {
    const acks: unknown[] = [];
    const saves: unknown[] = [];
    const updates: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      workspaceCredentialSettings: {
        async saveProviderApiKey(input: unknown) {
          saves.push(input);
        },
      },
    });

    await handlers.handleWorkspaceCredentialModalSubmission({
      ack: async (payload?: unknown) => {
        acks.push(payload);
      },
      body: { team: { id: "T1" }, user: { id: "U1" } },
      client: {
        users: {
          info: async () => ({ user: { is_admin: false, is_owner: false } }),
        },
        views: {
          update: async (payload: unknown) => {
            updates.push(payload);
            return {};
          },
        },
      },
      logger: { error() {}, warn() {} },
      view: validWorkspaceCredentialView("T1"),
    } as never);

    expect(acks).toEqual([
      expect.objectContaining({
        response_action: "update",
      }),
    ]);
    expect(JSON.stringify(updates[0])).toContain(
      "Only Slack workspace admins and owners can configure API keys.",
    );
    expect(saves).toEqual([]);
  });

  it("rejects workspace API key submissions when modal metadata and body teams differ", async () => {
    const acks: unknown[] = [];
    const saves: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      workspaceCredentialSettings: {
        async saveProviderApiKey(input: unknown) {
          saves.push(input);
        },
      },
    });

    await handlers.handleWorkspaceCredentialModalSubmission({
      ack: async (payload?: unknown) => {
        acks.push(payload);
      },
      body: { team: { id: "T2" }, user: { id: "UADMIN" } },
      client: {
        users: {
          info: async () => ({ user: { is_admin: true } }),
        },
      },
      logger: { error() {}, warn() {} },
      view: validWorkspaceCredentialView("T1"),
    } as never);

    expect(acks).toEqual([
      {
        errors: {
          workspace_credential_secret: "Slack workspace context does not match.",
        },
        response_action: "errors",
      },
    ]);
    expect(saves).toEqual([]);
  });

  it("routes app mentions through the TypeScript AgentRunner and posts a thread reply", async () => {
    const runner = {
      async run(invocation: unknown) {
        return {
          decision: { action: "respond", reason: "test" },
          message: `handled ${JSON.stringify(invocation)}`,
          toolResults: [],
        };
      },
    };
    const posts: unknown[] = [];
    const handlers = createAgentSlackHandlers(runner as never);

    await handlers.handleAppMention({
      body: { team_id: "T1" },
      client: {
        chat: {
          postMessage: async (payload: unknown) => {
            posts.push(payload);
            return {};
          },
        },
      },
      context: { botUserId: "B1" },
      event: {
        channel: "C1",
        text: "<@B1> assign this to <@U123>",
        ts: "1712345678.000100",
        user: "U1",
      },
      logger: { warn() {} },
    } as never);

    expect(posts).toEqual([
      expect.objectContaining({
        channel: "C1",
        text: expect.stringContaining('"text":"assign this to <@U123>"'),
        thread_ts: "1712345678.000100",
      }),
    ]);
  });

  it("queues app mentions instead of running the AgentRunner when a job queue is configured", async () => {
    let runs = 0;
    const runner = {
      async run() {
        runs += 1;
        return {
          decision: { action: "respond", reason: "test" },
          message: "handled",
          toolResults: [],
        };
      },
    };
    const queue = new MemorySlackAgentJobQueue();
    const handlers = createAgentSlackHandlers(runner as never, { agentJobQueue: queue });

    await handlers.handleAppMention({
      body: {
        authorizations: [
          {
            enterprise_id: "E1",
            is_enterprise_install: true,
            team_id: "T1",
          },
        ],
        event_id: "Ev1",
        team_id: "T1",
      },
      client: {
        chat: {
          postMessage: async () => ({}),
        },
      },
      context: { botUserId: "B1", retryNum: 1, retryReason: "http_timeout" },
      event: {
        channel: "C1",
        text: "<@B1> assign this to <@U123>",
        ts: "1712345678.000100",
        user: "U1",
      },
      logger: { info() {}, warn() {} },
    } as never);

    expect(runs).toBe(0);
    expect(queue.jobs).toEqual([
      expect.objectContaining({
        eventId: "Ev1",
        eventType: "app_mention",
        enterpriseId: "E1",
        isEnterpriseInstall: true,
        retryNum: "1",
        retryReason: "http_timeout",
        text: "assign this to <@U123>",
        threadTs: "1712345678.000100",
      }),
    ]);
  });

  it("uses resolved channel or workspace route for app mentions", async () => {
    const invocations: unknown[] = [];
    const runner = {
      async run(invocation: unknown) {
        invocations.push(invocation);
        return {
          decision: { action: "respond", reason: "forced_invocation" },
          message: "configured route",
          model: { id: "anthropic:claude-3-5-sonnet-latest", provider: "anthropic" },
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "translation-agent" },
        agentId: "configured-translator",
        modelId: "anthropic:claude-3-5-sonnet-latest",
        modelScope: "channel",
        scope: "channel",
      },
      threadAutoReplyEnabled: true,
    });
    const posts: unknown[] = [];
    const handlers = createAgentSlackHandlers(runner as never, { routingRepository: repository });

    await handlers.handleAppMention({
      body: { team_id: "T1" },
      client: {
        chat: {
          postMessage: async (payload: unknown) => {
            posts.push(payload);
            return {};
          },
        },
      },
      context: { botUserId: "B1" },
      event: {
        channel: "C1",
        text: "<@B1> hello",
        ts: "1712345678.000100",
        user: "U1",
      },
      logger: { info() {}, warn() {} },
    } as never);

    expect(invocations).toEqual([
      expect.objectContaining({
        modelId: "anthropic:claude-3-5-sonnet-latest",
      }),
    ]);
    expect(repository.activations).toEqual([
      expect.objectContaining({
        agentId: "configured-translator",
      }),
    ]);
    expect((repository.activations[0] as { modelId?: string }).modelId).toBeUndefined();
    expect(posts).toEqual([expect.objectContaining({ text: "configured route" })]);
  });

  it("does not fall back to keyword routing when repository routing has no configured agent", async () => {
    let runs = 0;
    const runner = {
      async run() {
        runs += 1;
        return {
          decision: { action: "respond", reason: "unrouted_invocation" },
          message: "unexpected fallback",
          toolResults: [],
        };
      },
    };
    const posts: unknown[] = [];
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      threadAutoReplyEnabled: true,
    });
    const handlers = createAgentSlackHandlers(runner as never, { routingRepository: repository });

    await handlers.handleAppMention({
      body: { team_id: "T1" },
      client: {
        chat: {
          postMessage: async (payload: unknown) => {
            posts.push(payload);
            return {};
          },
        },
      },
      context: { botUserId: "B1" },
      event: {
        channel: "C1",
        text: "<@B1> draw this",
        ts: "1712345678.000100",
        user: "U1",
      },
      logger: { warn() {} },
    } as never);

    expect(runs).toBe(0);
    expect(posts).toEqual([
      expect.objectContaining({
        text: "No agent is configured for this channel or workspace.",
      }),
    ]);
  });

  it("runs resolved agents without validating legacy specialist metadata", async () => {
    let runs = 0;
    const runner = {
      async run() {
        runs += 1;
        return {
          decision: { action: "respond", reason: "forced_invocation" },
          message: "configured route",
          toolResults: [],
        };
      },
    };
    const posts: unknown[] = [];
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "legacy-agent" },
        agentId: "configured-but-invalid",
        scope: "channel",
      },
      threadAutoReplyEnabled: true,
    });
    const handlers = createAgentSlackHandlers(runner as never, { routingRepository: repository });

    await handlers.handleAppMention({
      body: { team_id: "T1" },
      client: {
        chat: {
          postMessage: async (payload: unknown) => {
            posts.push(payload);
            return {};
          },
        },
      },
      context: { botUserId: "B1" },
      event: {
        channel: "C1",
        text: "<@B1> hello",
        ts: "1712345678.000100",
        user: "U1",
      },
      logger: { warn() {} },
    } as never);

    expect(runs).toBe(1);
    expect(posts).toEqual([expect.objectContaining({ text: "configured route" })]);
  });

  it("logs successful AgentRunner execution with provider context", async () => {
    const runner = {
      async run() {
        return {
          decision: { action: "respond", reason: "test" },
          message: "handled",
          model: { id: "google:gemini-2.5-flash", provider: "google" },
          toolResults: [],
        };
      },
    };
    const logs: unknown[] = [];
    const handlers = createAgentSlackHandlers(runner as never);

    await handlers.handleAppMention({
      body: { team_id: "T1" },
      client: {
        chat: {
          postMessage: async () => ({}),
        },
      },
      context: { botUserId: "B1" },
      event: {
        channel: "C1",
        text: "<@B1> hello",
        ts: "1712345678.000100",
        user: "U1",
      },
      logger: {
        info: (...args: unknown[]) => logs.push(args),
        warn() {},
      },
    } as never);

    expect(logs).toEqual([
      [
        "TypeScript AgentRunner completed Slack event.",
        expect.objectContaining({
          channelId: "C1",
          eventType: "app_mention",
          modelId: "google:gemini-2.5-flash",
          provider: "google",
          teamId: "T1",
        }),
      ],
    ]);
  });

  it("preserves leading non-bot mentions when stripping the app mention", async () => {
    const runner = {
      async run(invocation: unknown) {
        return {
          decision: { action: "respond", reason: "test" },
          message: JSON.stringify(invocation),
          toolResults: [],
        };
      },
    };
    const posts: unknown[] = [];
    const handlers = createAgentSlackHandlers(runner as never);

    await handlers.handleAppMention({
      body: { team_id: "T1" },
      client: {
        chat: {
          postMessage: async (payload: unknown) => {
            posts.push(payload);
            return {};
          },
        },
      },
      context: { botUserId: "B1" },
      event: {
        channel: "C1",
        text: "<@U123> please ask <@B1> about this",
        ts: "1712345678.000100",
        user: "U1",
      },
      logger: { warn() {} },
    } as never);

    expect(posts).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('"text":"<@U123> please ask about this"'),
      }),
    ]);
  });

  it("posts a fallback thread reply when AgentRunner fails", async () => {
    const runner = {
      async run() {
        throw new AgentRunnerExecutionError(
          { id: "google:gemini-2.5-flash-image", provider: "google" },
          new Error("provider failed"),
        );
      },
    };
    const posts: unknown[] = [];
    const errors: unknown[] = [];
    const handlers = createAgentSlackHandlers(runner as never);

    await handlers.handleAppMention({
      body: { team_id: "T1" },
      client: {
        chat: {
          postMessage: async (payload: unknown) => {
            posts.push(payload);
            return {};
          },
        },
      },
      context: { botUserId: "B1" },
      event: {
        channel: "C1",
        text: "<@B1> hello",
        ts: "1712345678.000100",
        user: "U1",
      },
      logger: {
        error: (...args: unknown[]) => {
          errors.push(args);
        },
        warn() {},
      },
    } as never);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual([
      "TypeScript AgentRunner failed while handling app_mention.",
      expect.objectContaining({
        modelId: "google:gemini-2.5-flash-image",
        provider: "google",
      }),
    ]);
    expect(posts).toEqual([
      expect.objectContaining({
        channel: "C1",
        text: "I couldn't complete that request. Please try again in a moment.",
        thread_ts: "1712345678.000100",
      }),
    ]);
  });

  it("uploads generated image media from generated media results", async () => {
    const runner = {
      async run() {
        return {
          decision: { action: "respond", reason: "test" },
          message: "Image generated by the native provider path.",
          structuredResult: {
            action: "generated",
            media: {
              dataBase64: Buffer.from("image-bytes").toString("base64"),
              kind: "image",
              mimeType: "image/png",
              modelId: "google:gemini-2.5-flash-image",
              prompt: "draw a diagram",
              provider: "google",
              status: "generated",
            },
            message: "Image generated by the native provider path.",
          },
          toolResults: [],
        };
      },
    };
    const posts: unknown[] = [];
    const uploads: unknown[] = [];
    const handlers = createAgentSlackHandlers(runner as never);

    await handlers.handleAppMention({
      body: { team_id: "T1" },
      client: {
        chat: {
          postMessage: async (payload: unknown) => {
            posts.push(payload);
            return {};
          },
        },
        filesUploadV2: async (payload: unknown) => {
          uploads.push(payload);
          return {};
        },
      },
      context: { botUserId: "B1" },
      event: {
        channel: "C1",
        text: "<@B1> draw a diagram",
        ts: "1712345678.000100",
        user: "U1",
      },
      logger: { error() {}, warn() {} },
    } as never);

    expect(posts).toEqual([]);
    expect(uploads).toEqual([
      expect.objectContaining({
        channel_id: "C1",
        filename: "generated-image.png",
        initial_comment: "Image generated by the native provider path.",
        thread_ts: "1712345678.000100",
      }),
    ]);
    expect((uploads[0] as { file: Buffer }).file.toString()).toBe("image-bytes");
  });

  it("uses image media types when naming generated Slack uploads", async () => {
    const uploads: unknown[] = [];

    await postAgentResult({
      channel: "C1",
      client: {
        chat: {
          postMessage: async () => ({ ok: true }),
        },
        conversations: {
          replies: async () => ({ ok: true }),
        },
        filesUploadV2: async (payload: unknown) => {
          uploads.push(payload);
          return { files: [], ok: true };
        },
      } as never,
      logger: { info() {} },
      result: {
        decision: { action: "respond", reason: "test" },
        message: "Image generated by the native provider path.",
        structuredResult: {
          action: "generated",
          media: {
            dataBase64: Buffer.from("webp-bytes").toString("base64"),
            kind: "image",
            mimeType: "image/webp",
            modelId: "openai:gpt-image-1.5",
            prompt: "draw a diagram",
            provider: "openai",
            status: "generated",
          },
          message: "Image generated by the native provider path.",
        },
        toolResults: [],
      },
      text: "Image generated by the native provider path.",
      threadTs: "1712345678.000100",
    });

    expect(uploads).toEqual([
      expect.objectContaining({
        filename: "generated-image.webp",
      }),
    ]);
  });

  it("posts native video operation handoffs when generated media bytes are pending", async () => {
    const runner = {
      async run() {
        return {
          decision: { action: "respond", reason: "test" },
          message: "Video generation started by the native provider path.",
          structuredResult: {
            action: "in_progress",
            media: {
              aspectRatio: "16:9",
              durationSeconds: 8,
              kind: "video",
              modelId: "google:veo-3.1-fast-generate-001",
              operationName: "operations/video-123",
              prompt: "make a launch clip",
              provider: "google",
              status: "in_progress",
            },
            message: "Video generation started by the native provider path.",
          },
          toolResults: [],
        };
      },
    };
    const posts: unknown[] = [];
    const handlers = createAgentSlackHandlers(runner as never);

    await handlers.handleAppMention({
      body: { team_id: "T1" },
      client: {
        chat: {
          postMessage: async (payload: unknown) => {
            posts.push(payload);
            return {};
          },
        },
      },
      context: { botUserId: "B1" },
      event: {
        channel: "C1",
        text: "<@B1> make a launch clip",
        ts: "1712345678.000100",
        user: "U1",
      },
      logger: { error() {}, warn() {} },
    } as never);

    expect(posts).toEqual([
      expect.objectContaining({
        channel: "C1",
        text: "Video generation started by the native provider path.\noperations/video-123",
        thread_ts: "1712345678.000100",
      }),
    ]);
  });

  it("routes active thread follow-up messages through the AgentRunner", async () => {
    const invocations: unknown[] = [];
    const runner = {
      async run(invocation: unknown) {
        invocations.push(invocation);
        return {
          decision: { action: "respond", reason: "test" },
          message: "thread reply",
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "assistant-agent" },
        agentId: "assistant",
        scope: "thread",
      },
      thread: {
        agent_id: "assistant",
        root_message_ts: "1712345678.000100",
        status: "active",
      },
      threadAutoReplyEnabled: true,
    });
    const posts: unknown[] = [];
    const handlers = createAgentSlackHandlers(runner as never, { routingRepository: repository });

    await handlers.handleMessage({
      body: { team_id: "T1" },
      client: {
        chat: {
          postMessage: async (payload: unknown) => {
            posts.push(payload);
            return {};
          },
        },
        conversations: {
          replies: async () => ({
            messages: [{ text: "root text" }, { text: "follow-up" }],
          }),
        },
      },
      event: {
        channel: "C1",
        text: "follow-up",
        thread_ts: "1712345678.000100",
        ts: "1712345678.000200",
        user: "U1",
      },
      logger: { error() {}, warn() {} },
    } as never);

    expect(invocations).toEqual([
      expect.objectContaining({
        channelId: "C1",
        teamId: "T1",
        text: "follow-up",
        threadMessages: ["root text", "follow-up"],
        threadTs: "1712345678.000100",
      }),
    ]);
    expect(repository.activations).toEqual([
      expect.objectContaining({
        agentId: "assistant",
        lastMessageTs: "1712345678.000200",
        threadTs: "1712345678.000100",
      }),
    ]);
    expect(posts).toEqual([
      expect.objectContaining({
        channel: "C1",
        text: "thread reply",
        thread_ts: "1712345678.000100",
      }),
    ]);
  });

  it("adds ephemeral audio transcripts to active thread follow-up invocations", async () => {
    const invocations: unknown[] = [];
    const runner = {
      async run(invocation: unknown) {
        invocations.push(invocation);
        return {
          decision: { action: "respond", reason: "test" },
          message: "thread reply",
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "assistant-agent" },
        agentId: "assistant",
        scope: "thread",
      },
      thread: {
        agent_id: "assistant",
        root_message_ts: "1712345678.000100",
        status: "active",
      },
      threadAutoReplyEnabled: true,
    });
    const posts: unknown[] = [];
    const handlers = createAgentSlackHandlers(runner as never, {
      audioFetchFn: async () => new Response(new Uint8Array([1, 2, 3])),
      audioTranscriptionGateway: {
        async transcribe(request) {
          expect(request.audio).toEqual(new Uint8Array([1, 2, 3]));
          return {
            model: "google:speech-to-text-latest-long",
            provider: "google",
            text: "音声内容",
          };
        },
      },
      routingRepository: repository,
    });

    await handlers.handleMessage({
      body: { team_id: "T1" },
      client: {
        chat: {
          postMessage: async (payload: unknown) => {
            posts.push(payload);
            return {};
          },
        },
        conversations: {
          replies: async () => ({
            messages: [
              { text: "root text", ts: "1712345678.000100" },
              {
                files: [
                  {
                    id: "F1",
                    mimetype: "audio/mpeg",
                    name: "voice.mp3",
                    size: 3,
                    url_private_download:
                      "https://files.slack.com/files-pri/T-F1/download/voice.mp3",
                  },
                ],
                text: "",
                ts: "1712345678.000200",
              },
            ],
          }),
        },
        token: "xoxb-token",
      },
      event: {
        channel: "C1",
        files: [
          {
            id: "F1",
            mimetype: "audio/mpeg",
            name: "voice.mp3",
            size: 3,
            url_private_download: "https://files.slack.com/files-pri/T-F1/download/voice.mp3",
          },
        ],
        text: "",
        thread_ts: "1712345678.000100",
        ts: "1712345678.000200",
        user: "U1",
      },
      logger: { error() {}, warn() {} },
    } as never);

    expect(invocations).toEqual([
      expect.objectContaining({
        text: "",
        threadMessages: ["root text"],
        transientAttachments: [
          {
            filename: "voice.mp3",
            id: "F1",
            kind: "audio",
            mediaType: "audio/mpeg",
            messageTs: "1712345678.000200",
            transcript: "音声内容",
          },
        ],
      }),
    ]);
    expect(posts).toEqual([
      expect.objectContaining({
        text: "thread reply",
      }),
    ]);
  });

  it("processes queued follow-up jobs through the AgentRunner and posts the result", async () => {
    const invocations: unknown[] = [];
    const runner = {
      async run(invocation: unknown) {
        invocations.push(invocation);
        return {
          decision: { action: "respond", reason: "test" },
          message: "thread reply",
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "assistant-agent" },
        agentId: "assistant",
        scope: "thread",
      },
      thread: {
        agent_id: "assistant",
        root_message_ts: "1712345678.000100",
        status: "active",
      },
      threadAutoReplyEnabled: true,
    });
    const posts: unknown[] = [];

    await processSlackAgentJob(
      {
        channelId: "C1",
        eventType: "message_follow_up",
        messageTs: "1712345678.000200",
        teamId: "T1",
        text: "follow-up",
        threadTs: "1712345678.000100",
        userId: "U1",
      },
      {
        client: {
          chat: {
            postMessage: async (payload: unknown) => {
              posts.push(payload);
              return {};
            },
          },
          conversations: {
            replies: async () => ({
              messages: [
                {
                  files: [
                    {
                      id: "F-root",
                      mimetype: "audio/mpeg",
                      name: "root-voice.mp3",
                      size: 3,
                      ts: "1712345678.000100",
                      url_private_download:
                        "https://files.slack.com/files-pri/T-F-root/download/root-voice.mp3",
                    },
                  ],
                  text: "root text",
                  ts: "1712345678.000100",
                },
                { text: "follow-up", ts: "1712345678.000200" },
              ],
            }),
          },
          filesUploadV2: async () => ({}),
          token: "xoxb-token",
        } as never,
        audioFetchFn: async () => new Response(new Uint8Array([4, 5, 6])),
        audioTranscriptionGateway: {
          async transcribe(request) {
            expect(request.audio).toEqual(new Uint8Array([4, 5, 6]));
            return {
              model: "google:speech-to-text-latest-long",
              provider: "google",
              text: "前の音声",
            };
          },
        },
        logger: { error() {}, info() {}, warn() {} },
        routingRepository: repository,
        runner: runner as never,
      },
    );

    expect(invocations).toEqual([
      expect.objectContaining({
        channelId: "C1",
        text: "follow-up",
        threadMessages: ["root text", "follow-up"],
        transientAttachments: [
          {
            filename: "root-voice.mp3",
            id: "F-root",
            kind: "audio",
            mediaType: "audio/mpeg",
            messageTs: "1712345678.000100",
            transcript: "前の音声",
          },
        ],
      }),
    ]);
    expect(repository.activations).toEqual([
      expect.objectContaining({
        agentId: "assistant",
        lastMessageTs: "1712345678.000200",
      }),
    ]);
    expect(posts).toEqual([
      expect.objectContaining({
        channel: "C1",
        text: "thread reply",
        thread_ts: "1712345678.000100",
      }),
    ]);
  });

  it("sets Slack assistant thread status when queued app mention processing starts", async () => {
    const statuses: unknown[] = [];
    const runner = {
      async run() {
        return {
          decision: { confidence: 0.8, reason: "test", specialist: "assistant" },
          message: "thread reply",
          toolResults: [],
        };
      },
    };
    const posts: unknown[] = [];

    await processSlackAgentJob(
      {
        channelId: "C1",
        eventType: "app_mention",
        messageTs: "1712345678.000100",
        teamId: "T1",
        text: "hello",
        threadTs: "1712345678.000100",
        userId: "U1",
      },
      {
        client: {
          assistant: {
            threads: {
              setStatus: async (payload: unknown) => {
                statuses.push(payload);
                return { ok: true };
              },
            },
          },
          chat: {
            postMessage: async (payload: unknown) => {
              posts.push(payload);
              return {};
            },
          },
          conversations: { replies: async () => ({ messages: [] }) },
          filesUploadV2: async () => ({}),
        } as never,
        logger: { error() {}, info() {}, warn() {} },
        runner: runner as never,
      },
    );

    expect(statuses).toEqual([
      {
        channel_id: "C1",
        status: "is working on your request...",
        thread_ts: "1712345678.000100",
      },
    ]);
    expect(posts).toEqual([
      expect.objectContaining({
        channel: "C1",
        text: "thread reply",
        thread_ts: "1712345678.000100",
      }),
    ]);
  });

  it("continues queued jobs when Slack assistant thread status fails", async () => {
    const warnings: unknown[] = [];
    const runner = {
      async run() {
        return {
          decision: { confidence: 0.8, reason: "test", specialist: "assistant" },
          message: "thread reply",
          toolResults: [],
        };
      },
    };
    const posts: unknown[] = [];

    await processSlackAgentJob(
      {
        channelId: "C1",
        eventType: "app_mention",
        messageTs: "1712345678.000100",
        teamId: "T1",
        text: "hello",
        threadTs: "1712345678.000100",
        userId: "U1",
      },
      {
        client: {
          assistant: {
            threads: {
              setStatus: async () => {
                throw new Error("status failed");
              },
            },
          },
          chat: {
            postMessage: async (payload: unknown) => {
              posts.push(payload);
              return {};
            },
          },
          conversations: { replies: async () => ({ messages: [] }) },
          filesUploadV2: async () => ({}),
        } as never,
        logger: {
          error() {},
          info() {},
          warn(message: unknown, metadata: unknown) {
            warnings.push({ message, metadata });
          },
        },
        runner: runner as never,
      },
    );

    expect(warnings).toEqual([
      expect.objectContaining({
        message: "Failed to set Slack assistant thread status.",
      }),
    ]);
    expect(posts).toEqual([
      expect.objectContaining({
        text: "thread reply",
      }),
    ]);
  });

  it("does not set Slack assistant thread status for queued follow-ups without a resolved route", async () => {
    const statuses: unknown[] = [];
    let runs = 0;
    const runner = {
      async run() {
        runs += 1;
        return {
          decision: { action: "respond", reason: "test" },
          message: "thread reply",
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      thread: {
        agent_id: "assistant",
        root_message_ts: "1712345678.000100",
        status: "active",
      },
      threadAutoReplyEnabled: true,
    });

    await processSlackAgentJob(
      {
        channelId: "C1",
        eventType: "message_follow_up",
        messageTs: "1712345678.000200",
        teamId: "T1",
        text: "follow-up",
        threadTs: "1712345678.000100",
        userId: "U1",
      },
      {
        client: {
          assistant: {
            threads: {
              setStatus: async (payload: unknown) => {
                statuses.push(payload);
                return { ok: true };
              },
            },
          },
          chat: { postMessage: async () => ({}) },
          conversations: { replies: async () => ({ messages: [] }) },
          filesUploadV2: async () => ({}),
        } as never,
        logger: { error() {}, info() {}, warn() {} },
        routingRepository: repository,
        runner: runner as never,
      },
    );

    expect(statuses).toEqual([]);
    expect(runs).toBe(0);
  });

  it("rethrows queued AgentRunner failures before the final worker attempt", async () => {
    const runner = {
      async run() {
        throw new Error("provider timeout");
      },
    };
    const posts: unknown[] = [];

    await expect(
      processSlackAgentJob(
        {
          channelId: "C1",
          eventType: "app_mention",
          messageTs: "1712345678.000100",
          teamId: "T1",
          text: "hello",
          threadTs: "1712345678.000100",
          userId: "U1",
        },
        {
          client: {
            chat: {
              postMessage: async (payload: unknown) => {
                posts.push(payload);
                return {};
              },
            },
            conversations: { replies: async () => ({ messages: [] }) },
            filesUploadV2: async () => ({}),
          } as never,
          logger: { error() {}, info() {}, warn() {} },
          retryContext: { attempts: 3, attemptsMade: 0 },
          runner: runner as never,
        },
      ),
    ).rejects.toThrow("provider timeout");
    expect(posts).toEqual([]);
  });

  it("posts a fallback for queued AgentRunner failures on the final worker attempt", async () => {
    const runner = {
      async run() {
        throw new Error("provider timeout");
      },
    };
    const posts: unknown[] = [];

    await processSlackAgentJob(
      {
        channelId: "C1",
        eventType: "app_mention",
        messageTs: "1712345678.000100",
        teamId: "T1",
        text: "hello",
        threadTs: "1712345678.000100",
        userId: "U1",
      },
      {
        client: {
          chat: {
            postMessage: async (payload: unknown) => {
              posts.push(payload);
              return {};
            },
          },
          conversations: { replies: async () => ({ messages: [] }) },
          filesUploadV2: async () => ({}),
        } as never,
        logger: { error() {}, info() {}, warn() {} },
        retryContext: { attempts: 3, attemptsMade: 2 },
        runner: runner as never,
      },
    );

    expect(posts).toEqual([
      expect.objectContaining({
        channel: "C1",
        text: "I couldn't complete that request. Please try again in a moment.",
      }),
    ]);
  });

  it("does not route follow-up messages when thread auto-reply is disabled", async () => {
    let runs = 0;
    const runner = {
      async run() {
        runs += 1;
        return {
          decision: { action: "respond", reason: "test" },
          message: "thread reply",
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      thread: { agent_id: "assistant", status: "active" },
      threadAutoReplyEnabled: false,
    });
    const handlers = createAgentSlackHandlers(runner as never, { routingRepository: repository });

    await handlers.handleMessage({
      body: { team_id: "T1" },
      client: { chat: { postMessage: async () => ({}) } },
      event: {
        channel: "C1",
        text: "follow-up",
        thread_ts: "1712345678.000100",
        ts: "1712345678.000200",
        user: "U1",
      },
      logger: { warn() {} },
    } as never);

    expect(runs).toBe(0);
  });

  it("does not route follow-up messages when configured thread route is unavailable", async () => {
    let runs = 0;
    const runner = {
      async run() {
        runs += 1;
        return {
          decision: { action: "respond", reason: "test" },
          message: "thread reply",
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      thread: { agent_id: "assistant", status: "active" },
      threadAutoReplyEnabled: true,
    });
    const handlers = createAgentSlackHandlers(runner as never, { routingRepository: repository });

    await handlers.handleMessage({
      body: { team_id: "T1" },
      client: { chat: { postMessage: async () => ({}) } },
      event: {
        channel: "C1",
        text: "follow-up",
        thread_ts: "1712345678.000100",
        ts: "1712345678.000200",
        user: "U1",
      },
      logger: { warn() {} },
    } as never);

    expect(runs).toBe(0);
  });

  it("uses the persisted thread agent for follow-up routing", async () => {
    const invocations: unknown[] = [];
    const runner = {
      async run(invocation: unknown) {
        invocations.push(invocation);
        return {
          decision: { action: "respond", reason: "forced_invocation" },
          message: "translated follow-up",
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "translation-agent" },
        agentId: "translation",
        scope: "thread",
      },
      thread: {
        agent_id: "translation",
        root_message_ts: "1712345678.000100",
        status: "active",
      },
      threadAutoReplyEnabled: true,
    });
    const handlers = createAgentSlackHandlers(runner as never, { routingRepository: repository });

    await handlers.handleMessage({
      body: { team_id: "T1" },
      client: {
        chat: { postMessage: async () => ({}) },
        conversations: { replies: async () => ({ messages: [] }) },
      },
      event: {
        channel: "C1",
        text: "also this",
        thread_ts: "1712345678.000100",
        ts: "1712345678.000200",
        user: "U1",
      },
      logger: { error() {}, warn() {} },
    } as never);

    expect(invocations).toHaveLength(1);
  });

  it("prefers resolved thread route and model for follow-up routing", async () => {
    const invocations: unknown[] = [];
    const runner = {
      async run(invocation: unknown) {
        invocations.push(invocation);
        return {
          decision: { action: "respond", reason: "forced_invocation" },
          message: "researched follow-up",
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "research-agent" },
        agentId: "research-agent",
        modelId: "google:gemini-2.5-flash",
        modelScope: "thread",
        scope: "thread",
      },
      thread: {
        agent_id: "translation",
        root_message_ts: "1712345678.000100",
        status: "active",
      },
      threadAutoReplyEnabled: true,
    });
    const handlers = createAgentSlackHandlers(runner as never, { routingRepository: repository });

    await handlers.handleMessage({
      body: { team_id: "T1" },
      client: {
        chat: { postMessage: async () => ({}) },
        conversations: { replies: async () => ({ messages: [] }) },
      },
      event: {
        channel: "C1",
        text: "also this",
        thread_ts: "1712345678.000100",
        ts: "1712345678.000200",
        user: "U1",
      },
      logger: { error() {}, warn() {} },
    } as never);

    expect(invocations).toEqual([
      expect.objectContaining({
        modelId: "google:gemini-2.5-flash",
      }),
    ]);
    expect(repository.activations).toEqual([
      expect.objectContaining({
        agentId: "research-agent",
        modelId: "google:gemini-2.5-flash",
      }),
    ]);
  });

  it("does not reuse a stale persisted thread model when route has no model", async () => {
    const invocations: unknown[] = [];
    const runner = {
      async run(invocation: unknown) {
        invocations.push(invocation);
        return {
          decision: { action: "respond", reason: "forced_invocation" },
          message: "follow-up",
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "assistant-agent" },
        agentId: "assistant",
        scope: "thread",
      },
      thread: {
        agent_id: "assistant",
        model_id: "stale-model",
        root_message_ts: "1712345678.000100",
        status: "active",
      },
      threadAutoReplyEnabled: true,
    });
    const handlers = createAgentSlackHandlers(runner as never, { routingRepository: repository });

    await handlers.handleMessage({
      body: { team_id: "T1" },
      client: {
        chat: { postMessage: async () => ({}) },
        conversations: { replies: async () => ({ messages: [] }) },
      },
      event: {
        channel: "C1",
        text: "also this",
        thread_ts: "1712345678.000100",
        ts: "1712345678.000200",
        user: "U1",
      },
      logger: { error() {}, warn() {} },
    } as never);

    expect(invocations).toEqual([expect.not.objectContaining({ modelId: "stale-model" })]);
    expect(repository.activations).toEqual([
      expect.not.objectContaining({ modelId: "stale-model" }),
    ]);
  });

  it("translates flag reactions through the AgentRunner and replies in-thread", async () => {
    const invocations: unknown[] = [];
    const runner = {
      async run(invocation: unknown) {
        invocations.push(invocation);
        return {
          decision: { action: "respond", reason: "test" },
          message: "こんにちは",
          toolResults: [],
        };
      },
    };
    const posts: unknown[] = [];
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "translation-agent" },
        agentId: "translation",
        modelId: "anthropic:claude-3-5-sonnet-latest",
        modelScope: "channel",
        scope: "channel",
      },
      threadAutoReplyEnabled: true,
    });
    const handlers = createAgentSlackHandlers(runner as never, { routingRepository: repository });

    await handlers.handleReactionAdded({
      body: { team_id: "T1" },
      client: {
        chat: {
          postMessage: async (payload: unknown) => {
            posts.push(payload);
            return {};
          },
        },
        conversations: {
          history: async () => ({
            messages: [
              {
                text: "hello",
                thread_ts: "1712345678.000100",
                ts: "1712345678.000100",
              },
            ],
          }),
        },
      },
      event: {
        item: { channel: "C1", ts: "1712345678.000100", type: "message" },
        reaction: "flag-jp",
        user: "U1",
      },
      logger: { error() {}, warn() {} },
    } as never);

    expect(invocations).toEqual([
      expect.objectContaining({
        channelId: "C1",
        modelId: "anthropic:claude-3-5-sonnet-latest",
        teamId: "T1",
        text: "Translate the following Slack message to ja:\n\nhello",
        threadTs: "1712345678.000100",
        userId: "U1",
      }),
    ]);
    expect(posts).toEqual([
      expect.objectContaining({
        channel: "C1",
        text: "こんにちは",
        thread_ts: "1712345678.000100",
      }),
    ]);
  });

  it("does not translate reactions in disabled channels", async () => {
    let runs = 0;
    const runner = {
      async run() {
        runs += 1;
        return {
          decision: { action: "respond", reason: "test" },
          message: "こんにちは",
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: false,
      threadAutoReplyEnabled: true,
    });
    const handlers = createAgentSlackHandlers(runner as never, { routingRepository: repository });

    await handlers.handleReactionAdded({
      body: { team_id: "T1" },
      client: {
        chat: { postMessage: async () => ({}) },
        conversations: { history: async () => ({ messages: [{ text: "hello" }] }) },
      },
      event: {
        item: { channel: "C1", ts: "1712345678.000100", type: "message" },
        reaction: "flag-jp",
        user: "U1",
      },
      logger: { error() {}, warn() {} },
    } as never);

    expect(runs).toBe(0);
  });

  it("translates reactions through resolved agents without specialist validation", async () => {
    let runs = 0;
    const runner = {
      async run() {
        runs += 1;
        return {
          decision: { action: "respond", reason: "test" },
          message: "こんにちは",
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "legacy-agent" },
        agentId: "bad-agent",
        modelId: "anthropic:claude-3-5-sonnet-latest",
        modelScope: "channel",
        scope: "channel",
      },
      threadAutoReplyEnabled: true,
    });
    const handlers = createAgentSlackHandlers(runner as never, { routingRepository: repository });

    await handlers.handleReactionAdded({
      body: { team_id: "T1" },
      client: {
        chat: { postMessage: async () => ({}) },
        conversations: { history: async () => ({ messages: [{ text: "hello" }] }) },
      },
      event: {
        item: { channel: "C1", ts: "1712345678.000100", type: "message" },
        reaction: "flag-jp",
        user: "U1",
      },
      logger: { error() {}, warn() {} },
    } as never);

    expect(runs).toBe(1);
  });

  it("posts source-text errors for reaction routes before invoking the runner", async () => {
    const posts: unknown[] = [];
    const runner = {
      async run() {
        throw new Error("Unexpected runner call.");
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "legacy-agent" },
        agentId: "bad-agent",
        scope: "channel",
      },
      threadAutoReplyEnabled: true,
    });
    const handlers = createAgentSlackHandlers(runner as never, { routingRepository: repository });

    await handlers.handleReactionAdded({
      body: { team_id: "T1" },
      client: {
        chat: {
          postMessage: async (payload: unknown) => {
            posts.push(payload);
            return {};
          },
        },
        conversations: { history: async () => ({ messages: [{ text: "" }] }) },
      },
      event: {
        item: { channel: "C1", ts: "1712345678.000100", type: "message" },
        reaction: "flag-jp",
        user: "U1",
      },
      logger: { error() {}, warn() {} },
    } as never);

    expect(posts).toEqual([
      expect.objectContaining({
        text: "I couldn't read text from the reacted message.",
      }),
    ]);
  });

  it("translates reactions through any resolved agent route", async () => {
    let runs = 0;
    const runner = {
      async run() {
        runs += 1;
        return {
          decision: { action: "respond", reason: "test" },
          message: "こんにちは",
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "assistant-agent" },
        agentId: "assistant",
        modelId: "anthropic:claude-3-5-sonnet-latest",
        modelScope: "channel",
        scope: "channel",
      },
      threadAutoReplyEnabled: true,
    });
    const handlers = createAgentSlackHandlers(runner as never, { routingRepository: repository });

    await handlers.handleReactionAdded({
      body: { team_id: "T1" },
      client: {
        chat: { postMessage: async () => ({}) },
        conversations: { history: async () => ({ messages: [{ text: "hello" }] }) },
      },
      event: {
        item: { channel: "C1", ts: "1712345678.000100", type: "message" },
        reaction: "flag-jp",
        user: "U1",
      },
      logger: { error() {}, warn() {} },
    } as never);

    expect(runs).toBe(1);
  });

  it("does not translate reactions without repository-backed channel policy", async () => {
    let runs = 0;
    const runner = {
      async run() {
        runs += 1;
        return {
          decision: { action: "respond", reason: "test" },
          message: "こんにちは",
          toolResults: [],
        };
      },
    };
    const handlers = createAgentSlackHandlers(runner as never);

    await handlers.handleReactionAdded({
      body: { team_id: "T1" },
      client: {
        chat: { postMessage: async () => ({}) },
        conversations: { history: async () => ({ messages: [{ text: "hello" }] }) },
      },
      event: {
        item: { channel: "C1", ts: "1712345678.000100", type: "message" },
        reaction: "flag-jp",
        user: "U1",
      },
      logger: { error() {}, warn() {} },
    } as never);

    expect(runs).toBe(0);
  });
});

function salesforceConnectionHomeFixture() {
  return {
    buildStartUrl(input: { salesforceOrgId: string }) {
      return `https://app.example.com/oauth/salesforce/start?org=${input.salesforceOrgId}`;
    },
    repository: {
      async listSalesforceAuthConfigs(): Promise<JsonObject[]> {
        return [
          {
            default_scopes: ["api", "refresh_token"],
            oauth_client_id: "salesforce-client",
            redirect_uri: "https://app.example.com/oauth/salesforce/callback",
            salesforce_my_domain_host: "example.my.salesforce.com",
            salesforce_org_id: "00DORG",
            salesforce_org_name: "Salesforce Production",
            status: "active",
            team_id: "T1",
          },
        ];
      },
      async listSalesforceConnections(): Promise<JsonObject[]> {
        return [];
      },
    },
  };
}

function validSalesforcePdfWorkflowSetting(): JsonObject {
  return {
    action: "quote_pdf",
    allowed_approval_statuses: [],
    allowed_record_type_ids: ["012000000000001AAA"],
    allowed_record_type_names: [],
    allowed_stages: ["Proposal"],
    allowed_statuses: [],
    approval_status_field: null,
    attach_to: "quote",
    created_at: "2026-05-13T00:00:00.000Z",
    enabled: true,
    field_mapping: { customerName: "Account.Name" },
    include_ai_summary: false,
    required_fields: ["AccountId"],
    require_confirmation_before_attach: true,
    salesforce_org_id: "00DORG",
    slack_channel_allowlist: [],
    slack_user_group_allowlist: [],
    team_id: "T1",
    template_id: "quote_v1",
    updated_at: "2026-05-13T00:00:00.000Z",
  };
}

function validSalesforcePdfWorkflowView(
  input: {
    action?: string;
    allowedApprovalStatuses?: string;
    approvalStatusField?: string;
    attachTo?: string;
    includeAiSummary?: string;
    templateId?: string;
  } = {},
): unknown {
  return {
    id: "VIEW1",
    private_metadata: JSON.stringify({
      action: input.action ?? "quote_pdf",
      salesforceOrgId: "00DORG",
      teamId: "T1",
    }),
    state: {
      values: {
        salesforce_pdf_workflow_allowed_stages: {
          allowed_stages: { value: "Proposal, Negotiation" },
        },
        salesforce_pdf_workflow_allowed_statuses: {
          allowed_statuses: { value: "" },
        },
        salesforce_pdf_workflow_ai_summary: {
          include_ai_summary: { selected_option: { value: input.includeAiSummary ?? "false" } },
        },
        salesforce_pdf_workflow_approval_field: {
          approval_status_field: { value: input.approvalStatusField ?? "" },
        },
        salesforce_pdf_workflow_approval_statuses: {
          allowed_approval_statuses: { value: input.allowedApprovalStatuses ?? "" },
        },
        salesforce_pdf_workflow_attach_to: {
          attach_to: { selected_option: { value: input.attachTo ?? "quote" } },
        },
        salesforce_pdf_workflow_confirmation: {
          require_confirmation: { selected_option: { value: "true" } },
        },
        salesforce_pdf_workflow_enabled: {
          enabled: { selected_option: { value: "true" } },
        },
        salesforce_pdf_workflow_field_mapping: {
          field_mapping: { value: '{"customerName":"Account.Name"}' },
        },
        salesforce_pdf_workflow_record_types: {
          record_types: { value: "New Business" },
        },
        salesforce_pdf_workflow_required_fields: {
          required_fields: { value: "AccountId, Amount" },
        },
        salesforce_pdf_workflow_template: {
          template_id: { value: input.templateId ?? "quote_v1" },
        },
      },
    },
  };
}

function validWorkspaceCredentialView(teamId: string): unknown {
  return {
    hash: "HASH1",
    id: "VIEW1",
    private_metadata: teamId,
    state: {
      values: {
        workspace_credential_base_url: {
          base_url: { value: "https://proxy.example.com/v1" },
        },
        workspace_credential_provider: {
          provider_kind: { selected_option: { value: "openai" } },
        },
        workspace_credential_secret: {
          api_key: { value: "sk-test" },
        },
      },
    },
  };
}

class MemoryRoutingRepository {
  readonly activations: unknown[] = [];

  constructor(
    private readonly options: {
      channelEnabled: boolean;
      route?: {
        agent: JsonObject;
        agentId: string;
        modelId?: string;
        modelScope?: string;
        scope: string;
      };
      thread?: JsonObject;
      threadAutoReplyEnabled: boolean;
    },
  ) {}

  async activateThreadAgent(input: unknown): Promise<JsonObject> {
    this.activations.push(input);
    return {};
  }

  async findSlackThread(): Promise<JsonObject | undefined> {
    return this.options.thread;
  }

  async isChannelEnabled(): Promise<boolean> {
    return this.options.channelEnabled;
  }

  async isThreadAutoReplyEnabled(): Promise<boolean> {
    return this.options.threadAutoReplyEnabled;
  }

  async resolveAgent(): Promise<
    | {
        agent: JsonObject;
        agentId: string;
        modelId?: string;
        modelScope?: string;
        scope: string;
      }
    | undefined
  > {
    return this.options.route;
  }
}

class MemorySlackAgentJobQueue {
  readonly jobs: unknown[] = [];

  async close(): Promise<void> {}

  async enqueue(job: unknown): Promise<{ deduplicated: boolean; jobId: string }> {
    this.jobs.push(job);
    return { deduplicated: false, jobId: "job-1" };
  }
}
