import { jsonSchema, type ToolSet } from "ai";
import { describe, expect, it } from "vite-plus/test";

import {
  createSlackMcpToolSet,
  type SlackMcpToolContext,
  type SlackMcpTokenResolver,
} from "../../../src/agents/slackMcp/index.js";

describe("createSlackMcpToolSet", () => {
  it("exposes a focused set of Slack MCP tools from the MCP server toolset", async () => {
    const handle = await createSlackMcpToolSet({
      clientFactory: fakeClientFactory({
        extra_slack_tool: fakeTool(),
        slack_create_canvas: fakeTool(),
        slack_read_channel: fakeTool(),
        slack_read_canvas: fakeTool(),
        slack_read_thread: fakeTool(),
        slack_read_user_profile: fakeTool(),
        slack_search_public: fakeTool(),
        slack_update_canvas: fakeTool(),
      }),
      context: context(),
      tokenResolver: tokenResolver("xoxp-token"),
    });

    expect(Object.keys(handle?.tools ?? {})).toEqual([
      "slack_create_canvas",
      "slack_read_canvas",
      "slack_search_public",
      "slack_read_channel",
      "slack_read_thread",
      "slack_read_user_profile",
      "slack_update_canvas",
    ]);
  });

  it("adds the invocation channel to Slack Canvas creation inputs when the MCP schema supports it", async () => {
    const calls: unknown[] = [];
    const handle = await createSlackMcpToolSet({
      clientFactory: fakeClientFactory({
        slack_create_canvas: fakeTool(
          async (input) => {
            calls.push(input);
            return { content: [{ text: "created", type: "text" }] };
          },
          {
            properties: {
              channel_ids: { items: { type: "string" }, type: "array" },
              markdown: { type: "string" },
              title: { type: "string" },
            },
            type: "object",
          },
        ),
      }),
      context: context(),
      tokenResolver: tokenResolver("xoxp-token"),
    });

    await expect(
      executeTool(handle?.tools, "slack_create_canvas", {
        markdown: "# Summary",
        title: "Summary",
      }),
    ).resolves.toEqual({
      content: [{ text: "created", type: "text" }],
    });
    expect(calls).toEqual([{ channel_ids: ["C1"], markdown: "# Summary", title: "Summary" }]);
  });

  it("shares Slack MCP-created Canvases with the invocation channel and grants user edit access", async () => {
    const accessSets: unknown[] = [];
    const handle = await createSlackMcpToolSet({
      canvasAccessSetter: {
        async setCanvasAccess(input) {
          accessSets.push(input);
        },
      },
      clientFactory: fakeClientFactory({
        slack_create_canvas: fakeTool(async () => ({
          content: [
            {
              text: "Canvasを作成しました: https://app.slack.com/docs/T1/F0B6PN7YQZ",
              type: "text",
            },
          ],
        })),
      }),
      context: context({ viewerContextChannelIds: ["C1", "D1", "C1"] }),
      tokenResolver: tokenResolver("xoxp-token"),
    });

    await expect(
      executeTool(handle?.tools, "slack_create_canvas", {
        content: "# Summary",
        title: "Summary",
      }),
    ).resolves.toEqual({
      content: [
        {
          text: "Canvasを作成しました: https://app.slack.com/docs/T1/F0B6PN7YQZ",
          type: "text",
        },
      ],
    });
    expect(accessSets).toEqual([
      expect.objectContaining({
        canvasId: "F0B6PN7YQZ",
        channelAccessLevel: "read",
        channelIds: ["C1"],
        teamId: "T1",
        token: "xoxp-token",
        userAccessLevel: "write",
        userId: "U1",
        userIds: ["U1"],
      }),
    ]);
  });

  it("does not share arbitrary Canvas ids from Canvas creation result text", async () => {
    const accessSets: unknown[] = [];
    const handle = await createSlackMcpToolSet({
      canvasAccessSetter: {
        async setCanvasAccess(input) {
          accessSets.push(input);
        },
      },
      clientFactory: fakeClientFactory({
        slack_create_canvas: fakeTool(async () => ({
          content: [
            {
              text: "Created a Canvas. Referenced Canvas id in content: F0B6OLD1111",
              type: "text",
            },
          ],
        })),
      }),
      context: context(),
      tokenResolver: tokenResolver("xoxp-token"),
    });

    await expect(
      executeTool(handle?.tools, "slack_create_canvas", {
        content: "# Summary",
        title: "Summary",
      }),
    ).resolves.toEqual({
      content: [
        {
          text: "Created a Canvas. Referenced Canvas id in content: F0B6OLD1111",
          type: "text",
        },
        {
          text: "Canvas was created, but Agents Party could not identify the created Canvas id to share it with the current Slack channel.",
          type: "text",
        },
      ],
    });
    expect(accessSets).toEqual([]);
  });

  it("does not share Canvas creation results with ambiguous same-team Canvas URLs", async () => {
    const accessSets: unknown[] = [];
    const handle = await createSlackMcpToolSet({
      canvasAccessSetter: {
        async setCanvasAccess(input) {
          accessSets.push(input);
        },
      },
      clientFactory: fakeClientFactory({
        slack_create_canvas: fakeTool(async () => ({
          content: [
            {
              text: "Canvas links: https://app.slack.com/docs/T1/F0B6NEW1111 and https://app.slack.com/docs/T1/F0B6OLD1111",
              type: "text",
            },
          ],
        })),
      }),
      context: context(),
      tokenResolver: tokenResolver("xoxp-token"),
    });

    await executeTool(handle?.tools, "slack_create_canvas", {
      content: "# Summary",
      title: "Summary",
    });

    expect(accessSets).toEqual([]);
  });

  it("adds a model-visible status when Slack Canvas permission updates fail", async () => {
    const handle = await createSlackMcpToolSet({
      canvasAccessSetter: {
        async setCanvasAccess() {
          throw new Error("restricted_action");
        },
      },
      clientFactory: fakeClientFactory({
        slack_create_canvas: fakeTool(async () => ({
          content: [
            {
              text: "Canvasを作成しました: https://app.slack.com/docs/T1/F0B6PN7YQZ",
              type: "text",
            },
          ],
        })),
      }),
      context: context(),
      tokenResolver: tokenResolver("xoxp-token"),
    });

    await expect(
      executeTool(handle?.tools, "slack_create_canvas", {
        content: "# Summary",
        title: "Summary",
      }),
    ).resolves.toEqual({
      content: [
        {
          text: "Canvasを作成しました: https://app.slack.com/docs/T1/F0B6PN7YQZ",
          type: "text",
        },
        {
          text: "Canvas was created, but Agents Party could not finish sharing it with the current Slack channel and granting the user edit access. Tell the user that Canvas permission updates failed and include the Canvas link.",
          type: "text",
        },
      ],
    });
  });

  it("does not overwrite explicit Slack Canvas creation channel inputs", async () => {
    const calls: unknown[] = [];
    const handle = await createSlackMcpToolSet({
      clientFactory: fakeClientFactory({
        slack_create_canvas: fakeTool(
          async (input) => {
            calls.push(input);
            return { content: [{ text: "created", type: "text" }] };
          },
          {
            properties: {
              channel_id: { type: "string" },
              markdown: { type: "string" },
            },
            type: "object",
          },
        ),
      }),
      context: context(),
      tokenResolver: tokenResolver("xoxp-token"),
    });

    await expect(
      executeTool(handle?.tools, "slack_create_canvas", {
        channel_id: "C1",
        markdown: "# Summary",
      }),
    ).resolves.toEqual({
      content: [{ text: "created", type: "text" }],
    });
    expect(calls).toEqual([{ channel_id: "C1", markdown: "# Summary" }]);
  });

  it("rejects Slack Canvas creation shares outside the invocation channel allowlist", async () => {
    const calls: unknown[] = [];
    const handle = await createSlackMcpToolSet({
      clientFactory: fakeClientFactory({
        slack_create_canvas: fakeTool(
          async (input) => {
            calls.push(input);
            return { content: [{ text: "created", type: "text" }] };
          },
          {
            properties: {
              channel_ids: { items: { type: "string" }, type: "array" },
              markdown: { type: "string" },
            },
            type: "object",
          },
        ),
      }),
      context: context(),
      tokenResolver: tokenResolver("xoxp-token"),
    });

    for (const input of [
      { channel_id: "C2", markdown: "# Summary" },
      { channel_ids: ["C1", "C2"], markdown: "# Summary" },
      { channelIds: ["C2"], markdown: "# Summary" },
    ]) {
      await expect(executeTool(handle?.tools, "slack_create_canvas", input)).resolves.toMatchObject(
        {
          code: "slack_mcp_channel_not_allowed",
          ok: false,
          reconnectRequired: false,
        },
      );
    }
    expect(calls).toEqual([]);
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

  it("allows Canvas updates when the requested Canvas id is the only Canvas id in the invocation text", async () => {
    const calls: unknown[] = [];
    const handle = await createSlackMcpToolSet({
      clientFactory: fakeClientFactory({
        slack_update_canvas: fakeTool(async (input) => {
          calls.push(input);
          return { content: [{ text: "updated", type: "text" }] };
        }),
      }),
      context: context({
        sourceText: "https://app.slack.com/docs/t073dhgg11b/f0b6j9e45cl",
      }),
      tokenResolver: tokenResolver("xoxp-token"),
    });

    await expect(
      executeTool(handle?.tools, "slack_update_canvas", {
        canvas_id: "f0b6j9e45cl",
        markdown: "# Updated",
      }),
    ).resolves.toEqual({
      content: [{ text: "updated", type: "text" }],
    });
    expect(calls).toEqual([{ canvas_id: "f0b6j9e45cl", markdown: "# Updated" }]);
  });

  it("rejects Canvas updates when the target Canvas id is missing or differs from the request", async () => {
    const calls: unknown[] = [];
    const handle = await createSlackMcpToolSet({
      clientFactory: fakeClientFactory({
        slack_update_canvas: fakeTool(async (input) => {
          calls.push(input);
          return { content: [{ text: "updated", type: "text" }] };
        }),
      }),
      context: context({ sourceText: "F0B6J9E45CL を更新して" }),
      tokenResolver: tokenResolver("xoxp-token"),
    });

    for (const input of [{}, { canvas_id: "F9999999999" }, { canvas_id: "" }]) {
      await expect(executeTool(handle?.tools, "slack_update_canvas", input)).resolves.toMatchObject(
        {
          code: "slack_mcp_canvas_not_explicit",
          ok: false,
          reconnectRequired: false,
        },
      );
    }
    expect(calls).toEqual([]);
  });

  it("rejects Canvas updates when multiple Canvas ids make the target ambiguous", async () => {
    const calls: unknown[] = [];
    const handle = await createSlackMcpToolSet({
      clientFactory: fakeClientFactory({
        slack_update_canvas: fakeTool(async (input) => {
          calls.push(input);
          return { content: [{ text: "updated", type: "text" }] };
        }),
      }),
      context: context({ sourceText: "F0B6J9E45CL の内容を F9999999999 に追記して" }),
      tokenResolver: tokenResolver("xoxp-token"),
    });

    await expect(
      executeTool(handle?.tools, "slack_update_canvas", { canvas_id: "F9999999999" }),
    ).resolves.toMatchObject({
      code: "slack_mcp_canvas_not_explicit",
      ok: false,
      reconnectRequired: false,
    });
    expect(calls).toEqual([]);
  });

  it("does not treat ordinary lowercase words as Canvas ids", async () => {
    const calls: unknown[] = [];
    const handle = await createSlackMcpToolSet({
      clientFactory: fakeClientFactory({
        slack_update_canvas: fakeTool(async (input) => {
          calls.push(input);
          return { content: [{ text: "updated", type: "text" }] };
        }),
      }),
      context: context({
        sourceText: "https://app.slack.com/docs/t073dhgg11b/f0b6j9e45cl の feedback を反映して",
      }),
      tokenResolver: tokenResolver("xoxp-token"),
    });

    await expect(
      executeTool(handle?.tools, "slack_update_canvas", {
        canvas_id: "f0b6j9e45cl",
        markdown: "# Updated",
      }),
    ).resolves.toEqual({
      content: [{ text: "updated", type: "text" }],
    });
    expect(calls).toEqual([{ canvas_id: "f0b6j9e45cl", markdown: "# Updated" }]);
  });
});

function context(overrides: Partial<SlackMcpToolContext> = {}): SlackMcpToolContext {
  return {
    enterpriseId: "E1",
    isEnterpriseInstall: false,
    sourceText: "hello",
    teamId: "T1",
    userId: "U1",
    viewerContextChannelIds: ["C1"],
    ...overrides,
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
  inputSchema: Parameters<typeof jsonSchema>[0] = { type: "object" },
) {
  return {
    description: "Fake MCP tool.",
    execute,
    inputSchema: jsonSchema(inputSchema),
    type: "dynamic" as const,
  } as ToolSet[string];
}

async function executeTool(tools: ToolSet | undefined, name: string, input: unknown) {
  const execute = tools?.[name]?.execute;
  expect(execute).toBeDefined();
  return execute?.(input as never, { messages: [], toolCallId: "call-1" });
}
