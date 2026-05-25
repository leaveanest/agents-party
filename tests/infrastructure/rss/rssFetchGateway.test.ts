import { describe, expect, it } from "vite-plus/test";

import type { RssFeedFetchCacheEntry } from "../../../src/domain/rssFeeds.js";
import { RssFeedFetchGateway } from "../../../src/infrastructure/rss/rssFetchGateway.js";

describe("RssFeedFetchGateway", () => {
  it("uses fresh DB cache without external fetch", async () => {
    const repository = new MemoryFeedCacheRepository({
      body: "<rss />",
      errorCount: 0,
      expiresAt: new Date("2026-05-12T01:00:00.000Z"),
      feedUrl: "https://example.com/feed.xml",
      fetchedAt: new Date("2026-05-12T00:00:00.000Z"),
    });
    const gateway = new RssFeedFetchGateway({
      fetchFn: async () => {
        throw new Error("Unexpected fetch.");
      },
      now: () => new Date("2026-05-12T00:30:00.000Z"),
      repository,
      resolveHostname: publicResolver,
    });

    await expect(gateway.fetchFeed("https://example.com/feed.xml")).resolves.toEqual({
      body: "<rss />",
      cacheStatus: "hit",
      feedUrl: "https://example.com/feed.xml",
    });
  });

  it("sends conditional GET and reuses cached body on 304", async () => {
    const repository = new MemoryFeedCacheRepository({
      body: "<rss />",
      errorCount: 0,
      etag: '"abc"',
      expiresAt: new Date("2026-05-12T00:00:00.000Z"),
      feedUrl: "https://example.com/feed.xml",
      fetchedAt: new Date("2026-05-12T00:00:00.000Z"),
      lastModified: "Tue, 12 May 2026 00:00:00 GMT",
    });
    const calls: unknown[] = [];
    const gateway = new RssFeedFetchGateway({
      fetchFn: async (_url, init) => {
        calls.push(init?.headers);
        return new Response(null, { status: 304 });
      },
      now: () => new Date("2026-05-12T01:00:00.000Z"),
      repository,
      resolveHostname: publicResolver,
      ttlMs: 60_000,
    });

    await expect(gateway.fetchFeed("https://example.com/feed.xml")).resolves.toMatchObject({
      body: "<rss />",
      cacheStatus: "revalidated",
    });
    expect(calls).toEqual([
      {
        "if-modified-since": "Tue, 12 May 2026 00:00:00 GMT",
        "if-none-match": '"abc"',
      },
    ]);
    expect(repository.entry?.expiresAt.toISOString()).toBe("2026-05-12T01:01:00.000Z");
  });

  it("records failure backoff and returns stale cache when available", async () => {
    const repository = new MemoryFeedCacheRepository({
      body: "<rss />",
      errorCount: 1,
      expiresAt: new Date("2026-05-12T00:00:00.000Z"),
      feedUrl: "https://example.com/feed.xml",
      fetchedAt: new Date("2026-05-12T00:00:00.000Z"),
    });
    const gateway = new RssFeedFetchGateway({
      fetchFn: async () => new Response("nope", { status: 503 }),
      failureTtlMs: 120_000,
      now: () => new Date("2026-05-12T01:00:00.000Z"),
      repository,
      resolveHostname: publicResolver,
    });

    await expect(gateway.fetchFeed("https://example.com/feed.xml")).resolves.toMatchObject({
      body: "<rss />",
      cacheStatus: "hit",
    });
    expect(repository.entry).toMatchObject({
      errorCount: 2,
      lastError: "http_503",
      status: 503,
    });
    expect(repository.entry?.expiresAt.toISOString()).toBe("2026-05-12T01:02:00.000Z");
  });

  it("does not retry while a failure backoff cache is fresh", async () => {
    const repository = new MemoryFeedCacheRepository({
      errorCount: 1,
      expiresAt: new Date("2026-05-12T01:30:00.000Z"),
      feedUrl: "https://example.com/feed.xml",
      fetchedAt: new Date("2026-05-12T01:00:00.000Z"),
      lastError: "http_503",
      status: 503,
    });
    const gateway = new RssFeedFetchGateway({
      fetchFn: async () => {
        throw new Error("Unexpected fetch.");
      },
      now: () => new Date("2026-05-12T01:10:00.000Z"),
      repository,
      resolveHostname: publicResolver,
    });

    await expect(gateway.fetchFeed("https://example.com/feed.xml")).resolves.toBeUndefined();
  });

  it("blocks unsafe feed URLs before network access", async () => {
    const repository = new MemoryFeedCacheRepository();
    let fetched = false;
    const gateway = new RssFeedFetchGateway({
      fetchFn: async () => {
        fetched = true;
        return new Response("<rss />");
      },
      now: () => new Date("2026-05-12T01:00:00.000Z"),
      repository,
      resolveHostname: publicResolver,
    });

    await expect(gateway.fetchFeed("http://127.0.0.1/feed.xml")).resolves.toBeUndefined();
    expect(fetched).toBe(false);
    expect(repository.entry).toMatchObject({
      lastError: "non_public_address",
    });
  });
});

class MemoryFeedCacheRepository {
  constructor(readonly entry?: RssFeedFetchCacheEntry) {}

  async findFeedFetchCache() {
    return this.entry;
  }

  async saveFeedFetchCache(entry: RssFeedFetchCacheEntry) {
    (this as { entry?: RssFeedFetchCacheEntry }).entry = entry;
  }
}

async function publicResolver() {
  return ["93.184.216.34"];
}
