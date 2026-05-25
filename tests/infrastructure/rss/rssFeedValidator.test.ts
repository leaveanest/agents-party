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
      resolveHostname: publicResolver,
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
      resolveHostname: publicResolver,
    });

    expect(result).toEqual({ articleCount: 1, ok: true });
  });

  it("rejects unreachable feed URLs", async () => {
    await expect(
      validateRssFeedUrl({
        feedUrl: "https://example.com/feed.xml",
        fetchFn: async () => new Response("missing", { status: 404 }),
        resolveHostname: publicResolver,
      }),
    ).resolves.toEqual({ ok: false, reason: "unreachable" });

    await expect(
      validateRssFeedUrl({
        feedUrl: "https://example.com/feed.xml",
        fetchFn: async () => {
          throw new Error("network failed");
        },
        resolveHostname: publicResolver,
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
        resolveHostname: publicResolver,
      }),
    ).resolves.toEqual({ ok: false, reason: "not_feed" });
  });

  it("rejects private hosts before fetching", async () => {
    let fetched = false;
    await expect(
      validateRssFeedUrl({
        feedUrl: "http://169.254.169.254/latest/meta-data",
        fetchFn: async () => {
          fetched = true;
          return new Response("<rss />");
        },
        resolveHostname: publicResolver,
      }),
    ).resolves.toEqual({ ok: false, reason: "unreachable" });

    expect(fetched).toBe(false);
  });

  it("rejects redirects to private hosts", async () => {
    await expect(
      validateRssFeedUrl({
        feedUrl: "https://example.com/feed.xml",
        fetchFn: async () =>
          new Response(null, {
            headers: { location: "http://127.0.0.1/feed.xml" },
            status: 302,
          }),
        resolveHostname: publicResolver,
      }),
    ).resolves.toEqual({ ok: false, reason: "unreachable" });
  });
});

async function publicResolver() {
  return ["93.184.216.34"];
}
