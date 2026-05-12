import { describe, expect, it } from "vite-plus/test";

import { AgentRunnerExecutionError } from "../../src/agents/runner.js";
import type { JsonObject } from "../../src/infrastructure/postgres/jsonDocumentRepository.js";
import { createAgentSlackHandlers } from "../../src/slack/agentHandlers.js";

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
          decision: { confidence: 0.5, reason: "test", specialist: "assistant" },
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

  it("logs successful AgentRunner execution with provider and specialist context", async () => {
    const runner = {
      async run() {
        return {
          decision: { confidence: 0.5, reason: "test", specialist: "assistant" },
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
          specialist: "assistant",
          teamId: "T1",
        }),
      ],
    ]);
  });

  it("preserves leading non-bot mentions when stripping the app mention", async () => {
    const runner = {
      async run(invocation: unknown) {
        return {
          decision: { confidence: 0.5, reason: "test", specialist: "assistant" },
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
          "image_generation",
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
        specialist: "image_generation",
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

  it("uploads generated image media from native specialist results", async () => {
    const runner = {
      async run() {
        return {
          decision: { confidence: 0.8, reason: "test", specialist: "image_generation" },
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

  it("posts native video operation handoffs when generated media bytes are pending", async () => {
    const runner = {
      async run() {
        return {
          decision: { confidence: 0.8, reason: "test", specialist: "video_generation" },
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
          decision: { confidence: 0.8, reason: "test", specialist: "assistant" },
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
        specialist: "assistant",
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

  it("does not route follow-up messages when thread auto-reply is disabled", async () => {
    let runs = 0;
    const runner = {
      async run() {
        runs += 1;
        return {
          decision: { confidence: 0.8, reason: "test", specialist: "assistant" },
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

  it("uses the persisted thread agent for follow-up routing", async () => {
    const invocations: unknown[] = [];
    const runner = {
      async run(invocation: unknown) {
        invocations.push(invocation);
        return {
          decision: { confidence: 1, reason: "forced_invocation", specialist: "translation" },
          message: "translated follow-up",
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
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

    expect(invocations).toEqual([expect.objectContaining({ specialist: "translation" })]);
  });

  it("translates flag reactions through the AgentRunner and replies in-thread", async () => {
    const invocations: unknown[] = [];
    const runner = {
      async run(invocation: unknown) {
        invocations.push(invocation);
        return {
          decision: { confidence: 0.8, reason: "test", specialist: "translation" },
          message: "こんにちは",
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
        specialist: "translation",
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
          decision: { confidence: 0.8, reason: "test", specialist: "translation" },
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

  it("does not translate reactions without repository-backed channel policy", async () => {
    let runs = 0;
    const runner = {
      async run() {
        runs += 1;
        return {
          decision: { confidence: 0.8, reason: "test", specialist: "translation" },
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
}
