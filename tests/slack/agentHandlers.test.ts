import { describe, expect, it } from "vite-plus/test";

import { createAgentSlackHandlers } from "../../src/slack/agentHandlers.js";

describe("createAgentSlackHandlers", () => {
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
});
