import { describe, expect, it } from "vite-plus/test";

import { AgentRunnerExecutionError } from "../../src/agents/runner.js";
import type { JsonObject } from "../../src/infrastructure/postgres/jsonDocumentRepository.js";
import { createAgentSlackHandlers, processSlackAgentJob } from "../../src/slack/agentHandlers.js";

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

  it("queues app mentions instead of running the AgentRunner when a job queue is configured", async () => {
    let runs = 0;
    const runner = {
      async run() {
        runs += 1;
        return {
          decision: { confidence: 0.5, reason: "test", specialist: "assistant" },
          message: "handled",
          toolResults: [],
        };
      },
    };
    const queue = new MemorySlackAgentJobQueue();
    const handlers = createAgentSlackHandlers(runner as never, { agentJobQueue: queue });

    await handlers.handleAppMention({
      body: { event_id: "Ev1", team_id: "T1" },
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
          decision: { confidence: 1, reason: "forced_invocation", specialist: "translation" },
          message: "configured route",
          model: { id: "anthropic:claude-3-5-sonnet-latest", provider: "anthropic" },
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { specialist: "translation" },
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
        specialist: "translation",
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
          decision: { confidence: 0.8, reason: "keyword_match", specialist: "image_generation" },
          message: "keyword fallback",
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

  it("does not run a misconfigured resolved agent", async () => {
    let runs = 0;
    const runner = {
      async run() {
        runs += 1;
        return {
          decision: { confidence: 1, reason: "forced_invocation", specialist: "assistant" },
          message: "should not run",
          toolResults: [],
        };
      },
    };
    const posts: unknown[] = [];
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { specialist: "not_a_specialist" },
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

    expect(runs).toBe(0);
    expect(posts).toEqual([
      expect.objectContaining({
        text: "The configured agent is not runnable. Please check the agent settings.",
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
      route: {
        agent: { specialist: "assistant" },
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

  it("processes queued follow-up jobs through the AgentRunner and posts the result", async () => {
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
      route: {
        agent: { specialist: "assistant" },
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
              messages: [{ text: "root text" }, { text: "follow-up" }],
            }),
          },
          filesUploadV2: async () => ({}),
        } as never,
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

  it("does not route follow-up messages when configured thread route is unavailable", async () => {
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
          decision: { confidence: 1, reason: "forced_invocation", specialist: "translation" },
          message: "translated follow-up",
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { specialist: "translation" },
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

    expect(invocations).toEqual([expect.objectContaining({ specialist: "translation" })]);
  });

  it("prefers resolved thread route and model for follow-up routing", async () => {
    const invocations: unknown[] = [];
    const runner = {
      async run(invocation: unknown) {
        invocations.push(invocation);
        return {
          decision: { confidence: 1, reason: "forced_invocation", specialist: "web_research" },
          message: "researched follow-up",
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { specialist: "web_research" },
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
        specialist: "web_research",
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
          decision: { confidence: 1, reason: "forced_invocation", specialist: "assistant" },
          message: "follow-up",
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { specialist: "assistant" },
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
          decision: { confidence: 0.8, reason: "test", specialist: "translation" },
          message: "こんにちは",
          toolResults: [],
        };
      },
    };
    const posts: unknown[] = [];
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { specialist: "translation" },
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

  it("does not translate reactions through a misconfigured resolved agent", async () => {
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
      channelEnabled: true,
      route: {
        agent: { specialist: "not_a_specialist" },
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

    expect(runs).toBe(0);
  });

  it("does not post source-text errors before rejecting misconfigured reaction routes", async () => {
    const posts: unknown[] = [];
    const runner = {
      async run() {
        throw new Error("Unexpected runner call.");
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { specialist: "not_a_specialist" },
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

    expect(posts).toEqual([]);
  });

  it("does not translate reactions through a non-translation resolved agent", async () => {
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
      channelEnabled: true,
      route: {
        agent: { specialist: "assistant" },
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
