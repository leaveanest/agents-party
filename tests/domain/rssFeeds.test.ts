import { describe, expect, it } from "vite-plus/test";

import {
  canonicalizeArticleUrl,
  normalizeRssFeedUrl,
  rssArticleKey,
} from "../../src/domain/rssFeeds.js";

describe("rssFeeds domain helpers", () => {
  it("normalizes feed and article URLs without provider assumptions", () => {
    expect(normalizeRssFeedUrl("HTTPS://Example.COM:443/feed.xml")).toBe(
      "https://example.com/feed.xml",
    );
    expect(canonicalizeArticleUrl("https://Example.com/post?utm_source=x&id=1#section")).toBe(
      "https://example.com/post?id=1",
    );
  });

  it("generates stable article keys using guid before canonical URL fallback", () => {
    const first = rssArticleKey({
      articleUrl: "https://example.com/a?utm_source=x",
      guid: "guid-1",
      title: "Title",
    });
    const second = rssArticleKey({
      articleUrl: "https://example.com/other",
      guid: "guid-1",
      title: "Other",
    });
    const urlKey = rssArticleKey({
      articleUrl: "https://example.com/a?utm_source=x",
      title: "Title",
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^guid:/u);
    expect(urlKey).toBe(
      rssArticleKey({ articleUrl: "https://example.com/a", title: "Different title" }),
    );
    expect(urlKey).toMatch(/^url:/u);
  });
});
