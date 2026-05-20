import { describe, expect, it } from "vite-plus/test";

import { AgentRunnerExecutionError } from "../../src/agents/runner.js";
import type { JsonObject } from "../../src/infrastructure/postgres/jsonDocumentRepository.js";
import type {
  ChannelFeatureSettingDocument,
  WorkspaceFeatureKey,
  WorkspaceFeatureSettingDocument,
  WorkspaceFeatureSettingsRepository,
} from "../../src/repositories/workspaceFeatureSettings.js";
import {
  createAgentSlackHandlers,
  postAgentResult,
  processSlackAgentJob,
} from "../../src/slack/agentHandlers.js";

describe("createAgentSlackHandlers", () => {
  it("publishes Model routing entry point on App Home with Grid context", async () => {
    const debugLogs: unknown[] = [];
    const publishedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      installedWorkspaceDirectory: {
        async listInstalledWorkspaces(input) {
          expect(input).toEqual({ enterpriseId: "E1" });
          return [
            {
              enterpriseId: "E1",
              installedAt: new Date("2026-05-15T00:00:00Z"),
              teamId: "T2",
              teamName: "Workspace Two",
            },
          ];
        },
      },
    });

    await handlers.handleAppHomeOpened({
      body: {
        authorizations: [
          {
            enterprise_id: "E1",
            is_enterprise_install: true,
            team_id: "T-random",
          },
        ],
        enterprise: { id: "E1" },
        user: { id: "U1", team_id: "T-random" },
      },
      client: {
        views: {
          publish: async (payload: unknown) => {
            publishedViews.push(payload);
            return {};
          },
        },
      },
      event: { team: "T-event", user: "U1" },
      logger: {
        debug(_message: string, metadata: unknown) {
          debugLogs.push(metadata);
        },
        warn() {},
      },
    } as never);

    const serialized = JSON.stringify(publishedViews[0]);
    expect(serialized).toContain("Model routing");
    expect(serialized).toContain("model_routing_configure");
    expect(serialized).toContain('\\"selectedTeamId\\":\\"T-random\\"');
    expect(debugLogs[0]).toMatchObject({
      authorizationTeamId: "T-random",
      enterpriseId: "E1",
      mode: "enterprise_grid",
      sourceTeamId: "T-random",
    });
  });

  it("does not list all installed workspaces for standalone App Home", async () => {
    const publishedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      installedWorkspaceDirectory: {
        async listInstalledWorkspaces() {
          throw new Error("standalone App Home must not list all installed workspaces");
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
      logger: { debug() {}, warn() {} },
    } as never);

    const serialized = JSON.stringify(publishedViews[0]);
    expect(serialized).toContain("Model routing");
    expect(serialized).toContain('\\"selectedTeamId\\":\\"T1\\"');
    expect(serialized).not.toContain("workspaces");
  });

  it("opens model routing modal for the current workspace with stored model choices", async () => {
    const openedViews: unknown[] = [];
    const operations: string[] = [];
    const updatedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      installedWorkspaceDirectory: {
        async listInstalledWorkspaces() {
          throw new Error("workspace routing must not list workspaces during configuration");
        },
      },
      routingRepository: {
        async findWorkspaceSettings(teamId: string) {
          operations.push("findWorkspaceSettings");
          expect(teamId).toBe("T-random");
          return {
            default_model_id: "openai:gpt-4o",
            enabled_model_ids: ["openai:gpt-4o", "anthropic:claude-sonnet-4-20250514"],
          };
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds(input) {
          operations.push("listActiveProviderKinds");
          expect(input).toEqual({ teamId: "T-random" });
          return ["openai", "anthropic"];
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingConfigureAction({
      ack: async () => {
        operations.push("ack");
      },
      body: {
        actions: [{ value: JSON.stringify({ enterpriseId: "E1", selectedTeamId: "T-random" }) }],
        enterprise: { id: "E1" },
        team: { id: "T-random" },
        trigger_id: "TRIGGER1",
        user: { id: "UADMIN" },
      },
      client: {
        users: {
          info: async () => {
            operations.push("users.info");
            return { user: { is_admin: true } };
          },
        },
        views: {
          open: async (payload: unknown) => {
            operations.push("views.open");
            openedViews.push(payload);
            return { view: { id: "VIEW1" } };
          },
          update: async (payload: unknown) => {
            operations.push("views.update");
            updatedViews.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    expect(operations).toEqual([
      "ack",
      "views.open",
      "users.info",
      "findWorkspaceSettings",
      "listActiveProviderKinds",
      "views.update",
    ]);
    expect(openedViews).toEqual([
      expect.objectContaining({
        trigger_id: "TRIGGER1",
        view: expect.objectContaining({
          type: "modal",
        }),
      }),
    ]);
    expect(JSON.stringify(openedViews[0])).toContain("Loading model routing settings");
    expect(updatedViews).toEqual([
      expect.objectContaining({
        view_id: "VIEW1",
        view: expect.objectContaining({
          callback_id: "model_routing_modal",
          private_metadata: expect.stringContaining('"enterpriseId":"E1"'),
          type: "modal",
        }),
      }),
    ]);
    const serialized = JSON.stringify(updatedViews[0]);
    expect(serialized).toContain("Enabled models");
    expect(serialized).toContain("Workspace default model");
    expect(serialized).toContain('"dispatch_action":true');
    expect(serialized).not.toContain("Reasoning effort");
    expect(serialized).not.toContain("Provider default");
    expect(serialized).toContain("anthropic:claude-sonnet-4-20250514");
    expect(serialized).not.toContain("google:gemini-2.5-flash");
  });

  it("does not list all installed workspaces when standalone users open model routing", async () => {
    const updatedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      installedWorkspaceDirectory: {
        async listInstalledWorkspaces() {
          throw new Error("standalone model routing must not list all installed workspaces");
        },
      },
      routingRepository: {
        async findWorkspaceSettings(teamId: string) {
          expect(teamId).toBe("T1");
          return {
            enabled_model_ids: ["openai:gpt-4o"],
          };
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds(input) {
          expect(input).toEqual({ teamId: "T1" });
          return ["openai"];
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingConfigureAction({
      ack: async () => undefined,
      body: {
        actions: [{ value: JSON.stringify({ selectedTeamId: "T-other" }) }],
        team: { id: "T1" },
        trigger_id: "TRIGGER1",
        user: { id: "UADMIN" },
      },
      client: {
        users: {
          info: async () => ({ user: { is_admin: true } }),
        },
        views: {
          open: async () => ({ view: { id: "VIEW1" } }),
          update: async (payload: unknown) => {
            updatedViews.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    const serialized = JSON.stringify(updatedViews[0]);
    expect(serialized).toContain("Workspace default model");
    expect(serialized).not.toContain("model_routing_workspace_select");
    expect(serialized).not.toContain("T-other");
  });

  it("rejects model routing configure actions for unverified selected workspaces before tenant reads", async () => {
    const updatedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      installedWorkspaceDirectory: {
        async listInstalledWorkspaces() {
          throw new Error("unauthorized workspace routing must not list installed workspaces");
        },
      },
      routingRepository: {
        async findWorkspaceSettings() {
          throw new Error("should not read settings for unauthorized workspace");
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds() {
          throw new Error("should not read credentials for unauthorized workspace");
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingConfigureAction({
      ack: async () => undefined,
      body: {
        actions: [
          { value: JSON.stringify({ enterpriseId: "E1", selectedTeamId: "T-unauthorized" }) },
        ],
        enterprise: { id: "E1" },
        team: { id: "T-random" },
        trigger_id: "TRIGGER1",
        user: { id: "UADMIN" },
      },
      client: {
        users: {
          info: async () => ({ user: { is_admin: true } }),
        },
        views: {
          open: async () => ({ view: { id: "VIEW1" } }),
          update: async (payload: unknown) => {
            updatedViews.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    expect(updatedViews).toEqual([
      expect.objectContaining({
        view_id: "VIEW1",
        view: expect.objectContaining({ type: "modal" }),
      }),
    ]);
    expect(JSON.stringify(updatedViews[0])).toContain(
      "Only Slack workspace admins and owners can configure model routing.",
    );
  });

  it("removes reasoning selector when default model changes to a non-reasoning model", async () => {
    const updates: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never);

    await handlers.handleModelRoutingDefaultModelSelectAction({
      ack: async () => undefined,
      body: {
        view: modelRoutingView({
          blocks: [
            { block_id: "model_routing_enabled_models", type: "input" },
            { block_id: "model_routing_default_model", type: "input" },
            { block_id: "model_routing_reasoning_effort", type: "input" },
          ],
          defaultModelId: "openai:gpt-4o",
          reasoningEffort: "provider_default",
        }),
      },
      client: {
        views: {
          update: async (payload: unknown) => {
            updates.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    const serialized = JSON.stringify(updates[0]);
    expect(updates[0]).toEqual(expect.objectContaining({ hash: "HASH1" }));
    expect(serialized).toContain("model_routing_default_model");
    expect(serialized).not.toContain("model_routing_reasoning_effort");
  });

  it("adds model-specific reasoning options when default model changes to a reasoning model", async () => {
    const updates: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      defaultLocale: "en",
      userSettingsRepository: {
        async findUserSettings(input) {
          expect(input).toEqual({
            enterpriseId: "E1",
            slackUserId: "UADMIN",
            teamId: "T1",
          });
          return {
            createdAt: new Date("2026-05-15T00:00:00Z"),
            locale: "ja",
            payload: {},
            scopeId: "T1",
            scopeKind: "team",
            slackUserId: "UADMIN",
            teamId: "T1",
            updatedAt: new Date("2026-05-15T00:00:00Z"),
          };
        },
        async saveUserSettings() {},
      },
    });

    await handlers.handleModelRoutingDefaultModelSelectAction({
      ack: async () => undefined,
      body: {
        enterprise: { id: "E1" },
        team: { id: "T-random" },
        user: { id: "UADMIN" },
        view: modelRoutingView({
          blocks: [
            { block_id: "model_routing_enabled_models", type: "input" },
            { block_id: "model_routing_default_model", type: "input" },
          ],
          defaultModelId: "google:gemini-3.1-pro-preview",
        }),
      },
      client: {
        views: {
          update: async (payload: unknown) => {
            updates.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    const serialized = JSON.stringify(updates[0]);
    expect(updates[0]).toEqual(expect.objectContaining({ hash: "HASH1" }));
    expect(serialized).toContain("model_routing_reasoning_effort");
    expect(serialized).toContain("推論深度");
    expect(serialized).not.toContain("Reasoning effort");
    expect(serialized).toContain('"value":"low"');
    expect(serialized).toContain('"value":"high"');
    expect(serialized).not.toContain('"value":"medium"');
    expect(serialized).not.toContain('"value":"minimal"');
  });

  it("does not open model routing selectors when no model provider credentials are registered", async () => {
    const updatedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async findWorkspaceSettings() {
          return undefined;
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds() {
          return [];
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingConfigureAction({
      ack: async () => undefined,
      body: {
        actions: [{ value: JSON.stringify({ selectedTeamId: "T1" }) }],
        team: { id: "T1" },
        trigger_id: "TRIGGER1",
        user: { id: "UADMIN" },
      },
      client: {
        users: {
          info: async (input: unknown) => {
            expect(input).toMatchObject({ team_id: "T1", user: "UADMIN" });
            return { user: { is_admin: true } };
          },
        },
        views: {
          open: async () => ({ view: { id: "VIEW1" } }),
          update: async (payload: unknown) => {
            updatedViews.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    const serialized = JSON.stringify(updatedViews[0]);
    expect(serialized).toContain("Register an API key");
    expect(serialized).not.toContain("enabled_models");
  });

  it("opens channel-only settings modal from channel mention configure actions", async () => {
    const updatedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async findChannelSettings(teamId: string, channelId: string) {
          expect(teamId).toBe("T1");
          expect(channelId).toBe("C1");
          return {
            default_agent_id: "assistant",
            default_model_id: "openai:gpt-5",
          };
        },
        async findWorkspaceSettings(teamId: string) {
          expect(teamId).toBe("T1");
          return {
            enabled_model_ids: ["openai:gpt-5"],
            reasoning_effort: "high",
          };
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds(input) {
          expect(input).toEqual({ teamId: "T1" });
          return ["openai"];
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingConfigureAction({
      ack: async () => undefined,
      body: {
        actions: [
          {
            value: JSON.stringify({
              channelId: "C1",
              source: "channel",
              teamId: "T1",
            }),
          },
        ],
        team: { id: "T1" },
        trigger_id: "TRIGGER1",
        user: { id: "UADMIN" },
      },
      client: {
        users: {
          info: async () => ({ user: { is_admin: true } }),
        },
        views: {
          open: async () => ({ view: { id: "VIEW1" } }),
          update: async (payload: unknown) => {
            updatedViews.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    const serialized = JSON.stringify(updatedViews[0]);
    expect(serialized).toContain("Channel settings");
    expect(serialized).toContain("Channel default model");
    expect(serialized).toContain("Reasoning effort");
    expect(serialized).toContain('"dispatch_action":true');
    expect(serialized).toContain('"value":"high"');
    expect(serialized).toContain('\\"channelId\\":\\"C1\\"');
    expect(serialized).toContain('\\"teamId\\":\\"T1\\"');
    expect(serialized).not.toContain("Channel default agent");
    expect(serialized).not.toContain("Workspace default model");
    expect(serialized).not.toContain("Enabled models");
    expect(serialized).not.toContain("model_routing_workspace_select");
  });

  it("rejects cross-workspace channel configure actions before tenant reads", async () => {
    const updatedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async findChannelSettings() {
          throw new Error("should not read channel settings for unauthorized workspace");
        },
        async findWorkspaceSettings() {
          throw new Error("should not read workspace settings for unauthorized workspace");
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds() {
          throw new Error("should not read credentials for unauthorized workspace");
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingConfigureAction({
      ack: async () => undefined,
      body: {
        actions: [
          {
            value: JSON.stringify({
              channelId: "C1",
              source: "channel",
              teamId: "T-other",
            }),
          },
        ],
        team: { id: "T1" },
        trigger_id: "TRIGGER1",
        user: { id: "UADMIN" },
      },
      client: {
        users: {
          info: async () => ({ user: { is_admin: true } }),
        },
        views: {
          open: async () => ({ view: { id: "VIEW1" } }),
          update: async (payload: unknown) => {
            updatedViews.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    expect(JSON.stringify(updatedViews[0])).toContain(
      "Only Slack workspace admins and owners can configure model routing.",
    );
  });

  it("shows channel model selection when no agents are stored yet", async () => {
    const updatedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async findChannelSettings() {
          return {};
        },
        async findWorkspaceSettings() {
          return {
            enabled_model_ids: ["openai:gpt-4o"],
          };
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds() {
          throw new Error("should not read credentials for unauthorized workspace");
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingConfigureAction({
      ack: async () => undefined,
      body: {
        actions: [
          {
            value: JSON.stringify({
              channelId: "C1",
              source: "channel",
              teamId: "T1",
            }),
          },
        ],
        team: { id: "T1" },
        trigger_id: "TRIGGER1",
        user: { id: "UADMIN" },
      },
      client: {
        users: {
          info: async () => ({ user: { is_admin: true } }),
        },
        views: {
          open: async () => ({ view: { id: "VIEW1" } }),
          update: async (payload: unknown) => {
            updatedViews.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    const serialized = JSON.stringify(updatedViews[0]);
    expect(serialized).toContain("Channel default model");
    expect(serialized).toContain("openai:gpt-4o");
    expect(serialized).not.toContain("Channel default agent");
  });

  it("shows channel reasoning settings from the inherited workspace default model", async () => {
    const updatedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async findChannelSettings() {
          return {};
        },
        async findWorkspaceSettings() {
          return {
            default_model_id: "openai:gpt-5.5",
            enabled_model_ids: ["openai:gpt-5.5", "openai:gpt-4o"],
            reasoning_effort: "high",
          };
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds() {
          return ["openai"];
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingConfigureAction({
      ack: async () => undefined,
      body: {
        actions: [
          {
            value: JSON.stringify({
              channelId: "C1",
              source: "channel",
              teamId: "T1",
            }),
          },
        ],
        team: { id: "T1" },
        trigger_id: "TRIGGER1",
        user: { id: "UADMIN" },
      },
      client: {
        users: {
          info: async () => ({ user: { is_admin: true } }),
        },
        views: {
          open: async () => ({ view: { id: "VIEW1" } }),
          update: async (payload: unknown) => {
            updatedViews.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    const serialized = JSON.stringify(updatedViews[0]);
    expect(serialized).toContain("Channel default model");
    expect(serialized).toContain('"value":"openai:gpt-5.5"');
    expect(serialized).toContain("Reasoning effort");
    expect(serialized).toContain('"value":"high"');
  });

  it("does not show reasoning settings when workspace default model is unset", async () => {
    const updatedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async findWorkspaceSettings() {
          return {};
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds() {
          return ["openai"];
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingConfigureAction({
      ack: async () => undefined,
      body: {
        actions: [{ value: JSON.stringify({ selectedTeamId: "T1" }) }],
        team: { id: "T1" },
        trigger_id: "TRIGGER1",
        user: { id: "UADMIN" },
      },
      client: {
        users: {
          info: async () => ({ user: { is_admin: true } }),
        },
        views: {
          open: async () => ({ view: { id: "VIEW1" } }),
          update: async (payload: unknown) => {
            updatedViews.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    const serialized = JSON.stringify(updatedViews[0]);
    expect(serialized).not.toContain("Reasoning effort");
    expect(serialized).not.toContain('"value":"provider_default"');
  });

  it("shows reasoning settings only for the selected workspace default model", async () => {
    const updatedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async findWorkspaceSettings() {
          return {
            default_model_id: "openai:gpt-5.5",
            enabled_model_ids: ["openai:gpt-5.5", "openai:gpt-4o"],
          };
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds() {
          return ["openai"];
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingConfigureAction({
      ack: async () => undefined,
      body: {
        actions: [{ value: JSON.stringify({ selectedTeamId: "T1" }) }],
        team: { id: "T1" },
        trigger_id: "TRIGGER1",
        user: { id: "UADMIN" },
      },
      client: {
        users: {
          info: async () => ({ user: { is_admin: true } }),
        },
        views: {
          open: async () => ({ view: { id: "VIEW1" } }),
          update: async (payload: unknown) => {
            updatedViews.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    const serialized = JSON.stringify(updatedViews[0]);
    expect(serialized).toContain("Reasoning effort");
    expect(serialized).toContain('"value":"provider_default"');
    expect(serialized).toContain('"value":"minimal"');
    expect(serialized).not.toContain('"value":"xhigh"');
  });

  it("opens thread model settings modal from mention menu actions", async () => {
    const updatedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async findSlackThread(teamId: string, channelId: string, threadTs: string) {
          expect(teamId).toBe("T1");
          expect(channelId).toBe("C1");
          expect(threadTs).toBe("1712345678.000100");
          return {
            model_id: "openai:gpt-4o",
            model_scope: "thread",
          };
        },
        async findChannelSettings() {
          return {
            default_model_id: "anthropic:claude-sonnet-4-20250514",
          };
        },
        async findWorkspaceSettings(teamId: string) {
          expect(teamId).toBe("T1");
          return {
            enabled_model_ids: ["openai:gpt-4o", "anthropic:claude-sonnet-4-20250514"],
          };
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds(input) {
          expect(input).toEqual({ teamId: "T1" });
          return ["openai", "anthropic"];
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingConfigureAction({
      ack: async () => undefined,
      body: {
        actions: [
          {
            value: JSON.stringify({
              channelId: "C1",
              source: "thread",
              teamId: "T1",
              threadTs: "1712345678.000100",
            }),
          },
        ],
        team: { id: "T1" },
        trigger_id: "TRIGGER1",
        user: { id: "UADMIN" },
      },
      client: {
        users: {
          info: async () => ({ user: { is_admin: true } }),
        },
        views: {
          open: async () => ({ view: { id: "VIEW1" } }),
          update: async (payload: unknown) => {
            updatedViews.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    const serialized = JSON.stringify(updatedViews[0]);
    expect(serialized).toContain("Thread settings");
    expect(serialized).toContain("Thread model");
    expect(serialized).toContain("openai:gpt-4o");
    expect(serialized).toContain('"dispatch_action":true');
    expect(serialized).toContain('\\"source\\":\\"thread\\"');
    expect(serialized).toContain('\\"threadTs\\":\\"1712345678.000100\\"');
    expect(serialized).not.toContain("Workspace default model");
    expect(serialized).not.toContain("Enabled models");
  });

  it("rejects cross-workspace thread configure actions before tenant reads", async () => {
    const updatedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async findSlackThread() {
          throw new Error("should not read thread settings for unauthorized workspace");
        },
        async findChannelSettings() {
          throw new Error("should not read channel settings for unauthorized workspace");
        },
        async findWorkspaceSettings() {
          throw new Error("should not read workspace settings for unauthorized workspace");
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds() {
          throw new Error("should not read credentials for unauthorized workspace");
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingConfigureAction({
      ack: async () => undefined,
      body: {
        actions: [
          {
            value: JSON.stringify({
              channelId: "C1",
              source: "thread",
              teamId: "T-other",
              threadTs: "1712345678.000100",
            }),
          },
        ],
        team: { id: "T1" },
        trigger_id: "TRIGGER1",
        user: { id: "UADMIN" },
      },
      client: {
        users: {
          info: async () => ({ user: { is_admin: true } }),
        },
        views: {
          open: async () => ({ view: { id: "VIEW1" } }),
          update: async (payload: unknown) => {
            updatedViews.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    expect(JSON.stringify(updatedViews[0])).toContain(
      "Only Slack workspace admins and owners can configure model routing.",
    );
  });

  it("saves workspace model routing settings from modal submissions", async () => {
    const acks: unknown[] = [];
    const saves: unknown[] = [];
    const updates: unknown[] = [];
    let acked = false;
    const handlers = createAgentSlackHandlers({} as never, {
      installedWorkspaceDirectory: {
        async listInstalledWorkspaces() {
          throw new Error("workspace routing submissions must not list installed workspaces");
        },
      },
      routingRepository: {
        async findWorkspaceSettings(teamId: string) {
          expect(acked).toBe(true);
          expect(teamId).toBe("T-random");
          return {
            default_agent_id: "assistant",
            default_model_id: "google:gemini-2.5-flash",
            enabled_model_ids: ["google:gemini-2.5-flash"],
            thread_auto_reply: true,
          };
        },
        async saveWorkspaceSettings(input: unknown) {
          expect(acked).toBe(true);
          saves.push(input);
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds(input) {
          expect(input).toEqual({ teamId: "T-random" });
          return ["openai", "anthropic"];
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingModalSubmission({
      ack: async (payload?: unknown) => {
        acks.push(payload);
        acked = true;
      },
      body: { enterprise: { id: "E1" }, team: { id: "T-random" }, user: { id: "UADMIN" } },
      client: {
        users: {
          info: async (input: unknown) => {
            expect(acked).toBe(false);
            expect(input).toMatchObject({ team_id: "T-random", user: "UADMIN" });
            return { user: { is_admin: true } };
          },
        },
        views: {
          update: async (payload: unknown) => {
            updates.push(payload);
            return {};
          },
        },
      },
      logger: { info() {} },
      view: {
        id: "VIEW1",
        private_metadata: JSON.stringify({
          enterpriseId: "E1",
          selectedTeamId: "T-random",
          source: "app_home",
        }),
        state: {
          values: {
            model_routing_default_model: {
              default_model: {
                selected_option: { value: "openai:gpt-4o" },
              },
            },
            model_routing_enabled_models: {
              enabled_models: {
                selected_options: [
                  { value: "openai:gpt-4o" },
                  { value: "anthropic:claude-sonnet-4-20250514" },
                ],
              },
            },
            model_routing_reasoning_effort: {
              reasoning_effort: {
                selected_option: { value: "high" },
              },
            },
          },
        },
      },
    } as never);

    expect(acks).toEqual([
      expect.objectContaining({
        response_action: "update",
      }),
    ]);
    expect(JSON.stringify(acks[0])).toContain("Saving model routing settings");
    expect(saves).toEqual([
      expect.objectContaining({
        defaultAgentId: "assistant",
        defaultModelId: "openai:gpt-4o",
        enabledModelIds: ["openai:gpt-4o", "anthropic:claude-sonnet-4-20250514"],
        teamId: "T-random",
        threadAutoReply: true,
      }),
    ]);
    expect((saves[0] as { reasoningEffort?: unknown }).reasoningEffort).toBeUndefined();
    expect(updates).toEqual([
      expect.objectContaining({
        view_id: "VIEW1",
        view: expect.objectContaining({ type: "modal" }),
      }),
    ]);
    expect(JSON.stringify(updates[0])).toContain("Model routing settings were saved.");
  });

  it("rejects model routing submissions for unverified selected workspaces", async () => {
    const acks: unknown[] = [];
    const saves: unknown[] = [];
    const updates: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      installedWorkspaceDirectory: {
        async listInstalledWorkspaces() {
          throw new Error("unauthorized workspace routing must not list installed workspaces");
        },
      },
      routingRepository: {
        async findWorkspaceSettings() {
          throw new Error("should not read settings for unauthorized workspace");
        },
        async saveWorkspaceSettings(input: unknown) {
          saves.push(input);
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds() {
          return ["openai"];
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingModalSubmission({
      ack: async (payload?: unknown) => {
        acks.push(payload);
      },
      body: { enterprise: { id: "E1" }, team: { id: "T-random" }, user: { id: "UADMIN" } },
      client: {
        users: {
          info: async () => ({ user: { is_admin: true } }),
        },
        views: {
          update: async (payload: unknown) => {
            updates.push(payload);
            return {};
          },
        },
      },
      logger: { error() {}, warn() {} },
      view: {
        id: "VIEW1",
        private_metadata: JSON.stringify({
          enterpriseId: "E1",
          selectedTeamId: "T-unauthorized",
          source: "app_home",
        }),
        state: {
          values: {
            model_routing_default_model: {
              default_model: {
                selected_option: { value: "openai:gpt-4o" },
              },
            },
            model_routing_enabled_models: {
              enabled_models: {
                selected_options: [{ value: "openai:gpt-4o" }],
              },
            },
          },
        },
      },
    } as never);

    expect(acks).toEqual([
      expect.objectContaining({
        response_action: "update",
      }),
    ]);
    expect(saves).toEqual([]);
    expect(updates).toEqual([]);
    expect(JSON.stringify(acks[0])).toContain(
      "Only Slack workspace admins and owners can configure model routing.",
    );
  });

  it("creates the built-in assistant agent when saving workspace settings from an empty agent table", async () => {
    const savedAgents: unknown[] = [];
    const saves: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async findWorkspaceSettings() {
          return {
            enabled_model_ids: ["openai:gpt-4o"],
          };
        },
        async saveAgent(input: unknown) {
          savedAgents.push(input);
        },
        async saveWorkspaceSettings(input: unknown) {
          saves.push(input);
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds() {
          return ["openai"];
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingModalSubmission({
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
      logger: { error() {}, info() {} },
      view: {
        id: "VIEW1",
        private_metadata: JSON.stringify({
          source: "app_home",
          teamId: "T1",
        }),
        state: {
          values: {
            model_routing_default_model: {
              default_model: {
                selected_option: { value: "openai:gpt-4o" },
              },
            },
            model_routing_enabled_models: {
              enabled_models: {
                selected_options: [{ value: "openai:gpt-4o" }],
              },
            },
          },
        },
      },
    } as never);

    expect(savedAgents).toEqual([
      expect.objectContaining({
        agentId: "assistant",
        enabled: true,
      }),
    ]);
    expect(saves).toEqual([
      expect.objectContaining({
        defaultAgentId: "assistant",
        defaultModelId: "openai:gpt-4o",
        enabledModelIds: ["openai:gpt-4o"],
        teamId: "T1",
      }),
    ]);
  });

  it("saves channel settings from channel-only modal submissions", async () => {
    const acks: unknown[] = [];
    const saves: unknown[] = [];
    const updates: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async findChannelSettings(teamId: string, channelId: string) {
          expect(teamId).toBe("T1");
          expect(channelId).toBe("C1");
          return {
            thread_auto_reply: true,
          };
        },
        async findWorkspaceSettings(teamId: string) {
          expect(teamId).toBe("T1");
          return {
            enabled_model_ids: ["openai:gpt-4o"],
          };
        },
        async saveChannelSettings(input: unknown) {
          saves.push(input);
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds(input) {
          expect(input).toEqual({ teamId: "T1" });
          return ["openai"];
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingModalSubmission({
      ack: async (payload?: unknown) => {
        acks.push(payload);
      },
      body: { team: { id: "T1" }, user: { id: "UADMIN" } },
      client: {
        users: {
          info: async () => ({ user: { is_admin: true } }),
        },
        views: {
          update: async (payload: unknown) => {
            updates.push(payload);
            return {};
          },
        },
      },
      logger: { error() {}, info() {} },
      view: {
        id: "VIEW1",
        private_metadata: JSON.stringify({
          channelId: "C1",
          source: "channel",
          teamId: "T1",
        }),
        state: {
          values: {
            model_routing_default_model: {
              default_model: {
                selected_option: { value: "openai:gpt-4o" },
              },
            },
            model_routing_reasoning_effort: {
              reasoning_effort: {
                selected_option: { value: "medium" },
              },
            },
          },
        },
      },
    } as never);

    expect(acks).toEqual([expect.objectContaining({ response_action: "update" })]);
    expect(saves).toEqual([
      expect.objectContaining({
        channelId: "C1",
        defaultAgentId: "assistant",
        defaultModelId: "openai:gpt-4o",
        teamId: "T1",
        threadAutoReply: true,
      }),
    ]);
    expect((saves[0] as { reasoningEffort?: unknown }).reasoningEffort).toBeUndefined();
    expect(JSON.stringify(updates[0])).toContain("Channel settings were saved.");
  });

  it("rejects cross-workspace channel submissions before tenant reads", async () => {
    const acks: unknown[] = [];
    const saves: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async findChannelSettings() {
          throw new Error("should not read channel settings for unauthorized workspace");
        },
        async findWorkspaceSettings() {
          throw new Error("should not read workspace settings for unauthorized workspace");
        },
        async saveChannelSettings(input: unknown) {
          saves.push(input);
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds() {
          throw new Error("should not read credentials for unauthorized workspace");
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingModalSubmission({
      ack: async (payload?: unknown) => {
        acks.push(payload);
      },
      body: { team: { id: "T1" }, user: { id: "UADMIN" } },
      client: {
        users: {
          info: async () => {
            throw new Error("should not resolve Slack user for cross-workspace submission");
          },
        },
        views: {
          update: async () => ({}),
        },
      },
      logger: { error() {}, info() {} },
      view: {
        id: "VIEW1",
        private_metadata: JSON.stringify({
          channelId: "C1",
          source: "channel",
          teamId: "T-other",
        }),
        state: {
          values: {
            model_routing_default_model: {
              default_model: {
                selected_option: { value: "openai:gpt-4o" },
              },
            },
          },
        },
      },
    } as never);

    expect(saves).toEqual([]);
    expect(JSON.stringify(acks[0])).toContain(
      "Only Slack workspace admins and owners can configure model routing.",
    );
  });

  it("does not persist inherited workspace reasoning as a channel override", async () => {
    const saves: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async findChannelSettings() {
          return {};
        },
        async findWorkspaceSettings() {
          return {
            default_agent_id: "assistant",
            enabled_model_ids: ["openai:gpt-5"],
            reasoning_effort: "high",
          };
        },
        async saveChannelSettings(input: unknown) {
          saves.push(input);
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds() {
          return ["openai"];
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingModalSubmission({
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
      logger: { error() {}, info() {} },
      view: {
        id: "VIEW1",
        private_metadata: JSON.stringify({
          channelId: "C1",
          source: "channel",
          teamId: "T1",
        }),
        state: {
          values: {
            model_routing_default_model: {
              default_model: {
                selected_option: { value: "openai:gpt-5" },
              },
            },
            model_routing_reasoning_effort: {
              reasoning_effort: {
                selected_option: { value: "high" },
              },
            },
          },
        },
      },
    } as never);

    expect(saves).toEqual([
      expect.objectContaining({
        defaultModelId: "openai:gpt-5",
      }),
    ]);
    expect((saves[0] as { reasoningEffort?: unknown }).reasoningEffort).toBeUndefined();
  });

  it("does not persist inherited workspace default model as a channel override", async () => {
    const saves: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async findChannelSettings() {
          return {};
        },
        async findWorkspaceSettings() {
          return {
            default_agent_id: "assistant",
            default_model_id: "openai:gpt-5.5",
            enabled_model_ids: ["openai:gpt-5.5", "openai:gpt-4o"],
            reasoning_effort: "high",
          };
        },
        async saveChannelSettings(input: unknown) {
          saves.push(input);
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds() {
          return ["openai"];
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingModalSubmission({
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
      logger: { error() {}, info() {} },
      view: {
        id: "VIEW1",
        private_metadata: JSON.stringify({
          channelId: "C1",
          source: "channel",
          teamId: "T1",
        }),
        state: {
          values: {
            model_routing_default_model: {
              default_model: {
                selected_option: { value: "openai:gpt-5.5" },
              },
            },
            model_routing_reasoning_effort: {
              reasoning_effort: {
                selected_option: { value: "high" },
              },
            },
          },
        },
      },
    } as never);

    expect(saves).toEqual([
      expect.objectContaining({
        channelId: "C1",
        teamId: "T1",
      }),
    ]);
    expect((saves[0] as { defaultModelId?: unknown }).defaultModelId).toBeUndefined();
    expect((saves[0] as { reasoningEffort?: unknown }).reasoningEffort).toBeUndefined();
  });

  it("clears channel reasoning override when selection matches inherited workspace reasoning", async () => {
    const saves: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async findChannelSettings() {
          return {
            reasoning_effort: "high",
          };
        },
        async findWorkspaceSettings() {
          return {
            default_agent_id: "assistant",
            enabled_model_ids: ["openai:gpt-5"],
            reasoning_effort: "medium",
          };
        },
        async saveChannelSettings(input: unknown) {
          saves.push(input);
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds() {
          return ["openai"];
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingModalSubmission({
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
      logger: { error() {}, info() {} },
      view: {
        id: "VIEW1",
        private_metadata: JSON.stringify({
          channelId: "C1",
          source: "channel",
          teamId: "T1",
        }),
        state: {
          values: {
            model_routing_default_model: {
              default_model: {
                selected_option: { value: "openai:gpt-5" },
              },
            },
            model_routing_reasoning_effort: {
              reasoning_effort: {
                selected_option: { value: "medium" },
              },
            },
          },
        },
      },
    } as never);

    expect(saves).toEqual([
      expect.objectContaining({
        defaultModelId: "openai:gpt-5",
      }),
    ]);
    expect((saves[0] as { reasoningEffort?: unknown }).reasoningEffort).toBeUndefined();
  });

  it("creates the built-in assistant agent when saving channel settings from an empty agent table", async () => {
    const savedAgents: unknown[] = [];
    const saves: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async findChannelSettings() {
          return {};
        },
        async findWorkspaceSettings() {
          return {
            enabled_model_ids: ["openai:gpt-4o"],
          };
        },
        async saveAgent(input: unknown) {
          savedAgents.push(input);
        },
        async saveChannelSettings(input: unknown) {
          saves.push(input);
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds() {
          return ["openai"];
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingModalSubmission({
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
      logger: { error() {}, info() {} },
      view: {
        id: "VIEW1",
        private_metadata: JSON.stringify({
          channelId: "C1",
          source: "channel",
          teamId: "T1",
        }),
        state: {
          values: {
            model_routing_default_model: {
              default_model: {
                selected_option: { value: "openai:gpt-4o" },
              },
            },
          },
        },
      },
    } as never);

    expect(savedAgents).toEqual([
      expect.objectContaining({
        agentId: "assistant",
        enabled: true,
      }),
    ]);
    expect(saves).toEqual([
      expect.objectContaining({
        defaultAgentId: "assistant",
        defaultModelId: "openai:gpt-4o",
      }),
    ]);
  });

  it("saves thread model settings from thread-only modal submissions", async () => {
    const acks: unknown[] = [];
    const activations: unknown[] = [];
    const updates: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async activateThreadAgent(input: unknown) {
          activations.push(input);
          return {};
        },
        async findSlackThread() {
          return {
            agent_id: "assistant",
            last_message_ts: "1712345678.000200",
            root_message_ts: "1712345678.000100",
          };
        },
        async findChannelSettings() {
          return {};
        },
        async findWorkspaceSettings() {
          return {
            enabled_model_ids: ["openai:gpt-4o"],
          };
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds() {
          return ["openai"];
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingModalSubmission({
      ack: async (payload?: unknown) => {
        acks.push(payload);
      },
      body: { team: { id: "T1" }, user: { id: "UADMIN" } },
      client: {
        users: {
          info: async () => ({ user: { is_admin: true } }),
        },
        views: {
          update: async (payload: unknown) => {
            updates.push(payload);
            return {};
          },
        },
      },
      logger: { error() {}, info() {} },
      view: {
        id: "VIEW1",
        private_metadata: JSON.stringify({
          channelId: "C1",
          source: "thread",
          teamId: "T1",
          threadTs: "1712345678.000100",
        }),
        state: {
          values: {
            model_routing_default_model: {
              default_model: {
                selected_option: { value: "openai:gpt-4o" },
              },
            },
            model_routing_reasoning_effort: {
              reasoning_effort: {
                selected_option: { value: "low" },
              },
            },
          },
        },
      },
    } as never);

    expect(acks).toEqual([expect.objectContaining({ response_action: "update" })]);
    expect(activations).toEqual([
      expect.objectContaining({
        agentId: "assistant",
        channelId: "C1",
        lastMessageTs: "1712345678.000200",
        modelId: "openai:gpt-4o",
        rootMessageTs: "1712345678.000100",
        teamId: "T1",
        threadTs: "1712345678.000100",
      }),
    ]);
    expect((activations[0] as { reasoningEffort?: unknown }).reasoningEffort).toBeUndefined();
    expect(JSON.stringify(updates[0])).toContain("Thread settings were saved.");
  });

  it("rejects cross-workspace thread submissions before tenant reads", async () => {
    const acks: unknown[] = [];
    const activations: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async activateThreadAgent(input: unknown) {
          activations.push(input);
          return {};
        },
        async findSlackThread() {
          throw new Error("should not read thread settings for unauthorized workspace");
        },
        async findChannelSettings() {
          throw new Error("should not read channel settings for unauthorized workspace");
        },
        async findWorkspaceSettings() {
          throw new Error("should not read workspace settings for unauthorized workspace");
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds() {
          throw new Error("should not read credentials for unauthorized workspace");
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingModalSubmission({
      ack: async (payload?: unknown) => {
        acks.push(payload);
      },
      body: { team: { id: "T1" }, user: { id: "UADMIN" } },
      client: {
        users: {
          info: async () => {
            throw new Error("should not resolve Slack user for cross-workspace submission");
          },
        },
        views: {
          update: async () => ({}),
        },
      },
      logger: { error() {}, info() {} },
      view: {
        id: "VIEW1",
        private_metadata: JSON.stringify({
          channelId: "C1",
          source: "thread",
          teamId: "T-other",
          threadTs: "1712345678.000100",
        }),
        state: {
          values: {
            model_routing_default_model: {
              default_model: {
                selected_option: { value: "openai:gpt-4o" },
              },
            },
          },
        },
      },
    } as never);

    expect(activations).toEqual([]);
    expect(JSON.stringify(acks[0])).toContain(
      "Only Slack workspace admins and owners can configure model routing.",
    );
  });

  it("does not persist an inherited channel model as a thread override", async () => {
    const activations: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async activateThreadAgent(input: unknown) {
          activations.push(input);
          return {};
        },
        async findSlackThread() {
          return {
            agent_id: "assistant",
            last_message_ts: "1712345678.000200",
            root_message_ts: "1712345678.000100",
          };
        },
        async findChannelSettings() {
          return {
            default_model_id: "openai:gpt-4o",
          };
        },
        async findWorkspaceSettings() {
          return {
            enabled_model_ids: ["openai:gpt-4o"],
          };
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds() {
          return ["openai"];
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingModalSubmission({
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
      logger: { error() {}, info() {} },
      view: {
        id: "VIEW1",
        private_metadata: JSON.stringify({
          channelId: "C1",
          source: "thread",
          teamId: "T1",
          threadTs: "1712345678.000100",
        }),
        state: {
          values: {
            model_routing_default_model: {
              default_model: {
                selected_option: { value: "openai:gpt-4o" },
              },
            },
          },
        },
      },
    } as never);

    expect(activations).toEqual([
      expect.objectContaining({
        channelId: "C1",
        modelId: undefined,
        teamId: "T1",
        threadTs: "1712345678.000100",
      }),
    ]);
  });

  it("does not persist inherited channel reasoning as a thread override", async () => {
    const activations: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async activateThreadAgent(input: unknown) {
          activations.push(input);
          return {};
        },
        async findSlackThread() {
          return {
            agent_id: "assistant",
            last_message_ts: "1712345678.000200",
            root_message_ts: "1712345678.000100",
          };
        },
        async findChannelSettings() {
          return {
            reasoning_effort: "low",
          };
        },
        async findWorkspaceSettings() {
          return {
            enabled_model_ids: ["openai:gpt-5"],
          };
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds() {
          return ["openai"];
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingModalSubmission({
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
      logger: { error() {}, info() {} },
      view: {
        id: "VIEW1",
        private_metadata: JSON.stringify({
          channelId: "C1",
          source: "thread",
          teamId: "T1",
          threadTs: "1712345678.000100",
        }),
        state: {
          values: {
            model_routing_default_model: {
              default_model: {
                selected_option: { value: "openai:gpt-5" },
              },
            },
            model_routing_reasoning_effort: {
              reasoning_effort: {
                selected_option: { value: "low" },
              },
            },
          },
        },
      },
    } as never);

    expect(activations).toEqual([
      expect.objectContaining({
        modelId: "openai:gpt-5",
      }),
    ]);
    expect((activations[0] as { reasoningEffort?: unknown }).reasoningEffort).toBeUndefined();
  });

  it("clears thread reasoning override when selection matches inherited channel reasoning", async () => {
    const activations: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      routingRepository: {
        async activateThreadAgent(input: unknown) {
          activations.push(input);
          return {};
        },
        async findSlackThread() {
          return {
            agent_id: "assistant",
            last_message_ts: "1712345678.000200",
            reasoning_effort: "high",
            root_message_ts: "1712345678.000100",
          };
        },
        async findChannelSettings() {
          return {
            reasoning_effort: "low",
          };
        },
        async findWorkspaceSettings() {
          return {
            enabled_model_ids: ["openai:gpt-5"],
          };
        },
      } as never,
      workspaceCredentialSettings: {
        async listActiveProviderKinds() {
          return ["openai"];
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleModelRoutingModalSubmission({
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
      logger: { error() {}, info() {} },
      view: {
        id: "VIEW1",
        private_metadata: JSON.stringify({
          channelId: "C1",
          source: "thread",
          teamId: "T1",
          threadTs: "1712345678.000100",
        }),
        state: {
          values: {
            model_routing_default_model: {
              default_model: {
                selected_option: { value: "openai:gpt-5" },
              },
            },
            model_routing_reasoning_effort: {
              reasoning_effort: {
                selected_option: { value: "low" },
              },
            },
          },
        },
      },
    } as never);

    expect(activations).toEqual([
      expect.objectContaining({
        modelId: "openai:gpt-5",
      }),
    ]);
    expect((activations[0] as { reasoningEffort?: unknown }).reasoningEffort).toBeUndefined();
  });

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
    const updatedViews: unknown[] = [];
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
            return { view: { id: "VIEW1" } };
          },
          update: async (payload: unknown) => {
            updatedViews.push(payload);
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
          type: "modal",
        }),
      }),
    ]);
    expect(updatedViews).toEqual([
      expect.objectContaining({
        view_id: "VIEW1",
        view: expect.objectContaining({
          callback_id: "salesforce_pdf_workflow_modal",
          private_metadata: expect.stringContaining('"teamId":"T1"'),
        }),
      }),
    ]);
    expect(JSON.stringify(updatedViews[0])).toContain("quote_v1");
    expect(JSON.stringify(updatedViews[0])).toContain("012000000000001AAA");
  });

  it("opens Salesforce PDF workflow modals before resolving stored user locale", async () => {
    const openedViews: unknown[] = [];
    const updatedViews: unknown[] = [];
    let userInfoCalls = 0;
    const handlers = createAgentSlackHandlers({} as never, {
      defaultLocale: "ja",
      salesforcePdfWorkflowHome: {
        repository: {
          async findSalesforcePdfWorkflowSetting(): Promise<JsonObject> {
            expect(openedViews).toHaveLength(1);
            return validSalesforcePdfWorkflowSetting();
          },
          async listSalesforcePdfWorkflowSettings(): Promise<JsonObject[]> {
            return [];
          },
          async saveSalesforcePdfWorkflowSetting() {},
        },
      },
      userSettingsRepository: {
        async findUserSettings() {
          expect(openedViews).toHaveLength(1);
          return {
            createdAt: new Date("2026-05-15T00:00:00Z"),
            locale: "en",
            payload: {},
            scopeId: "T1",
            scopeKind: "team",
            slackUserId: "UADMIN",
            teamId: "T1",
            updatedAt: new Date("2026-05-15T00:00:00Z"),
          };
        },
        async saveUserSettings() {},
      },
    });

    await handlers.handleSalesforcePdfWorkflowConfigureAction({
      ack: async () => undefined,
      body: {
        actions: [{ value: JSON.stringify({ action: "quote_pdf", salesforceOrgId: "00DORG" }) }],
        enterprise: { id: "E1" },
        team: { id: "T1" },
        trigger_id: "TRIGGER1",
        user: { id: "UADMIN" },
      },
      client: {
        users: {
          info: async () => {
            expect(openedViews).toHaveLength(1);
            userInfoCalls += 1;
            return { user: { is_admin: true } };
          },
        },
        views: {
          open: async (payload: unknown) => {
            openedViews.push(payload);
            return { view: { id: "VIEW1" } };
          },
          update: async (payload: unknown) => {
            updatedViews.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    expect(userInfoCalls).toBe(1);
    expect(JSON.stringify(openedViews[0])).toContain("ワークフロー設定を読み込んでいます");
    expect(JSON.stringify(updatedViews[0])).toContain("Allowed stages");
    expect(JSON.stringify(updatedViews[0])).toContain('\\"enterpriseId\\":\\"E1\\"');
  });

  it("saves Salesforce PDF workflow settings from modal submissions", async () => {
    const acks: unknown[] = [];
    const saves: unknown[] = [];
    const updates: unknown[] = [];
    let userInfoCalls = 0;
    let acked = false;
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
        acked = true;
      },
      body: { team: { id: "T1" }, user: { id: "UADMIN" } },
      client: {
        users: {
          info: async () => {
            expect(acked).toBe(true);
            userInfoCalls += 1;
            return { user: { is_owner: true } };
          },
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
    expect(userInfoCalls).toBe(1);
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

  it("publishes feature settings entry point when a supported image provider API key exists", async () => {
    const publishedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      featureSettingsHome: {
        imageGenerationModelId: "openai:gpt-image-1.5",
        repository: new MemoryFeatureSettingsRepository(),
      },
      workspaceCredentialSettings: {
        async resolveProviderCredential(input) {
          return input.provider === "openai" ? { apiKey: "sk-test" } : undefined;
        },
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

    expect(JSON.stringify(publishedViews[0])).toContain("Feature settings");
    expect(JSON.stringify(publishedViews[0])).toContain("feature_settings_configure");

    const alternateProviderViews: unknown[] = [];
    const alternateProviderHandlers = createAgentSlackHandlers({} as never, {
      featureSettingsHome: {
        imageGenerationModelId: "google:gemini-2.5-flash-image",
        repository: new MemoryFeatureSettingsRepository(),
      },
      workspaceCredentialSettings: {
        async resolveProviderCredential(input) {
          return input.provider === "openai" ? { apiKey: "sk-test" } : undefined;
        },
        async saveProviderApiKey() {},
      },
    });
    await alternateProviderHandlers.handleAppHomeOpened({
      body: { team_id: "T1" },
      client: {
        views: {
          publish: async (payload: unknown) => {
            alternateProviderViews.push(payload);
            return {};
          },
        },
      },
      event: { user: "U1" },
      logger: { warn() {} },
    } as never);

    expect(JSON.stringify(alternateProviderViews[0])).toContain("feature_settings_configure");

    const hiddenViews: unknown[] = [];
    const hiddenHandlers = createAgentSlackHandlers({} as never, {
      featureSettingsHome: {
        imageGenerationModelId: "openai:gpt-image-1.5",
        repository: new MemoryFeatureSettingsRepository(),
      },
      workspaceCredentialSettings: {
        async resolveProviderCredential() {
          return undefined;
        },
        async saveProviderApiKey() {},
      },
    });
    await hiddenHandlers.handleAppHomeOpened({
      body: { team_id: "T1" },
      client: {
        views: {
          publish: async (payload: unknown) => {
            hiddenViews.push(payload);
            return {};
          },
        },
      },
      event: { user: "U1" },
      logger: { warn() {} },
    } as never);

    expect(JSON.stringify(hiddenViews[0])).not.toContain("feature_settings_configure");

    const staleEnabledViews: unknown[] = [];
    const staleEnabledHandlers = createAgentSlackHandlers({} as never, {
      featureSettingsHome: {
        imageGenerationModelId: "openai:gpt-image-1.5",
        repository: new MemoryFeatureSettingsRepository({ workspaceEnabled: true }),
      },
      workspaceCredentialSettings: {
        async resolveProviderCredential() {
          return undefined;
        },
        async saveProviderApiKey() {},
      },
    });
    await staleEnabledHandlers.handleAppHomeOpened({
      body: { team_id: "T1" },
      client: {
        views: {
          publish: async (payload: unknown) => {
            staleEnabledViews.push(payload);
            return {};
          },
        },
      },
      event: { user: "U1" },
      logger: { warn() {} },
    } as never);

    expect(JSON.stringify(staleEnabledViews[0])).toContain("feature_settings_configure");
  });

  it("does not publish feature settings entry point for a non-image model", async () => {
    const publishedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      featureSettingsHome: {
        imageGenerationModelId: "openai:gpt-4o",
        repository: new MemoryFeatureSettingsRepository(),
      },
      workspaceCredentialSettings: {
        async resolveProviderCredential() {
          return { apiKey: "sk-test" };
        },
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

    expect(JSON.stringify(publishedViews[0])).not.toContain("feature_settings_configure");
  });

  it("rejects feature settings actions from non-admin Slack users after team resolution", async () => {
    const openedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      featureSettingsHome: {
        imageGenerationModelId: "openai:gpt-image-1.5",
        repository: new MemoryFeatureSettingsRepository(),
      },
      workspaceCredentialSettings: {
        async resolveProviderCredential() {
          return { apiKey: "sk-test" };
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleFeatureSettingsConfigureAction({
      ack: async () => {},
      body: {
        actions: [{ value: JSON.stringify({ selectedTeamId: "T1", source: "app_home" }) }],
        team: { id: "T1" },
        trigger_id: "TRIGGER1",
        user: { id: "U1" },
      },
      client: {
        users: {
          info: async () => ({ user: { is_admin: false, is_owner: false } }),
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

    expect(JSON.stringify(openedViews[0])).toContain(
      "Only Slack workspace admins and owners can configure workspace features.",
    );
  });

  it("opens and saves image generation feature settings for Slack workspace admins", async () => {
    const openedViews: unknown[] = [];
    const updatedViews: unknown[] = [];
    const repository = new MemoryFeatureSettingsRepository({
      allowedChannelIds: ["C1"],
      workspaceEnabled: true,
    });
    const handlers = createAgentSlackHandlers({} as never, {
      featureSettingsHome: {
        imageGenerationModelId: "openai:gpt-image-1.5",
        repository,
      },
      workspaceCredentialSettings: {
        async resolveProviderCredential() {
          return { apiKey: "sk-test" };
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleFeatureSettingsConfigureAction({
      ack: async () => {},
      body: {
        actions: [{ value: JSON.stringify({ selectedTeamId: "T1", source: "app_home" }) }],
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

    expect(JSON.stringify(openedViews[0])).toContain("multi_conversations_select");
    expect(JSON.stringify(openedViews[0])).toContain("static_select");
    expect(JSON.stringify(openedViews[0])).toContain("openai:gpt-image-1.5");
    expect(JSON.stringify(openedViews[0])).toContain("C1");

    await handlers.handleFeatureSettingsModalSubmission({
      ack: async (payload?: unknown) => {
        updatedViews.push(["ack", payload]);
      },
      body: { team: { id: "T1" }, user: { id: "UADMIN" } },
      client: {
        users: {
          info: async () => ({ user: { is_owner: true } }),
        },
        views: {
          update: async (payload: unknown) => {
            updatedViews.push(payload);
            return {};
          },
        },
      },
      logger: { error() {}, warn() {} },
      view: validFeatureSettingsView({
        channelIds: ["C2", "C3"],
        enabled: true,
        imageGenerationModelId: "openai:gpt-image-1.5",
        teamId: "T1",
      }),
    } as never);

    expect(repository.workspaceSetting?.enabled).toBe(true);
    expect(repository.workspaceSetting?.payload.image_generation_model_id).toBe(
      "openai:gpt-image-1.5",
    );
    expect(repository.allowedChannelIds).toEqual(["C2", "C3"]);
    expect(JSON.stringify(updatedViews)).toContain("Feature settings were saved.");
  });

  it("allows Slack workspace admins to disable image generation after the API key is removed", async () => {
    const openedViews: unknown[] = [];
    const updatedViews: unknown[] = [];
    const repository = new MemoryFeatureSettingsRepository({
      allowedChannelIds: ["C1"],
      workspaceEnabled: true,
    });
    const handlers = createAgentSlackHandlers({} as never, {
      featureSettingsHome: {
        imageGenerationModelId: "openai:gpt-image-1.5",
        repository,
      },
      workspaceCredentialSettings: {
        async resolveProviderCredential() {
          return undefined;
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleFeatureSettingsConfigureAction({
      ack: async () => {},
      body: {
        actions: [{ value: JSON.stringify({ selectedTeamId: "T1", source: "app_home" }) }],
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

    expect(JSON.stringify(openedViews[0])).toContain("multi_conversations_select");

    await handlers.handleFeatureSettingsModalSubmission({
      ack: async (payload?: unknown) => {
        updatedViews.push(["ack", payload]);
      },
      body: { team: { id: "T1" }, user: { id: "UADMIN" } },
      client: {
        users: {
          info: async () => ({ user: { is_admin: true } }),
        },
        views: {
          update: async (payload: unknown) => {
            updatedViews.push(payload);
            return {};
          },
        },
      },
      logger: { error() {}, warn() {} },
      view: validFeatureSettingsView({
        channelIds: [],
        enabled: false,
        teamId: "T1",
      }),
    } as never);

    expect(repository.workspaceSetting?.enabled).toBe(false);
    expect(repository.allowedChannelIds).toEqual([]);
    expect(JSON.stringify(updatedViews)).toContain("Feature settings were saved.");
  });

  it("saves image generation settings when OpenAI API key exists and the configured image model is Google", async () => {
    const updatedViews: unknown[] = [];
    const repository = new MemoryFeatureSettingsRepository();
    const handlers = createAgentSlackHandlers({} as never, {
      featureSettingsHome: {
        imageGenerationModelId: "google:gemini-2.5-flash-image",
        repository,
      },
      workspaceCredentialSettings: {
        async resolveProviderCredential(input) {
          return input.provider === "openai" ? { apiKey: "sk-test" } : undefined;
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleFeatureSettingsModalSubmission({
      ack: async (payload?: unknown) => {
        updatedViews.push(["ack", payload]);
      },
      body: { team: { id: "T1" }, user: { id: "UADMIN" } },
      client: {
        users: {
          info: async () => ({ user: { is_admin: true } }),
        },
        views: {
          update: async (payload: unknown) => {
            updatedViews.push(payload);
            return {};
          },
        },
      },
      logger: { error() {}, warn() {} },
      view: validFeatureSettingsView({
        channelIds: ["C2"],
        enabled: true,
        imageGenerationModelId: "openai:gpt-image-1.5",
        teamId: "T1",
      }),
    } as never);

    expect(repository.workspaceSetting?.enabled).toBe(true);
    expect(repository.workspaceSetting?.payload.image_generation_model_id).toBe(
      "openai:gpt-image-1.5",
    );
    expect(repository.allowedChannelIds).toEqual(["C2"]);
    expect(JSON.stringify(updatedViews)).toContain("Feature settings were saved.");
  });

  it("saves Enterprise Grid feature settings for the selected workspace", async () => {
    const updatedViews: unknown[] = [];
    const repository = new MemoryFeatureSettingsRepository();
    const handlers = createAgentSlackHandlers({} as never, {
      featureSettingsHome: {
        imageGenerationModelId: "openai:gpt-image-1.5",
        repository,
      },
      workspaceCredentialSettings: {
        async resolveProviderCredential(input) {
          expect(input.workspaceId).toBe("T2");
          return { apiKey: "sk-test" };
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleFeatureSettingsModalSubmission({
      ack: async (payload?: unknown) => {
        updatedViews.push(["ack", payload]);
      },
      body: { enterprise: { id: "E1" }, team: { id: "T1" }, user: { id: "UADMIN" } },
      client: {
        users: {
          info: async (input: unknown) => {
            expect(input).toMatchObject({ team_id: "T2", user: "UADMIN" });
            return { user: { is_admin: true } };
          },
        },
        views: {
          update: async (payload: unknown) => {
            updatedViews.push(payload);
            return {};
          },
        },
      },
      logger: { error() {}, warn() {} },
      view: validFeatureSettingsView({
        channelIds: ["C2"],
        enabled: true,
        enterpriseId: "E1",
        teamId: "T2",
      }),
    } as never);

    expect(repository.workspaceSetting).toMatchObject({
      enabled: true,
      teamId: "T2",
    });
    expect(repository.allowedChannelIds).toEqual(["C2"]);
    expect(JSON.stringify(updatedViews)).toContain("Feature settings were saved.");
  });

  it("rejects feature settings submissions with mismatched Slack team context", async () => {
    const acks: unknown[] = [];
    const repository = new MemoryFeatureSettingsRepository({
      allowedChannelIds: ["C1"],
      workspaceEnabled: false,
    });
    const handlers = createAgentSlackHandlers({} as never, {
      featureSettingsHome: {
        imageGenerationModelId: "openai:gpt-image-1.5",
        repository,
      },
      workspaceCredentialSettings: {
        async resolveProviderCredential() {
          return { apiKey: "sk-test" };
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleFeatureSettingsModalSubmission({
      ack: async (payload?: unknown) => {
        acks.push(payload);
      },
      body: { team: { id: "T1" }, user: { id: "UADMIN" } },
      client: {
        users: {
          info: async () => {
            throw new Error("users.info should not be called for mismatched contexts");
          },
        },
        views: {
          update: async () => ({}),
        },
      },
      logger: { error() {}, warn() {} },
      view: validFeatureSettingsView({
        channelIds: ["C2"],
        enabled: true,
        teamId: "T2",
      }),
    } as never);

    expect(JSON.stringify(acks[0])).toContain("Slack workspace context does not match.");
    expect(repository.workspaceSetting?.enabled).toBe(false);
    expect(repository.allowedChannelIds).toEqual(["C1"]);
  });

  it("does not partially save feature settings when channel allowlist replacement fails", async () => {
    const updatedViews: unknown[] = [];
    const repository = new MemoryFeatureSettingsRepository({
      allowedChannelIds: ["COLD"],
      workspaceEnabled: false,
    });
    repository.failConfigurationSave = true;
    const handlers = createAgentSlackHandlers({} as never, {
      featureSettingsHome: {
        imageGenerationModelId: "openai:gpt-image-1.5",
        repository,
      },
      workspaceCredentialSettings: {
        async resolveProviderCredential() {
          return { apiKey: "sk-test" };
        },
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleFeatureSettingsModalSubmission({
      ack: async (payload?: unknown) => {
        updatedViews.push(["ack", payload]);
      },
      body: { team: { id: "T1" }, user: { id: "UADMIN" } },
      client: {
        users: {
          info: async () => ({ user: { is_admin: true } }),
        },
        views: {
          update: async (payload: unknown) => {
            updatedViews.push(payload);
            return {};
          },
        },
      },
      logger: { error() {}, warn() {} },
      view: validFeatureSettingsView({
        channelIds: ["CNEW"],
        enabled: true,
        teamId: "T1",
      }),
    } as never);

    expect(repository.workspaceSetting?.enabled).toBe(false);
    expect(repository.allowedChannelIds).toEqual(["COLD"]);
    expect(JSON.stringify(updatedViews)).toContain("Could not save feature settings.");
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
          private_metadata: expect.stringContaining('"teamId":"T1"'),
        }),
      }),
    ]);
    expect(JSON.stringify(openedViews[0])).toContain('"dispatch_action":true');
    expect(JSON.stringify(openedViews[0])).not.toContain("SORACOM AuthKey ID");
    expect(JSON.stringify(openedViews[0])).toContain("Base URL");
  });

  it("uses the configured default locale for API key modals", async () => {
    const openedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      defaultLocale: "ja",
      workspaceCredentialSettings: {
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleWorkspaceCredentialConfigureAction({
      ack: async () => {},
      body: { team: { id: "T1" }, trigger_id: "TRIGGER1", user: { id: "UADMIN" } },
      client: {
        views: {
          open: async (payload: unknown) => {
            openedViews.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    const serialized = JSON.stringify(openedViews[0]);
    expect(serialized).toContain("認証情報");
    expect(serialized).toContain("プロバイダー");
    expect(serialized).not.toContain("Credentials");
  });

  it("uses the stored user locale when it is available", async () => {
    const openedViews: unknown[] = [];
    const updatedViews: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      defaultLocale: "ja",
      userSettingsRepository: {
        async findUserSettings() {
          return {
            createdAt: new Date("2026-05-15T00:00:00Z"),
            locale: "en",
            payload: {},
            scopeId: "T1",
            scopeKind: "team",
            slackUserId: "UADMIN",
            teamId: "T1",
            updatedAt: new Date("2026-05-15T00:00:00Z"),
          };
        },
        async saveUserSettings() {},
      },
      workspaceCredentialSettings: {
        async saveProviderApiKey() {},
      },
    });

    await handlers.handleWorkspaceCredentialConfigureAction({
      ack: async () => {},
      body: { team: { id: "T1" }, trigger_id: "TRIGGER1", user: { id: "UADMIN" } },
      client: {
        views: {
          open: async (payload: unknown) => {
            openedViews.push(payload);
            return { view: { id: "VIEW1" } };
          },
          update: async (payload: unknown) => {
            updatedViews.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    const opened = JSON.stringify(openedViews[0]);
    expect(opened).toContain("認証情報");
    expect(opened).toContain("プロバイダー");
    const updated = JSON.stringify(updatedViews[0]);
    expect(updated).toContain("Credentials");
    expect(updated).toContain("Provider");
    expect(updated).not.toContain("認証情報");
  });

  it("updates the API key modal fields when SORACOM is selected", async () => {
    const updates: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never);

    await handlers.handleWorkspaceCredentialProviderSelectAction({
      ack: async () => {},
      body: {
        view: {
          id: "VIEW1",
          private_metadata: "T1",
          state: {
            values: {
              workspace_credential_provider: {
                provider_kind: { selected_option: { value: "soracom" } },
              },
            },
          },
        },
      },
      client: {
        views: {
          update: async (payload: unknown) => {
            updates.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    expect(updates).toEqual([
      expect.objectContaining({
        view_id: "VIEW1",
        view: expect.objectContaining({
          private_metadata: expect.stringContaining('"teamId":"T1"'),
        }),
      }),
    ]);
    expect(JSON.stringify(updates[0])).toContain("SORACOM AuthKey ID");
    expect(JSON.stringify(updates[0])).not.toContain("Base URL");
  });

  it("keeps the existing API key modal locale when provider selection changes", async () => {
    const updates: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, { defaultLocale: "ja" });

    await handlers.handleWorkspaceCredentialProviderSelectAction({
      ack: async () => {},
      body: {
        view: {
          id: "VIEW1",
          private_metadata: JSON.stringify({ locale: "en", teamId: "T1" }),
          state: {
            values: {
              workspace_credential_provider: {
                provider_kind: { selected_option: { value: "soracom" } },
              },
            },
          },
        },
      },
      client: {
        views: {
          update: async (payload: unknown) => {
            updates.push(payload);
            return {};
          },
        },
      },
      logger: { warn() {} },
    } as never);

    const serialized = JSON.stringify(updates[0]);
    expect(serialized).toContain("Credentials");
    expect(serialized).toContain("SORACOM AuthKey ID");
    expect(serialized).not.toContain("認証情報");
  });

  it("saves workspace provider API keys from modal submissions", async () => {
    const acks: unknown[] = [];
    const saves: unknown[] = [];
    const updates: unknown[] = [];
    let userInfoCalls = 0;
    let acked = false;
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
        acked = true;
      },
      body: { team: { id: "T1" }, user: { id: "UADMIN" } },
      client: {
        users: {
          info: async () => {
            expect(acked).toBe(true);
            userInfoCalls += 1;
            return { user: { is_owner: true } };
          },
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
    expect(userInfoCalls).toBe(1);
    expect(updates[0]).not.toHaveProperty("hash");
  });

  it("saves SORACOM AuthKey credentials from modal submissions", async () => {
    const saves: unknown[] = [];
    const handlers = createAgentSlackHandlers({} as never, {
      workspaceCredentialSettings: {
        async saveProviderApiKey(input: unknown) {
          saves.push(input);
        },
      },
    });

    await handlers.handleWorkspaceCredentialModalSubmission({
      ack: async () => {},
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
      view: {
        id: "VIEW1",
        private_metadata: "T1",
        state: {
          values: {
            workspace_credential_provider: {
              provider_kind: { selected_option: { value: "soracom" } },
            },
            workspace_credential_secret: {
              api_key: { value: "secret-test" },
            },
            workspace_credential_soracom_auth_key_id: {
              auth_key_id: { value: "keyId-test" },
            },
            workspace_credential_soracom_coverage: {
              coverage_type: { selected_option: { value: "japan" } },
            },
            workspace_credential_soracom_operator: {
              operator_id: { value: "OP0012345678" },
            },
          },
        },
      },
    } as never);

    expect(saves).toEqual([
      {
        createdByUserId: "UADMIN",
        credentialName: "auth_key",
        payload: {
          auth_key_id: "keyId-test",
          coverage_type: "japan",
          operator_id: "OP0012345678",
          source: "slack_app_home",
        },
        providerKind: "soracom",
        secret: "secret-test",
        teamId: "T1",
      },
    ]);
  });

  it("saves Google service account JSON credentials from modal submissions", async () => {
    const saves: unknown[] = [];
    const serviceAccountJson = JSON.stringify({
      client_email: "agent@project.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----\\n",
      project_id: "vertex-project",
    });
    const handlers = createAgentSlackHandlers({} as never, {
      workspaceCredentialSettings: {
        async saveProviderApiKey(input: unknown) {
          saves.push(input);
        },
      },
    });

    await handlers.handleWorkspaceCredentialModalSubmission({
      ack: async () => {},
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
      view: {
        id: "VIEW1",
        private_metadata: "T1",
        state: {
          values: {
            workspace_credential_provider: {
              provider_kind: { selected_option: { value: "google_service_account_json" } },
            },
            workspace_credential_secret: {
              api_key: { value: serviceAccountJson },
            },
          },
        },
      },
    } as never);

    expect(saves).toEqual([
      {
        createdByUserId: "UADMIN",
        credentialName: "service_account_json",
        payload: {
          project_id: "vertex-project",
          source: "slack_app_home",
        },
        providerKind: "google",
        secret: serviceAccountJson,
        teamId: "T1",
      },
    ]);
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
          model: { id: "anthropic:claude-sonnet-4-20250514", provider: "anthropic" },
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "translation-agent" },
        agentId: "configured-translator",
        modelId: "anthropic:claude-sonnet-4-20250514",
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
        modelId: "anthropic:claude-sonnet-4-20250514",
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

  it("notifies the chatting user when model routing falls back to an enabled upper setting", async () => {
    const invocations: unknown[] = [];
    const ephemerals: unknown[] = [];
    const runner = {
      async run(invocation: unknown) {
        invocations.push(invocation);
        return {
          decision: { action: "respond", reason: "forced_invocation" },
          message: "configured route",
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "assistant" },
        agentId: "assistant",
        modelFallback: {
          fromModelId: "disabled-thread-model",
          fromScope: "thread",
          toModelId: "workspace-model",
          toScope: "workspace",
        },
        modelId: "workspace-model",
        modelScope: "workspace",
        scope: "thread",
      },
      threadAutoReplyEnabled: true,
    });
    const handlers = createAgentSlackHandlers(runner as never, { routingRepository: repository });

    await handlers.handleAppMention({
      body: { team_id: "T1" },
      client: {
        chat: {
          postEphemeral: async (payload: unknown) => {
            ephemerals.push(payload);
            return {};
          },
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
      logger: { info() {}, warn() {} },
    } as never);

    expect(invocations).toEqual([expect.objectContaining({ modelId: "workspace-model" })]);
    expect(ephemerals).toEqual([
      expect.objectContaining({
        channel: "C1",
        text: expect.stringContaining("disabled-thread-model"),
        thread_ts: "1712345678.000100",
        user: "U1",
      }),
    ]);
    expect(repository.activations).toEqual([
      expect.objectContaining({
        agentId: "assistant",
        modelId: undefined,
      }),
    ]);
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
    expect(JSON.stringify(posts[0])).toContain("model_routing_configure");
    expect(JSON.stringify(posts[0])).toContain('\\"channelId\\":\\"C1\\"');
    expect(JSON.stringify(posts[0])).toContain('\\"source\\":\\"channel\\"');
    expect(JSON.stringify(posts[0])).toContain('\\"teamId\\":\\"T1\\"');
    expect(JSON.stringify(posts[0])).toContain("Channel settings");
    expect(JSON.stringify(posts[0])).toContain('"event_type":"agents_party_control"');
  });

  it("posts a settings menu for mention-only app mentions", async () => {
    let runs = 0;
    const runner = {
      async run() {
        runs += 1;
        return {
          decision: { action: "respond", reason: "empty_invocation" },
          message: "unexpected",
          toolResults: [],
        };
      },
    };
    const posts: unknown[] = [];
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "assistant-agent" },
        agentId: "assistant",
        modelId: "openai:gpt-4o",
        modelScope: "workspace",
        scope: "workspace",
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
        text: "<@B1>\n<@B1>",
        ts: "1712345678.000100",
        user: "U1",
      },
      logger: { warn() {} },
    } as never);

    const serialized = JSON.stringify(posts[0]);
    expect(runs).toBe(0);
    expect(posts).toHaveLength(1);
    expect(repository.activations).toEqual([
      expect.objectContaining({
        agentId: "assistant",
        channelId: "C1",
        lastMessageTs: "1712345678.000100",
        modelId: undefined,
        rootMessageTs: "1712345678.000100",
        teamId: "T1",
        threadTs: "1712345678.000100",
      }),
    ]);
    expect(serialized).toContain("Thread model");
    expect(serialized).toContain("Channel settings");
    expect(serialized).toContain("model_routing_thread_configure");
    expect(serialized).toContain("model_routing_channel_configure");
    expect(serialized).toContain('"event_type":"agents_party_control"');
    expect(serialized).toContain('"kind":"mention_menu"');
    expect(serialized).toContain('\\"source\\":\\"thread\\"');
    expect(serialized).toContain('\\"threadTs\\":\\"1712345678.000100\\"');
    expect(serialized).not.toContain("No agent is configured");
    const blocks = (posts[0] as { blocks: { elements?: { action_id?: string }[] }[] }).blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.elements).toHaveLength(2);
    for (const block of blocks) {
      const actionIds = block.elements?.map((element) => element.action_id).filter(Boolean) ?? [];
      expect(new Set(actionIds).size).toBe(actionIds.length);
    }
  });

  it("posts a settings menu for mention-only app mentions when bot user id is unavailable", async () => {
    let runs = 0;
    const runner = {
      async run() {
        runs += 1;
        return {
          decision: { action: "respond", reason: "empty_invocation" },
          message: "unexpected",
          toolResults: [],
        };
      },
    };
    const posts: unknown[] = [];
    const queue = new MemorySlackAgentJobQueue();
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "assistant-agent" },
        agentId: "assistant",
        modelId: "openai:gpt-4o",
        modelScope: "workspace",
        scope: "workspace",
      },
      threadAutoReplyEnabled: true,
    });
    const handlers = createAgentSlackHandlers(runner as never, {
      agentJobQueue: queue,
      routingRepository: repository,
    });

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
      context: {},
      event: {
        channel: "C1",
        text: "<@UAPP>",
        ts: "1712345678.000100",
        user: "U1",
      },
      logger: { warn() {} },
    } as never);

    expect(runs).toBe(0);
    expect(queue.jobs).toEqual([]);
    expect(repository.activations).toEqual([
      expect.objectContaining({
        agentId: "assistant",
        channelId: "C1",
        lastMessageTs: "1712345678.000100",
        teamId: "T1",
        threadTs: "1712345678.000100",
      }),
    ]);
    expect(JSON.stringify(posts[0])).toContain("model_routing_thread_configure");
    expect(JSON.stringify(posts[0])).toContain("model_routing_channel_configure");
  });

  it("posts a settings menu instead of running AI for mention-only active thread follow-ups", async () => {
    let runs = 0;
    const runner = {
      async run() {
        runs += 1;
        return {
          decision: { action: "respond", reason: "unexpected" },
          message: "unexpected",
          toolResults: [],
        };
      },
    };
    const posts: unknown[] = [];
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "assistant-agent" },
        agentId: "assistant",
        modelId: "openai:gpt-4o",
        modelScope: "thread",
        scope: "thread",
      },
      thread: {
        agent_id: "assistant",
        root_message_ts: "1712345678.000100",
        status: "active",
      },
      threadAutoReplyEnabled: true,
    });
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
          replies: async () => {
            throw new Error("Thread history should not be read for mention-only menus.");
          },
        },
      },
      context: { botUserId: "B1" },
      event: {
        channel: "C1",
        text: "<@B1>\n<@B1>",
        thread_ts: "1712345678.000100",
        ts: "1712345678.000200",
        user: "U1",
      },
      logger: { error() {}, warn() {} },
    } as never);

    const serialized = JSON.stringify(posts[0]);
    expect(runs).toBe(0);
    expect(posts).toHaveLength(1);
    expect(repository.activations).toEqual([
      expect.objectContaining({
        agentId: "assistant",
        channelId: "C1",
        lastMessageTs: "1712345678.000200",
        modelId: "openai:gpt-4o",
        rootMessageTs: "1712345678.000100",
        teamId: "T1",
        threadTs: "1712345678.000100",
      }),
    ]);
    expect(serialized).toContain("model_routing_thread_configure");
    expect(serialized).toContain("model_routing_channel_configure");
    expect(serialized).toContain('"kind":"mention_menu"');
  });

  it("does not enqueue AI jobs for mention-only active thread follow-ups", async () => {
    const runner = {
      async run() {
        throw new Error("runner should not be called");
      },
    };
    const posts: unknown[] = [];
    const queue = new MemorySlackAgentJobQueue();
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "assistant-agent" },
        agentId: "assistant",
        modelId: "openai:gpt-4o",
        modelScope: "thread",
        scope: "thread",
      },
      thread: {
        agent_id: "assistant",
        root_message_ts: "1712345678.000100",
        status: "active",
      },
      threadAutoReplyEnabled: true,
    });
    const handlers = createAgentSlackHandlers(runner as never, {
      agentJobQueue: queue,
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
      },
      context: { botUserId: "B1" },
      event: {
        channel: "C1",
        text: "<@B1>",
        thread_ts: "1712345678.000100",
        ts: "1712345678.000200",
        user: "U1",
      },
      logger: { error() {}, warn() {} },
    } as never);

    expect(queue.jobs).toEqual([]);
    expect(posts).toHaveLength(1);
    expect(repository.activations).toEqual([
      expect.objectContaining({
        lastMessageTs: "1712345678.000200",
        threadTs: "1712345678.000100",
      }),
    ]);
  });

  it("posts a model routing configure button for queued mentions with no configured agent", async () => {
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

    await processSlackAgentJob(
      {
        channelId: "C1",
        enterpriseId: "E1",
        eventType: "app_mention",
        messageTs: "1712345678.000100",
        teamId: "T1",
        text: "",
        threadTs: "1712345678.000100",
        userId: "U1",
      },
      {
        client: {
          assistant: { threads: { setStatus: async () => ({ ok: true }) } },
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
        routingRepository: repository,
        runner: runner as never,
      },
    );

    expect(runs).toBe(0);
    expect(JSON.stringify(posts[0])).toContain("model_routing_thread_configure");
    expect(JSON.stringify(posts[0])).toContain("model_routing_channel_configure");
    expect(JSON.stringify(posts[0])).toContain('\\"enterpriseId\\":\\"E1\\"');
    expect(JSON.stringify(posts[0])).toContain('\\"channelId\\":\\"C1\\"');
    expect(JSON.stringify(posts[0])).toContain('\\"teamId\\":\\"T1\\"');
    expect(JSON.stringify(posts[0])).toContain('\\"source\\":\\"thread\\"');
    expect(JSON.stringify(posts[0])).toContain('\\"threadTs\\":\\"1712345678.000100\\"');
    expect(JSON.stringify(posts[0])).toContain("Thread model");
    expect(JSON.stringify(posts[0])).toContain("Channel settings");
    expect(JSON.stringify(posts[0])).not.toContain("No agent is configured");
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

  it("formats short agent Markdown output as Slack mrkdwn blocks", async () => {
    const posts: unknown[] = [];

    await postAgentResult({
      channel: "C1",
      client: {
        chat: {
          postMessage: async (payload: unknown) => {
            posts.push(payload);
            return { ok: true };
          },
        },
      } as never,
      logger: { info() {} },
      result: undefined,
      text: "**Important**: see [docs](https://docs.slack.dev/?a=1&b=2)",
      threadTs: "1712345678.000100",
    });

    expect(posts).toEqual([
      expect.objectContaining({
        blocks: [
          {
            text: {
              text: "*Important*: see <https://docs.slack.dev/?a=1&amp;b=2|docs>",
              type: "mrkdwn",
              verbatim: true,
            },
            type: "section",
          },
        ],
        channel: "C1",
        text: "**Important**: see [docs](https://docs.slack.dev/?a=1&b=2)",
        thread_ts: "1712345678.000100",
        unfurl_links: false,
        unfurl_media: false,
      }),
    ]);
  });

  it("falls back to top-level text for agent output over the Block Kit text limit", async () => {
    const posts: unknown[] = [];
    const longText = "a".repeat(3001);

    await postAgentResult({
      channel: "C1",
      client: {
        chat: {
          postMessage: async (payload: unknown) => {
            posts.push(payload);
            return { ok: true };
          },
        },
      } as never,
      logger: { info() {} },
      result: undefined,
      text: longText,
      threadTs: "1712345678.000100",
    });

    expect(posts).toEqual([
      expect.objectContaining({
        channel: "C1",
        text: longText,
        thread_ts: "1712345678.000100",
        unfurl_links: false,
        unfurl_media: false,
      }),
    ]);
    expect(posts[0]).not.toHaveProperty("blocks");
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
      body: { api_app_id: "AAPP", team_id: "T1" },
      client: {
        chat: {
          postMessage: async (payload: unknown) => {
            posts.push(payload);
            return {};
          },
        },
        conversations: {
          replies: async (request: unknown) => {
            expect(request).toEqual(
              expect.objectContaining({
                include_all_metadata: true,
              }),
            );
            return {
              messages: [
                { team: "T1", text: "root text", ts: "1712345678.000100", user: "Uroot" },
                {
                  metadata: {
                    event_payload: {
                      kind: "mention_menu",
                    },
                    event_type: "agents_party_control",
                  },
                  text: "Model routing metadata fallback",
                  ts: "1712345678.000120",
                },
                {
                  blocks: [
                    {
                      elements: [
                        {
                          action_id: "model_routing_thread_configure",
                          text: { text: "Thread model", type: "plain_text" },
                          type: "button",
                        },
                      ],
                      type: "actions",
                    },
                  ],
                  bot_id: "BAPP",
                  text: "Model routing",
                  ts: "1712345678.000150",
                },
                {
                  bot_profile: { app_id: "AAPP", id: "BAPP", team_id: "T1" },
                  subtype: "bot_message",
                  team: "T1",
                  text: "previous bot reply",
                  ts: "1712345678.000180",
                },
                {
                  app_id: "AOTHER",
                  bot_id: "BOTHER",
                  team: "T2",
                  text: "external bot update",
                  ts: "1712345678.000185",
                },
                {
                  subtype: "file_share",
                  team: "T1",
                  text: "shared context file",
                  ts: "1712345678.000190",
                  user: "U2",
                },
                {
                  subtype: "message_changed",
                  text: "edited system event",
                  ts: "1712345678.000195",
                  user: "U2",
                },
                { text: "follow-up", ts: "1712345678.000200", user: "U1" },
              ],
            };
          },
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
        threadHistory: [
          {
            messageTs: "1712345678.000100",
            role: "user",
            teamId: "T1",
            text: "root text",
            userId: "Uroot",
          },
          {
            messageTs: "1712345678.000180",
            role: "assistant",
            teamId: "T1",
            text: "previous bot reply",
          },
          {
            messageTs: "1712345678.000190",
            role: "user",
            teamId: "T1",
            text: "shared context file",
            userId: "U2",
          },
        ],
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
              { text: "root text", ts: "1712345678.000100", user: "U1" },
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
        threadHistory: [
          {
            messageTs: "1712345678.000100",
            role: "user",
            teamId: "T1",
            text: "root text",
            userId: "U1",
          },
        ],
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
                  user: "U1",
                },
                { text: "follow-up", ts: "1712345678.000200", user: "U1" },
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
        threadHistory: [
          {
            messageTs: "1712345678.000100",
            role: "user",
            teamId: "T1",
            text: "root text",
            userId: "U1",
          },
        ],
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

  it("posts a settings menu instead of running AI for queued mention-only follow-up jobs", async () => {
    let runs = 0;
    const runner = {
      async run() {
        runs += 1;
        return {
          decision: { action: "respond", reason: "unexpected" },
          message: "unexpected",
          toolResults: [],
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "assistant-agent" },
        agentId: "assistant",
        modelId: "openai:gpt-4o",
        modelScope: "thread",
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
        botUserId: "B1",
        channelId: "C1",
        eventType: "message_follow_up",
        messageTs: "1712345678.000200",
        teamId: "T1",
        text: "<@B1>",
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
            replies: async () => {
              throw new Error("Thread history should not be read for mention-only menus.");
            },
          },
        } as never,
        logger: { error() {}, info() {}, warn() {} },
        routingRepository: repository,
        runner: runner as never,
      },
    );

    expect(runs).toBe(0);
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(posts[0])).toContain("model_routing_thread_configure");
    expect(repository.activations).toEqual([
      expect.objectContaining({
        lastMessageTs: "1712345678.000200",
        modelId: "openai:gpt-4o",
        threadTs: "1712345678.000100",
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
    let userInfoCalls = 0;
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
      client: {
        chat: { postMessage: async () => ({}) },
        users: {
          info: async () => {
            userInfoCalls += 1;
            return { user: { locale: "en-US" } };
          },
        },
      },
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
    expect(userInfoCalls).toBe(0);
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
      async runStructured(invocation: unknown, responseFormat: unknown) {
        invocations.push(invocation);
        invocations.push(responseFormat);
        return {
          model: { id: "anthropic:claude-sonnet-4-20250514", provider: "anthropic" },
          structuredOutput: { translatedText: "こんにちは" },
        };
      },
    };
    const posts: unknown[] = [];
    const statuses: unknown[] = [];
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "translation-agent" },
        agentId: "translation",
        modelId: "anthropic:claude-sonnet-4-20250514",
        modelScope: "channel",
        scope: "channel",
      },
      threadAutoReplyEnabled: true,
    });
    const handlers = createAgentSlackHandlers(runner as never, { routingRepository: repository });

    await handlers.handleReactionAdded({
      body: { team_id: "T1" },
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
        modelId: "anthropic:claude-sonnet-4-20250514",
        teamId: "T1",
        text: expect.stringContaining("Translate the following Slack message to ja."),
        threadTs: "1712345678.000100",
        userId: "U1",
      }),
      expect.objectContaining({ type: "json" }),
    ]);
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
        text: "こんにちは",
        thread_ts: "1712345678.000100",
      }),
    ]);
  });

  it("sets Slack assistant thread status when queued reaction translation starts", async () => {
    const statuses: unknown[] = [];
    const runner = {
      async runStructured() {
        return {
          structuredOutput: { translatedText: "こんにちは" },
        };
      },
    };
    const posts: unknown[] = [];
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "translation-agent" },
        agentId: "translation",
        modelId: "anthropic:claude-sonnet-4-20250514",
        modelScope: "channel",
        scope: "channel",
      },
      threadAutoReplyEnabled: true,
    });

    await processSlackAgentJob(
      {
        channelId: "C1",
        eventType: "reaction_added",
        messageTs: "1712345678.000200",
        targetLanguage: "ja",
        teamId: "T1",
        text: "",
        threadTs: "1712345678.000200",
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
          conversations: {
            history: async () => ({
              messages: [
                {
                  text: "hello",
                  thread_ts: "1712345678.000100",
                  ts: "1712345678.000200",
                },
              ],
            }),
          },
        } as never,
        logger: { error() {}, info() {}, warn() {} },
        routingRepository: repository,
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
        text: "こんにちは",
        thread_ts: "1712345678.000100",
      }),
    ]);
  });

  it("does not set Slack assistant thread status when direct reaction routing has no agent", async () => {
    const statuses: unknown[] = [];
    const runner = {
      async runStructured() {
        throw new Error("runner should not be called");
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      threadAutoReplyEnabled: true,
    });
    const handlers = createAgentSlackHandlers(runner as never, { routingRepository: repository });

    await handlers.handleReactionAdded({
      body: { team_id: "T1" },
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

    expect(statuses).toEqual([]);
  });

  it("does not set Slack assistant thread status when queued reaction routing has no agent", async () => {
    const statuses: unknown[] = [];
    const runner = {
      async runStructured() {
        throw new Error("runner should not be called");
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      threadAutoReplyEnabled: true,
    });

    await processSlackAgentJob(
      {
        channelId: "C1",
        eventType: "reaction_added",
        messageTs: "1712345678.000100",
        targetLanguage: "ja",
        teamId: "T1",
        text: "",
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
        } as never,
        logger: { error() {}, info() {}, warn() {} },
        routingRepository: repository,
        runner: runner as never,
      },
    );

    expect(statuses).toEqual([]);
  });

  it("does not set Slack assistant thread status when queued reaction source fetch fails", async () => {
    const statuses: unknown[] = [];
    const posts: unknown[] = [];
    const runner = {
      async runStructured() {
        throw new Error("runner should not be called");
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "translation-agent" },
        agentId: "translation",
        modelId: "anthropic:claude-sonnet-4-20250514",
        modelScope: "channel",
        scope: "channel",
      },
      threadAutoReplyEnabled: true,
    });

    await processSlackAgentJob(
      {
        channelId: "C1",
        eventType: "reaction_added",
        messageTs: "1712345678.000200",
        targetLanguage: "ja",
        teamId: "T1",
        text: "",
        threadTs: "1712345678.000200",
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
          conversations: {
            history: async () => ({ messages: [] }),
            replies: async () => ({ messages: [] }),
          },
        } as never,
        logger: { error() {}, info() {}, warn() {} },
        routingRepository: repository,
        runner: runner as never,
      },
    );

    expect(statuses).toEqual([]);
    expect(posts).toEqual([
      expect.objectContaining({
        text: "I couldn't read text from the reacted message.",
        thread_ts: "1712345678.000200",
      }),
    ]);
  });

  it("preserves Slack rich-text mentions when translating flag reactions", async () => {
    const invocations: unknown[] = [];
    const runner = {
      async runStructured(invocation: unknown) {
        invocations.push(invocation);
        return {
          structuredOutput: { translatedText: "確認しました" },
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "translation-agent" },
        agentId: "translation",
        modelId: "anthropic:claude-sonnet-4-20250514",
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
        conversations: {
          history: async () => ({
            messages: [
              {
                blocks: [
                  {
                    elements: [
                      {
                        elements: [
                          { text: "Please ask ", type: "text" },
                          { type: "user", user_id: "U123" },
                          { text: " in ", type: "text" },
                          { channel_id: "C999", type: "channel" },
                        ],
                        type: "rich_text_section",
                      },
                    ],
                    type: "rich_text",
                  },
                ],
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
        text: expect.stringContaining("Please ask <@U123> in <#C999>"),
      }),
    ]);
  });

  it("does not translate reactions in disabled channels", async () => {
    let runs = 0;
    const runner = {
      async runStructured() {
        runs += 1;
        return {
          structuredOutput: { translatedText: "こんにちは" },
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
      async runStructured() {
        runs += 1;
        return {
          structuredOutput: { translatedText: "こんにちは" },
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "legacy-agent" },
        agentId: "bad-agent",
        modelId: "anthropic:claude-sonnet-4-20250514",
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
      async runStructured() {
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
      async runStructured() {
        runs += 1;
        return {
          structuredOutput: { translatedText: "こんにちは" },
        };
      },
    };
    const repository = new MemoryRoutingRepository({
      channelEnabled: true,
      route: {
        agent: { name: "assistant-agent" },
        agentId: "assistant",
        modelId: "anthropic:claude-sonnet-4-20250514",
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
      async runStructured() {
        runs += 1;
        return {
          structuredOutput: { translatedText: "こんにちは" },
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

function modelRoutingView(input: {
  blocks: Record<string, unknown>[];
  defaultModelId: string;
  reasoningEffort?: string;
}): unknown {
  return {
    blocks: input.blocks,
    callback_id: "model_routing_modal",
    close: { text: "Close", type: "plain_text" },
    hash: "HASH1",
    id: "VIEW1",
    private_metadata: JSON.stringify({ source: "app_home", teamId: "T1" }),
    state: {
      values: {
        model_routing_default_model: {
          default_model: {
            selected_option: { value: input.defaultModelId },
          },
        },
        ...(input.reasoningEffort === undefined
          ? {}
          : {
              model_routing_reasoning_effort: {
                reasoning_effort: {
                  selected_option: { value: input.reasoningEffort },
                },
              },
            }),
      },
    },
    submit: { text: "Save", type: "plain_text" },
    title: { text: "Model routing", type: "plain_text" },
    type: "modal",
  };
}

function validFeatureSettingsView(input: {
  channelIds: string[];
  enabled: boolean;
  enterpriseId?: string;
  imageGenerationModelId?: string;
  teamId: string;
}): unknown {
  return {
    hash: "HASH1",
    id: "VIEW1",
    private_metadata: JSON.stringify({
      enterpriseId: input.enterpriseId,
      source: "app_home",
      teamId: input.teamId,
    }),
    state: {
      values: {
        feature_settings_image_generation_channels: {
          image_generation_channels: { selected_conversations: input.channelIds },
        },
        feature_settings_image_generation_enabled: {
          image_generation_enabled: {
            selected_options: input.enabled ? [{ value: "enabled" }] : [],
          },
        },
        ...(input.imageGenerationModelId === undefined
          ? {}
          : {
              feature_settings_image_generation_model: {
                image_generation_model: {
                  selected_option: { value: input.imageGenerationModelId },
                },
              },
            }),
      },
    },
  };
}

class MemoryFeatureSettingsRepository implements WorkspaceFeatureSettingsRepository {
  allowedChannelIds: string[];
  failConfigurationSave = false;
  workspaceSetting: WorkspaceFeatureSettingDocument | undefined;

  constructor(input: { allowedChannelIds?: string[]; workspaceEnabled?: boolean } = {}) {
    this.allowedChannelIds = input.allowedChannelIds ?? [];
    if (input.workspaceEnabled !== undefined) {
      this.workspaceSetting = {
        enabled: input.workspaceEnabled,
        featureKey: "image_generation",
        payload: {},
        teamId: "T1",
        updatedAt: new Date("2026-05-19T00:00:00Z"),
      };
    }
  }

  async findWorkspaceFeatureSetting(input: {
    featureKey: WorkspaceFeatureKey;
    teamId: string;
  }): Promise<WorkspaceFeatureSettingDocument | undefined> {
    return this.workspaceSetting?.teamId === input.teamId &&
      this.workspaceSetting.featureKey === input.featureKey
      ? this.workspaceSetting
      : undefined;
  }

  async saveWorkspaceFeatureSetting(document: WorkspaceFeatureSettingDocument): Promise<void> {
    this.workspaceSetting = document;
  }

  async listAllowedChannels(input: {
    featureKey: WorkspaceFeatureKey;
    teamId: string;
  }): Promise<ChannelFeatureSettingDocument[]> {
    return this.allowedChannelIds.map((channelId) => ({
      channelId,
      featureKey: input.featureKey,
      payload: {},
      teamId: input.teamId,
      updatedAt: new Date("2026-05-19T00:00:00Z"),
    }));
  }

  async isChannelAllowed(input: {
    channelId: string;
    featureKey: WorkspaceFeatureKey;
    teamId: string;
  }): Promise<boolean> {
    return (
      input.featureKey === "image_generation" &&
      input.teamId === "T1" &&
      this.allowedChannelIds.includes(input.channelId)
    );
  }

  async replaceAllowedChannels(input: {
    channelIds: readonly string[];
    featureKey: WorkspaceFeatureKey;
    teamId: string;
  }): Promise<void> {
    this.allowedChannelIds = [...input.channelIds];
  }

  async saveWorkspaceFeatureConfiguration(input: {
    allowedChannelIds: readonly string[];
    workspaceSetting: WorkspaceFeatureSettingDocument;
  }): Promise<void> {
    if (this.failConfigurationSave) {
      throw new Error("configuration save failed");
    }
    this.workspaceSetting = input.workspaceSetting;
    this.allowedChannelIds = [...input.allowedChannelIds];
  }
}

class MemoryRoutingRepository {
  readonly activations: unknown[] = [];

  constructor(
    private readonly options: {
      channelEnabled: boolean;
      route?: {
        agent: JsonObject;
        agentId: string;
        modelFallback?: {
          fromModelId: string;
          fromScope: string;
          toModelId?: string;
          toScope?: string;
        };
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
        modelFallback?: {
          fromModelId: string;
          fromScope: string;
          toModelId?: string;
          toScope?: string;
        };
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
