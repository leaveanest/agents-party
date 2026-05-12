import { describe, expect, it } from "vite-plus/test";

import { PostgresRssFeedRepository } from "../../../src/infrastructure/postgres/rssFeedRepository.js";

describe("PostgresRssFeedRepository", () => {
  it("persists channel-scoped RSS subscriptions", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresRssFeedRepository(pool as never);

    await repository.saveSubscription({
      channelId: "C1",
      createdAt: new Date("2026-05-12T00:00:00.000Z"),
      enabled: true,
      feedUrl: "https://example.com/feed.xml",
      id: "00000000-0000-4000-8000-000000000001",
      payload: { label: "news" },
      teamId: "T1",
      updatedAt: new Date("2026-05-12T00:00:00.000Z"),
    });

    expect(pool.queries[0]?.text).toContain("insert into rss_feed_subscriptions");
    expect(pool.queries[0]?.values?.slice(0, 5)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "T1",
      "C1",
      "https://example.com/feed.xml",
      true,
    ]);
  });

  it("reserves processed articles with subscription/article uniqueness", async () => {
    const pool = new RecordingPool([{ id: "reservation-id" }]);
    const repository = new PostgresRssFeedRepository(pool as never);

    await expect(
      repository.reserveProcessedArticle({
        articleKey: "url:abc",
        articleUrl: "https://example.com/a",
        payload: { status: "reserved" },
        processedAt: new Date("2026-05-12T00:00:00.000Z"),
        slackChannelId: "C1",
        subscriptionId: "00000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toBe(true);

    expect(pool.queries[0]?.text).toContain(
      "on conflict (subscription_id, article_key) do nothing",
    );
    expect(pool.queries[0]?.values).toContain("url:abc");
  });

  it("releases only unposted reserved articles", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresRssFeedRepository(pool as never);

    await repository.releaseProcessedArticleReservation({
      articleKey: "url:abc",
      subscriptionId: "00000000-0000-4000-8000-000000000001",
    });

    expect(pool.queries[0]?.text).toContain("delete from rss_processed_articles");
    expect(pool.queries[0]?.text).toContain("slack_message_ts is null");
    expect(pool.queries[0]?.text).toContain("payload ->> 'status' = 'reserved'");
  });
});

class RecordingPool {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];

  constructor(private readonly rows: unknown[] = []) {}

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text: text.replace(/\s+/gu, " ").trim(), values });
    return { rows: this.rows };
  }
}
