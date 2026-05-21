import { describe, expect, it } from "vite-plus/test";

import { createSlackRealTimeSearchAgentTools } from "../../../src/agents/slackSearch/index.js";
import type { SlackRealTimeSearchGateway } from "../../../src/slack/realTimeSearch.js";

describe("createSlackRealTimeSearchAgentTools", () => {
  it("uses the invocation-scoped user token and searches Slack with safe defaults", async () => {
    const createdWithTokens: string[] = [];
    const searches: unknown[] = [];
    const tool = createSlackRealTimeSearchAgentTools({
      context: context(),
      gatewayFactory: ({ token }) => {
        createdWithTokens.push(token);
        return fakeGateway({
          async searchContext(input) {
            searches.push(input);
            return {
              channels: [],
              files: [],
              messages: [
                {
                  channelId: "C1",
                  content: "Launch plan",
                  messageTs: "1.2",
                  teamId: "T1",
                },
              ],
              nextCursor: "cursor-2",
              ok: true,
              users: [],
            };
          },
        });
      },
      tokenResolver: tokenResolver("xoxp-token"),
    })[0];

    await expect(tool.execute({ query: "launch" })).resolves.toEqual({
      message: "Slack Real-time Search returned 1 result.",
      nextCursor: "cursor-2",
      ok: true,
      results: {
        channels: [],
        files: [],
        messages: [
          {
            channelId: "C1",
            content: "Launch plan",
            messageTs: "1.2",
            teamId: "T1",
          },
        ],
        users: [],
      },
    });
    expect(createdWithTokens).toEqual(["xoxp-token"]);
    expect(searches).toEqual([
      {
        after: undefined,
        before: undefined,
        channelTypes: ["public_channel", "private_channel", "mpim", "im"],
        contentTypes: ["messages"],
        contextChannelId: "C1",
        cursor: undefined,
        includeContextMessages: true,
        includeMessageBlocks: false,
        limit: 10,
        query: "launch",
      },
    ]);
  });

  it("passes explicit search controls through to the gateway", async () => {
    const searches: unknown[] = [];
    const tool = createSlackRealTimeSearchAgentTools({
      context: context(),
      gatewayFactory: () =>
        fakeGateway({
          async searchContext(input) {
            searches.push(input);
            return {
              channels: [],
              files: [],
              messages: [],
              ok: true,
              users: [],
            };
          },
        }),
      tokenResolver: tokenResolver("xoxp-token"),
    })[0];

    await expect(
      tool.execute({
        channelTypes: ["public_channel"],
        contentTypes: ["messages", "files", "users"],
        contextChannelId: "C2",
        includeContextMessages: false,
        includeMessageBlocks: true,
        limit: 20,
        query: "roadmap",
      }),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(searches).toEqual([
      expect.objectContaining({
        channelTypes: ["public_channel"],
        contentTypes: ["messages", "files", "users"],
        contextChannelId: "C2",
        includeContextMessages: false,
        includeMessageBlocks: true,
        limit: 20,
      }),
    ]);
  });

  it("fails as a tool result when no user token is available", async () => {
    const tool = createSlackRealTimeSearchAgentTools({
      context: context(),
      gatewayFactory: () => {
        throw new Error("should not create a gateway without a token");
      },
      tokenResolver: {
        async resolve() {
          return undefined;
        },
      },
    })[0];

    await expect(tool.execute({ query: "launch" })).resolves.toMatchObject({
      code: "slack_rts_user_token_missing",
      ok: false,
    });
  });

  it("fails as a tool result when Slack returns an API error", async () => {
    const tool = createSlackRealTimeSearchAgentTools({
      context: context(),
      gatewayFactory: () =>
        fakeGateway({
          async searchContext() {
            return {
              channels: [],
              errorCode: "rate_limited",
              files: [],
              messages: [],
              ok: false,
              users: [],
            };
          },
        }),
      tokenResolver: tokenResolver("xoxp-token"),
    })[0];

    await expect(tool.execute({ query: "launch" })).resolves.toMatchObject({
      code: "rate_limited",
      ok: false,
    });
  });

  it("fails as a tool result when the Slack request throws", async () => {
    const tool = createSlackRealTimeSearchAgentTools({
      context: context(),
      gatewayFactory: () =>
        fakeGateway({
          async searchContext() {
            throw new Error("network unavailable");
          },
        }),
      tokenResolver: tokenResolver("xoxp-token"),
    })[0];

    await expect(tool.execute({ query: "launch" })).resolves.toMatchObject({
      code: "slack_rts_call_failed",
      message: "Slack Real-time Search request failed: network unavailable.",
      ok: false,
    });
  });

  it("describes Real-time Search as the first Slack search choice", () => {
    const tool = createSlackRealTimeSearchAgentTools({
      context: context(),
      tokenResolver: tokenResolver("xoxp-token"),
    })[0];

    expect(tool.description).toContain("first choice");
    expect(tool.name).toBe("slack_real_time_search");
  });
});

function context() {
  return {
    channelId: "C1",
    enterpriseId: "E1",
    isEnterpriseInstall: false,
    teamId: "T1",
    userId: "U1",
  };
}

function tokenResolver(token: string) {
  return {
    async resolve(input: unknown) {
      expect(input).toMatchObject({
        enterpriseId: "E1",
        teamId: "T1",
        userId: "U1",
      });
      return { token };
    },
  };
}

function fakeGateway(
  overrides: Partial<SlackRealTimeSearchGateway> = {},
): SlackRealTimeSearchGateway {
  return {
    async info() {
      return { ok: true };
    },
    async searchContext() {
      return {
        channels: [],
        files: [],
        messages: [],
        ok: true,
        users: [],
      };
    },
    ...overrides,
  };
}
