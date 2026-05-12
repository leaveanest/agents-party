import { describe, expect, it } from "vite-plus/test";

import { createSlackRssArticlePublisher } from "../../src/slack/rssFeedPosts.js";

describe("createSlackRssArticlePublisher", () => {
  it("keeps Slack SDK posting inside adapter and returns article timestamps", async () => {
    const posts: unknown[] = [];
    const publisher = createSlackRssArticlePublisher({
      clientProvider: {
        async forTeam(input) {
          expect(input).toEqual({ teamId: "T1" });
          return {
            chat: {
              async postMessage(payload: unknown) {
                posts.push(payload);
                return { ts: `${posts.length}.000` };
              },
            },
          } as never;
        },
      },
    });

    await expect(
      publisher.publishFeedArticle({
        article: {
          articleKey: "a1",
          articleUrl: "https://example.com/a",
          text: "Summary",
          title: "A & <B>",
        },
        channelId: "C1",
        feedUrl: "https://example.com/feed.xml",
        teamId: "T1",
      }),
    ).resolves.toBe("2.000");

    expect(posts).toEqual([
      {
        channel: "C1",
        text: "RSS updates: https://example.com/feed.xml",
      },
      {
        channel: "C1",
        text: "*<https://example.com/a|A &amp; &lt;B&gt;>*\nSummary",
        thread_ts: "1.000",
      },
    ]);
  });
});
