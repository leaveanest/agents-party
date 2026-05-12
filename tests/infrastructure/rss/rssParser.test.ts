import { describe, expect, it } from "vite-plus/test";

import { parseRssArticles } from "../../../src/infrastructure/rss/rssParser.js";

describe("parseRssArticles", () => {
  it("parses RSS item fields into domain articles", () => {
    const articles = parseRssArticles(
      "https://example.com/feed.xml",
      `<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <item>
            <title>RSS title</title>
            <link>https://example.com/post?utm_source=news#top</link>
            <guid>guid-1</guid>
            <pubDate>Tue, 12 May 2026 00:00:00 GMT</pubDate>
            <description>Summary</description>
            <author>Alice</author>
          </item>
        </channel>
      </rss>`,
    );

    expect(articles).toEqual([
      expect.objectContaining({
        articleUrl: "https://example.com/post",
        author: "Alice",
        feedUrl: "https://example.com/feed.xml",
        guid: "guid-1",
        summary: "Summary",
        title: "RSS title",
      }),
    ]);
    expect(articles[0]?.publishedAt?.toISOString()).toBe("2026-05-12T00:00:00.000Z");
  });

  it("parses Atom entries and resolves relative links", () => {
    const articles = parseRssArticles(
      "https://example.com/feed.xml",
      `<feed>
        <entry>
          <title>Atom title</title>
          <id>tag:example.com,2026:1</id>
          <updated>2026-05-12T01:00:00Z</updated>
          <link rel="alternate" href="/atom-post?utm_medium=social" />
          <summary>Atom summary</summary>
          <author><name>Bob</name></author>
        </entry>
      </feed>`,
    );

    expect(articles).toEqual([
      expect.objectContaining({
        articleUrl: "https://example.com/atom-post",
        author: "Bob",
        guid: "tag:example.com,2026:1",
        summary: "Atom summary",
        title: "Atom title",
      }),
    ]);
  });
});
