import { describe, expect, it } from "vite-plus/test";

import {
  createSlackMcpAgentTools,
  type SlackMcpTokenResolver,
} from "../../../src/agents/slackMcp/index.js";

describe("createSlackMcpAgentTools", () => {
  it("exposes a focused set of Slack MCP read/search tools", () => {
    const tools = createSlackMcpAgentTools({
      context: context(),
      tokenResolver: tokenResolver("xoxp-token"),
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "slack_search_public",
      "slack_read_channel",
      "slack_read_thread",
      "slack_read_user_profile",
    ]);
    expect(tools[0]?.parameters).toMatchObject({
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
      type: "object",
    });
  });

  it("uses the invocation-scoped installation user token when executing a tool", async () => {
    const calls: unknown[] = [];
    const [tool] = createSlackMcpAgentTools({
      client: {
        async callTool(input) {
          calls.push(input);
          return {
            content: [{ text: "search result", type: "text" }],
          };
        },
      },
      context: context(),
      tokenResolver: tokenResolver("xoxp-token"),
    });

    await expect(tool?.execute({ query: "from:<@U1> on:2026-05-19" })).resolves.toMatchObject({
      ok: true,
      toolName: "slack_search_public",
    });
    expect(calls).toEqual([
      {
        arguments: { query: "from:<@U1> on:2026-05-19" },
        name: "slack_search_public",
        token: "xoxp-token",
      },
    ]);
  });

  it("fails closed when the installing user has no stored token", async () => {
    const [tool] = createSlackMcpAgentTools({
      client: {
        async callTool() {
          throw new Error("should not call MCP without a user token");
        },
      },
      context: context(),
      tokenResolver: {
        async resolve() {
          return undefined;
        },
      },
    });

    await expect(tool?.execute({ query: "hello" })).resolves.toMatchObject({
      code: "slack_mcp_user_token_missing",
      ok: false,
      reconnectRequired: true,
    });
  });

  it("rejects channel reads outside the invocation channel allowlist", async () => {
    const tools = createSlackMcpAgentTools({
      client: {
        async callTool() {
          throw new Error("should not call MCP for a disallowed channel");
        },
      },
      context: context(),
      tokenResolver: tokenResolver("xoxp-token"),
    });
    const tool = tools.find((candidate) => candidate.name === "slack_read_channel");

    await expect(tool?.execute({ channel_id: "C2" })).resolves.toMatchObject({
      code: "slack_mcp_channel_not_allowed",
      ok: false,
      reconnectRequired: false,
    });
  });

  it("allows thread reads in the invocation channel", async () => {
    const calls: unknown[] = [];
    const tools = createSlackMcpAgentTools({
      client: {
        async callTool(input) {
          calls.push(input);
          return {
            content: [{ text: "thread", type: "text" }],
          };
        },
      },
      context: context(),
      tokenResolver: tokenResolver("xoxp-token"),
    });
    const tool = tools.find((candidate) => candidate.name === "slack_read_thread");

    await expect(tool?.execute({ channel_id: "C1", thread_ts: "1.2" })).resolves.toMatchObject({
      ok: true,
      toolName: "slack_read_thread",
    });
    expect(calls).toEqual([
      {
        arguments: { channel_id: "C1", thread_ts: "1.2" },
        name: "slack_read_thread",
        token: "xoxp-token",
      },
    ]);
  });
});

function context() {
  return {
    enterpriseId: "E1",
    isEnterpriseInstall: false,
    teamId: "T1",
    userId: "U1",
    viewerContextChannelIds: ["C1"],
  };
}

function tokenResolver(token: string): SlackMcpTokenResolver {
  return {
    async resolve(input) {
      expect(input).toMatchObject({
        enterpriseId: "E1",
        teamId: "T1",
        userId: "U1",
      });
      return { token };
    },
  };
}
