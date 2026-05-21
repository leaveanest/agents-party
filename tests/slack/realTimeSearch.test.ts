import { describe, expect, it } from "vite-plus/test";

import { createSlackRealTimeSearchGateway } from "../../src/slack/realTimeSearch.js";

describe("createSlackRealTimeSearchGateway", () => {
  it("calls assistant.search.context through WebClient.apiCall and normalizes results", async () => {
    const calls: unknown[] = [];
    const gateway = createSlackRealTimeSearchGateway("xoxp-test", {
      async apiCall(method, options) {
        calls.push({ method, options });
        return {
          ok: true,
          response_metadata: { next_cursor: "cursor-2" },
          results: {
            channels: [
              {
                name: "general",
                team_id: "T1",
                topic: "Company updates",
              },
            ],
            files: [
              {
                file_id: "F1",
                team_id: "T1",
                title: "Roadmap",
              },
            ],
            messages: [
              {
                author_user_id: "U1",
                channel_id: "C1",
                content: "Launch plan",
                context_messages: [{ content: "Previous context", message_ts: "1.1" }],
                message_ts: "1.2",
                team_id: "T1",
              },
            ],
            users: [
              {
                full_name: "Ada Lovelace",
                team_id: "T1",
                user_id: "U1",
              },
            ],
          },
        };
      },
    });

    await expect(
      gateway.searchContext({
        channelTypes: ["public_channel", "private_channel"],
        contentTypes: ["messages", "files"],
        contextChannelId: "C1",
        includeContextMessages: true,
        limit: 10,
        query: "launch",
      }),
    ).resolves.toEqual({
      channels: [
        {
          name: "general",
          teamId: "T1",
          topic: "Company updates",
        },
      ],
      files: [
        {
          fileId: "F1",
          teamId: "T1",
          title: "Roadmap",
        },
      ],
      messages: [
        {
          authorUserId: "U1",
          channelId: "C1",
          content: "Launch plan",
          contextMessages: [{ content: "Previous context", messageTs: "1.1" }],
          messageTs: "1.2",
          teamId: "T1",
        },
      ],
      nextCursor: "cursor-2",
      ok: true,
      users: [
        {
          fullName: "Ada Lovelace",
          teamId: "T1",
          userId: "U1",
        },
      ],
    });
    expect(calls).toEqual([
      {
        method: "assistant.search.context",
        options: {
          channel_types: ["public_channel", "private_channel"],
          content_types: ["messages", "files"],
          context_channel_id: "C1",
          include_context_messages: true,
          limit: 10,
          query: "launch",
        },
      },
    ]);
  });

  it("calls assistant.search.info through WebClient.apiCall", async () => {
    const calls: string[] = [];
    const gateway = createSlackRealTimeSearchGateway("xoxp-test", {
      async apiCall(method) {
        calls.push(method);
        return {
          is_ai_search_enabled: true,
          ok: true,
        };
      },
    });

    await expect(gateway.info()).resolves.toEqual({
      isAiSearchEnabled: true,
      ok: true,
    });
    expect(calls).toEqual(["assistant.search.info"]);
  });

  it("returns Slack API errors as failed gateway results", async () => {
    const gateway = createSlackRealTimeSearchGateway("xoxp-test", {
      async apiCall() {
        return {
          error: "feature_not_enabled",
          ok: false,
        };
      },
    });

    await expect(gateway.searchContext({ query: "launch" })).resolves.toMatchObject({
      errorCode: "feature_not_enabled",
      ok: false,
    });
  });
});
