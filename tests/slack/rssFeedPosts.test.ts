import { describe, expect, it } from "vite-plus/test";

import { createSlackRssArticlePublisher } from "../../src/slack/rssFeedPosts.js";

describe("createSlackRssArticlePublisher", () => {
  it("keeps Slack SDK posting inside adapter and groups feed articles in one thread", async () => {
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
      publisher.publishFeedArticles({
        articles: [
          {
            articleKey: "a1",
            articleUrl: "https://example.com/a",
            text: "Summary",
            title: "A & <B>",
          },
          {
            articleKey: "a2",
            articleUrl: "https://example.com/c",
            text: "Second",
            title: "C",
          },
        ],
        channelId: "C1",
        feedUrl: "https://example.com/feed.xml",
        teamId: "T1",
      }),
    ).resolves.toEqual([
      { articleKey: "a1", slackMessageTs: "2.000", status: "posted" },
      { articleKey: "a2", slackMessageTs: "3.000", status: "posted" },
    ]);

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
      {
        channel: "C1",
        text: "*<https://example.com/c|C>*\nSecond",
        thread_ts: "1.000",
      },
    ]);
  });

  it("returns per-article failures while continuing other replies in the feed thread", async () => {
    const posts: unknown[] = [];
    const publisher = createSlackRssArticlePublisher({
      clientProvider: {
        async forTeam() {
          return {
            chat: {
              async postMessage(payload: { text?: string }) {
                posts.push(payload);
                if (payload.text?.includes("Broken") === true) {
                  throw new Error("Slack failed.");
                }
                return { ts: `${posts.length}.000` };
              },
            },
          } as never;
        },
      },
    });

    const result = await publisher.publishFeedArticles({
      articles: [
        {
          articleKey: "a1",
          articleUrl: "https://example.com/a",
          text: "Summary",
          title: "A",
        },
        {
          articleKey: "a2",
          articleUrl: "https://example.com/b",
          text: "Broken",
          title: "B",
        },
        {
          articleKey: "a3",
          articleUrl: "https://example.com/c",
          text: "After failure",
          title: "C",
        },
      ],
      channelId: "C1",
      feedUrl: "https://example.com/feed.xml",
      teamId: "T1",
    });

    expect(result).toEqual([
      { articleKey: "a1", slackMessageTs: "2.000", status: "posted" },
      { articleKey: "a2", error: expect.any(Error), status: "failed" },
      { articleKey: "a3", slackMessageTs: "4.000", status: "posted" },
    ]);
    expect(posts).toHaveLength(4);
    expect(posts.slice(1)).toEqual([
      expect.objectContaining({ thread_ts: "1.000" }),
      expect.objectContaining({ thread_ts: "1.000" }),
      expect.objectContaining({ thread_ts: "1.000" }),
    ]);
  });

  it("uses the configured default locale for the parent message", async () => {
    const posts: unknown[] = [];
    const publisher = createSlackRssArticlePublisher({
      clientProvider: {
        async forTeam() {
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
      defaultLocale: "ja",
    });

    await publisher.publishFeedArticles({
      articles: [
        {
          articleKey: "a1",
          articleUrl: "https://example.com/a",
          text: "Summary",
          title: "A",
        },
      ],
      channelId: "C1",
      feedUrl: "https://example.com/feed.xml",
      teamId: "T1",
    });

    expect(posts[0]).toEqual({
      channel: "C1",
      text: "RSS更新: https://example.com/feed.xml",
    });
  });
});
