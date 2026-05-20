import { describe, expect, it } from "vite-plus/test";

import { validateRssFeedUrl } from "../../../src/infrastructure/rss/rssFeedValidator.js";

describe("validateRssFeedUrl", () => {
  it("accepts RSS feeds with readable items", async () => {
    const result = await validateRssFeedUrl({
      feedUrl: "https://example.com/feed.xml",
      fetchFn: async () =>
        new Response(
          `<rss><channel><item><title>One</title><link>https://example.com/one</link></item></channel></rss>`,
          { status: 200 },
        ),
    });

    expect(result).toEqual({ articleCount: 1, ok: true });
  });

  it("accepts Atom feeds with readable entries", async () => {
    const result = await validateRssFeedUrl({
      feedUrl: "https://example.com/atom.xml",
      fetchFn: async () =>
        new Response(
          `<feed><entry><title>One</title><link rel="alternate" href="/one" /></entry></feed>`,
          { status: 200 },
        ),
    });

    expect(result).toEqual({ articleCount: 1, ok: true });
  });

  it("rejects unreachable feed URLs", async () => {
    await expect(
      validateRssFeedUrl({
        feedUrl: "https://example.com/feed.xml",
        fetchFn: async () => new Response("missing", { status: 404 }),
      }),
    ).resolves.toEqual({ ok: false, reason: "unreachable" });

    await expect(
      validateRssFeedUrl({
        feedUrl: "https://example.com/feed.xml",
        fetchFn: async () => {
          throw new Error("network failed");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "unreachable" });
  });

  it("rejects non-feed responses", async () => {
    await expect(
      validateRssFeedUrl({
        feedUrl: "https://example.com/",
        fetchFn: async () =>
          new Response("<html><body>not a feed</body></html>", {
            headers: { "content-type": "text/html" },
            status: 200,
          }),
      }),
    ).resolves.toEqual({ ok: false, reason: "not_feed" });
  });
});
