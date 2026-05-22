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
      tokenResolver: tokenResolver("xoxp-token", [
        "search:read.im",
        "search:read.mpim",
        "search:read.private",
        "search:read.public",
      ]),
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
        channelTypes: ["public_channel"],
        contentTypes: ["messages"],
        contextChannelId: undefined,
        cursor: undefined,
        includeContextMessages: false,
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
        after: 1752512713,
        before: 1755191113,
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
        after: 1752512713,
        before: 1755191113,
        channelTypes: ["public_channel"],
        contentTypes: ["messages", "files", "users"],
        contextChannelId: "C2",
        includeContextMessages: false,
        includeMessageBlocks: true,
        limit: 20,
      }),
    ]);
  });

  it("treats an empty pagination cursor as omitted", async () => {
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

    await expect(tool.execute({ cursor: "", query: "roadmap" })).resolves.toMatchObject({
      ok: true,
    });
    expect(searches).toEqual([
      expect.objectContaining({
        cursor: undefined,
      }),
    ]);
  });

  it("uses the invocation text when the model supplies an underspecified query", async () => {
    const searches: unknown[] = [];
    const warnings: unknown[] = [];
    const tool = createSlackRealTimeSearchAgentTools({
      context: context(),
      fallbackQuery: "Real-Time Search API使ってみて",
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
      logger: {
        warn(message: string, metadata: unknown) {
          warnings.push({ message, metadata });
        },
      },
      tokenResolver: tokenResolver("xoxp-token"),
    })[0];

    await expect(tool.execute({ query: "RT" })).resolves.toMatchObject({
      ok: true,
    });
    expect(searches).toEqual([
      expect.objectContaining({
        query: "Real-Time Search API",
      }),
    ]);
    expect(warnings).toEqual([
      {
        message: "Expanding short Slack Real-time Search query from invocation text.",
        metadata: expect.objectContaining({
          fallbackQueryLength: 20,
          queryLength: 2,
        }),
      },
    ]);
  });

  it("defaults to public channel search when only public search scope is available", async () => {
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
      tokenResolver: tokenResolver("xoxp-token", ["search:read.public"]),
    })[0];

    await expect(tool.execute({ query: "launch" })).resolves.toMatchObject({
      ok: true,
    });
    expect(searches).toEqual([
      expect.objectContaining({
        channelTypes: ["public_channel"],
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

  it("retries Slack internal errors with message-only search when mixed content search fails", async () => {
    const searches: unknown[] = [];
    const warnings: unknown[] = [];
    const tool = createSlackRealTimeSearchAgentTools({
      context: context(),
      gatewayFactory: () =>
        fakeGateway({
          async searchContext(input) {
            searches.push(input);
            if (searches.length === 1) {
              return {
                channels: [],
                errorCode: "internal_error",
                files: [],
                messages: [],
                ok: false,
                users: [],
              };
            }
            return {
              channels: [],
              files: [],
              messages: [
                {
                  channelId: "C1",
                  content: "Recovered result",
                  messageTs: "1.2",
                  teamId: "T1",
                },
              ],
              ok: true,
              users: [],
            };
          },
        }),
      logger: {
        warn(message: string, metadata: unknown) {
          warnings.push({ message, metadata });
        },
      },
      tokenResolver: tokenResolver("xoxp-token"),
    })[0];

    await expect(
      tool.execute({
        contentTypes: ["messages", "channels"],
        query: "roadmap",
      }),
    ).resolves.toMatchObject({
      ok: true,
      results: {
        messages: [
          {
            content: "Recovered result",
          },
        ],
      },
    });
    expect(searches).toEqual([
      expect.objectContaining({
        contentTypes: ["messages", "channels"],
      }),
      expect.objectContaining({
        contentTypes: ["messages"],
      }),
    ]);
    expect(warnings).toEqual([
      {
        message: "Retrying Slack Real-time Search after internal_error.",
        metadata: expect.objectContaining({
          contentTypes: ["messages", "channels"],
          fallbackContentTypes: ["messages"],
        }),
      },
    ]);
  });

  it("falls back to public message search when broad internal-error retries still fail", async () => {
    const searches: unknown[] = [];
    const warnings: unknown[] = [];
    const tool = createSlackRealTimeSearchAgentTools({
      context: context(),
      gatewayFactory: () =>
        fakeGateway({
          async searchContext(input) {
            searches.push(input);
            if (searches.length < 3) {
              return {
                channels: [],
                errorCode: "internal_error",
                files: [],
                messages: [],
                ok: false,
                users: [],
              };
            }
            return {
              channels: [],
              files: [],
              messages: [
                {
                  channelId: "C1",
                  content: "Public fallback result",
                  messageTs: "1.2",
                  teamId: "T1",
                },
              ],
              ok: true,
              users: [],
            };
          },
        }),
      logger: {
        warn(message: string, metadata: unknown) {
          warnings.push({ message, metadata });
        },
      },
      tokenResolver: tokenResolver("xoxp-token", [
        "search:read.im",
        "search:read.mpim",
        "search:read.private",
        "search:read.public",
      ]),
    })[0];

    await expect(
      tool.execute({
        channelTypes: ["public_channel", "private_channel", "mpim", "im"],
        contentTypes: ["messages", "files"],
        query: "roadmap",
      }),
    ).resolves.toMatchObject({
      ok: true,
      results: {
        messages: [
          {
            content: "Public fallback result",
          },
        ],
      },
    });
    expect(searches).toEqual([
      expect.objectContaining({
        channelTypes: ["public_channel", "private_channel", "mpim", "im"],
        contentTypes: ["messages", "files"],
      }),
      expect.objectContaining({
        channelTypes: ["public_channel", "private_channel", "mpim", "im"],
        contentTypes: ["messages"],
      }),
      expect.objectContaining({
        channelTypes: ["public_channel"],
        contentTypes: ["messages"],
      }),
    ]);
    expect(warnings).toEqual([
      expect.objectContaining({
        message: "Retrying Slack Real-time Search after internal_error.",
      }),
      expect.objectContaining({
        message: "Retrying Slack Real-time Search with a minimal public message request.",
      }),
    ]);
  });

  it("retries public message internal errors with the minimal request shape", async () => {
    const searches: unknown[] = [];
    const warnings: unknown[] = [];
    const tool = createSlackRealTimeSearchAgentTools({
      context: context(),
      gatewayFactory: () =>
        fakeGateway({
          async searchContext(input) {
            searches.push(input);
            if (searches.length === 1) {
              return {
                channels: [],
                errorCode: "internal_error",
                files: [],
                messages: [],
                ok: false,
                users: [],
              };
            }
            return {
              channels: [],
              files: [],
              messages: [
                {
                  channelId: "C1",
                  content: "Minimal fallback result",
                  messageTs: "1.2",
                  teamId: "T1",
                },
              ],
              ok: true,
              users: [],
            };
          },
        }),
      logger: {
        warn(message: string, metadata: unknown) {
          warnings.push({ message, metadata });
        },
      },
      tokenResolver: tokenResolver("xoxp-token"),
    })[0];

    await expect(
      tool.execute({
        contextChannelId: "C1",
        includeContextMessages: true,
        query: "roadmap",
      }),
    ).resolves.toMatchObject({
      ok: true,
      results: {
        messages: [
          {
            content: "Minimal fallback result",
          },
        ],
      },
    });
    expect(searches).toEqual([
      expect.objectContaining({
        channelTypes: ["public_channel"],
        contentTypes: ["messages"],
        contextChannelId: "C1",
        includeContextMessages: true,
      }),
      expect.objectContaining({
        channelTypes: ["public_channel"],
        contentTypes: ["messages"],
        contextChannelId: undefined,
        cursor: undefined,
        includeContextMessages: false,
        includeMessageBlocks: false,
      }),
    ]);
    expect(warnings).toEqual([
      expect.objectContaining({
        message: "Retrying Slack Real-time Search with a minimal public message request.",
      }),
    ]);
  });

  it("retries Slack invalid cursor errors without pagination", async () => {
    const searches: unknown[] = [];
    const warnings: unknown[] = [];
    const tool = createSlackRealTimeSearchAgentTools({
      context: context(),
      gatewayFactory: () =>
        fakeGateway({
          async searchContext(input) {
            searches.push(input);
            if (searches.length === 1) {
              return {
                channels: [],
                errorCode: "invalid_cursor",
                files: [],
                messages: [],
                ok: false,
                users: [],
              };
            }
            return {
              channels: [],
              files: [],
              messages: [
                {
                  channelId: "C1",
                  content: "Fresh first page",
                  messageTs: "1.2",
                  teamId: "T1",
                },
              ],
              ok: true,
              users: [],
            };
          },
        }),
      logger: {
        warn(message: string, metadata: unknown) {
          warnings.push({ message, metadata });
        },
      },
      tokenResolver: tokenResolver("xoxp-token"),
    })[0];

    await expect(
      tool.execute({
        cursor: "stale-cursor",
        query: "roadmap",
      }),
    ).resolves.toMatchObject({
      ok: true,
      results: {
        messages: [
          {
            content: "Fresh first page",
          },
        ],
      },
    });
    expect(searches).toEqual([
      expect.objectContaining({
        cursor: "stale-cursor",
      }),
      expect.objectContaining({
        cursor: undefined,
      }),
    ]);
    expect(warnings).toEqual([
      {
        message: "Retrying Slack Real-time Search without invalid cursor.",
        metadata: expect.objectContaining({
          contentTypes: ["messages"],
        }),
      },
    ]);
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

function tokenResolver(token: string, scopes?: string[]) {
  return {
    async resolve(input: unknown) {
      expect(input).toMatchObject({
        enterpriseId: "E1",
        teamId: "T1",
        userId: "U1",
      });
      return { scopes, token };
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
