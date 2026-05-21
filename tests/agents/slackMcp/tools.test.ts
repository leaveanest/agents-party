import { jsonSchema, type ToolSet } from "ai";
import { describe, expect, it } from "vite-plus/test";

import {
  createSlackMcpToolSet,
  type SlackMcpTokenResolver,
} from "../../../src/agents/slackMcp/index.js";

describe("createSlackMcpToolSet", () => {
  it("exposes a focused set of Slack MCP tools from the MCP server toolset", async () => {
    const handle = await createSlackMcpToolSet({
      clientFactory: fakeClientFactory({
        extra_slack_tool: fakeTool(),
        slack_read_channel: fakeTool(),
        slack_read_thread: fakeTool(),
        slack_read_user_profile: fakeTool(),
        slack_search_public: fakeTool(),
      }),
      context: context(),
      tokenResolver: tokenResolver("xoxp-token"),
    });

    expect(Object.keys(handle?.tools ?? {})).toEqual([
      "slack_search_public",
      "slack_read_channel",
      "slack_read_thread",
      "slack_read_user_profile",
    ]);
  });

  it("uses the invocation-scoped installation user token when creating the MCP client", async () => {
    const createdWithTokens: string[] = [];
    const toolCalls: unknown[] = [];
    const handle = await createSlackMcpToolSet({
      clientFactory: async ({ token }) => {
        createdWithTokens.push(token);
        return fakeClient({
          slack_search_public: fakeTool(async (input) => {
            toolCalls.push(input);
            return {
              content: [{ text: "search result", type: "text" }],
            };
          }),
        });
      },
      context: context(),
      tokenResolver: tokenResolver("xoxp-token"),
    });

    await expect(
      executeTool(handle?.tools, "slack_search_public", {
        query: "from:<@U1> on:2026-05-19",
      }),
    ).resolves.toEqual({
      content: [{ text: "search result", type: "text" }],
    });
    expect(createdWithTokens).toEqual(["xoxp-token"]);
    expect(toolCalls).toEqual([{ query: "from:<@U1> on:2026-05-19" }]);
  });

  it("does not expose Slack MCP tools when the installing user has no stored token", async () => {
    const handle = await createSlackMcpToolSet({
      clientFactory: async () => {
        throw new Error("should not create an MCP client without a user token");
      },
      context: context(),
      tokenResolver: {
        async resolve() {
          return undefined;
        },
      },
    });

    expect(handle).toBeUndefined();
  });

  it("closes the MCP client when listing server tools times out", async () => {
    const closes: string[] = [];

    await expect(
      createSlackMcpToolSet({
        clientFactory: async () => ({
          async close() {
            closes.push("closed");
          },
          async tools() {
            await new Promise(() => {});
            return {};
          },
        }),
        context: context(),
        tokenResolver: tokenResolver("xoxp-token"),
        toolsListTimeoutMs: 1,
      }),
    ).rejects.toThrow("Slack MCP tools list timed out after 1ms.");
    expect(closes).toEqual(["closed"]);
  });

  it("rejects channel reads outside the invocation channel allowlist before MCP execution", async () => {
    const calls: unknown[] = [];
    const handle = await createSlackMcpToolSet({
      clientFactory: fakeClientFactory({
        slack_read_channel: fakeTool(async (input) => {
          calls.push(input);
          return { content: [{ text: "channel", type: "text" }] };
        }),
      }),
      context: context(),
      tokenResolver: tokenResolver("xoxp-token"),
    });

    await expect(
      executeTool(handle?.tools, "slack_read_channel", { channel_id: "C2" }),
    ).resolves.toMatchObject({
      code: "slack_mcp_channel_not_allowed",
      ok: false,
      reconnectRequired: false,
    });
    expect(calls).toEqual([]);
  });

  it("rejects channel reads without a non-empty channel id before MCP execution", async () => {
    const calls: unknown[] = [];
    const handle = await createSlackMcpToolSet({
      clientFactory: fakeClientFactory({
        slack_read_channel: fakeTool(async (input) => {
          calls.push(input);
          return { content: [{ text: "channel", type: "text" }] };
        }),
        slack_read_thread: fakeTool(async (input) => {
          calls.push(input);
          return { content: [{ text: "thread", type: "text" }] };
        }),
      }),
      context: context(),
      tokenResolver: tokenResolver("xoxp-token"),
    });

    for (const [toolName, input] of [
      ["slack_read_channel", {}],
      ["slack_read_channel", { channel_id: "" }],
      ["slack_read_channel", { channel_id: "   " }],
      ["slack_read_thread", {}],
      ["slack_read_thread", { channel_id: "" }],
    ] as const) {
      await expect(executeTool(handle?.tools, toolName, input)).resolves.toMatchObject({
        code: "slack_mcp_channel_not_allowed",
        ok: false,
        reconnectRequired: false,
      });
    }
    expect(calls).toEqual([]);
  });

  it("allows thread reads in the invocation channel", async () => {
    const calls: unknown[] = [];
    const handle = await createSlackMcpToolSet({
      clientFactory: fakeClientFactory({
        slack_read_thread: fakeTool(async (input) => {
          calls.push(input);
          return { content: [{ text: "thread", type: "text" }] };
        }),
      }),
      context: context(),
      tokenResolver: tokenResolver("xoxp-token"),
    });

    await expect(
      executeTool(handle?.tools, "slack_read_thread", { channel_id: "C1", thread_ts: "1.2" }),
    ).resolves.toEqual({
      content: [{ text: "thread", type: "text" }],
    });
    expect(calls).toEqual([{ channel_id: "C1", thread_ts: "1.2" }]);
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

function fakeClientFactory(tools: ToolSet) {
  return async () => fakeClient(tools);
}

function fakeClient(tools: ToolSet) {
  return {
    async close() {},
    async tools() {
      return tools;
    },
  };
}

function fakeTool(
  execute: (input: unknown) => unknown | Promise<unknown> = async () => ({
    content: [{ text: "ok", type: "text" }],
  }),
) {
  return {
    description: "Fake MCP tool.",
    execute,
    inputSchema: jsonSchema({ type: "object" }),
    type: "dynamic" as const,
  } as ToolSet[string];
}

async function executeTool(tools: ToolSet | undefined, name: string, input: unknown) {
  const execute = tools?.[name]?.execute;
  expect(execute).toBeDefined();
  return execute?.(input as never, { messages: [], toolCallId: "call-1" });
}
