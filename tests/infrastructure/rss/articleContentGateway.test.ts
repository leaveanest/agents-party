import { describe, expect, it } from "vite-plus/test";

import type { RssArticleContentCacheEntry } from "../../../src/domain/rssFeeds.js";
import {
  ArticleContentGateway,
  extractReadableText,
} from "../../../src/infrastructure/rss/articleContentGateway.js";

describe("ArticleContentGateway", () => {
  it("uses fresh article content cache without external fetch", async () => {
    const repository = new MemoryArticleCacheRepository({
      articleUrl: "https://example.com/post",
      content: "Cached article",
      contentHash: "hash",
      errorCount: 0,
      expiresAt: new Date("2026-05-13T00:00:00.000Z"),
      fetchedAt: new Date("2026-05-12T00:00:00.000Z"),
    });
    const gateway = new ArticleContentGateway({
      fetchFn: async () => {
        throw new Error("Unexpected fetch.");
      },
      now: () => new Date("2026-05-12T00:00:00.000Z"),
      repository,
    });

    await expect(gateway.fetchArticleContent("https://example.com/post")).resolves.toBe(
      "Cached article",
    );
  });

  it("extracts readable text and stores content by article URL", async () => {
    const repository = new MemoryArticleCacheRepository();
    const gateway = new ArticleContentGateway({
      fetchFn: async () =>
        new Response(
          "<html><body><script>bad()</script><h1>Hello</h1><p>A &amp; B</p></body></html>",
        ),
      now: () => new Date("2026-05-12T00:00:00.000Z"),
      repository,
      ttlMs: 60_000,
    });

    await expect(gateway.fetchArticleContent("https://example.com/post")).resolves.toBe(
      "Hello A & B",
    );
    expect(repository.entry).toMatchObject({
      articleUrl: "https://example.com/post",
      content: "Hello A & B",
      errorCount: 0,
    });
    expect(repository.entry?.expiresAt.toISOString()).toBe("2026-05-12T00:01:00.000Z");
  });

  it("does not retry article fetch while a failure backoff cache is fresh", async () => {
    const repository = new MemoryArticleCacheRepository({
      articleUrl: "https://example.com/post",
      errorCount: 1,
      expiresAt: new Date("2026-05-12T01:00:00.000Z"),
      fetchFailedAt: new Date("2026-05-12T00:00:00.000Z"),
      fetchedAt: new Date("2026-05-12T00:00:00.000Z"),
      lastError: "http_503",
    });
    const gateway = new ArticleContentGateway({
      fetchFn: async () => {
        throw new Error("Unexpected fetch.");
      },
      now: () => new Date("2026-05-12T00:30:00.000Z"),
      repository,
    });

    await expect(gateway.fetchArticleContent("https://example.com/post")).resolves.toBeUndefined();
  });

  it("strips scripts and tags when extracting readable text", () => {
    expect(extractReadableText("<body><style>x</style><p>One&nbsp;Two</p></body>")).toBe("One Two");
  });
});

class MemoryArticleCacheRepository {
  constructor(readonly entry?: RssArticleContentCacheEntry) {}

  async findArticleContentCache() {
    return this.entry;
  }

  async saveArticleContentCache(entry: RssArticleContentCacheEntry) {
    (this as { entry?: RssArticleContentCacheEntry }).entry = entry;
  }
}
