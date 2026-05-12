import { XMLParser } from "fast-xml-parser";

import { canonicalizeArticleUrl, type RssArticle } from "../../domain/rssFeeds.js";

export function parseRssArticles(feedUrl: string, xml: string): RssArticle[] {
  const parsed = parser.parse(xml) as unknown;
  const root = isRecord(parsed) ? parsed : {};
  const rssChannel = recordAt(recordAt(root, "rss"), "channel");
  if (rssChannel !== undefined) {
    return arrayAt(rssChannel, "item")
      .map((item) => rssItemToArticle(feedUrl, item))
      .filter((article): article is RssArticle => article !== undefined);
  }
  const atomFeed = recordAt(root, "feed");
  if (atomFeed !== undefined) {
    return arrayAt(atomFeed, "entry")
      .map((entry) => atomEntryToArticle(feedUrl, entry))
      .filter((article): article is RssArticle => article !== undefined);
  }
  return [];
}

function rssItemToArticle(feedUrl: string, item: Record<string, unknown>): RssArticle | undefined {
  const articleUrl = normalizeArticleLink(readText(item, "link"), feedUrl);
  const title = readText(item, "title") ?? articleUrl;
  if (articleUrl === undefined || title === undefined) {
    return undefined;
  }
  return {
    articleUrl,
    author: readText(item, "author") ?? readText(item, "dc:creator"),
    content: readText(item, "content:encoded"),
    feedUrl,
    guid: readText(item, "guid"),
    publishedAt:
      readDate(item, "pubDate") ?? readDate(item, "published") ?? readDate(item, "updated"),
    summary: readText(item, "description"),
    title,
  };
}

function atomEntryToArticle(
  feedUrl: string,
  entry: Record<string, unknown>,
): RssArticle | undefined {
  const articleUrl = normalizeArticleLink(atomLink(entry), feedUrl);
  const title = readText(entry, "title") ?? articleUrl;
  if (articleUrl === undefined || title === undefined) {
    return undefined;
  }
  return {
    articleUrl,
    author: atomAuthor(entry),
    content: readText(entry, "content"),
    feedUrl,
    guid: readText(entry, "id"),
    publishedAt: readDate(entry, "published") ?? readDate(entry, "updated"),
    summary: readText(entry, "summary"),
    title,
  };
}

function normalizeArticleLink(value: string | undefined, feedUrl: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return canonicalizeArticleUrl(new URL(value, feedUrl).toString());
  } catch {
    return undefined;
  }
}

function atomLink(entry: Record<string, unknown>): string | undefined {
  const links = arrayAt(entry, "link");
  for (const link of links) {
    const rel = readText(link, "rel");
    if (rel === undefined || rel === "alternate") {
      return readText(link, "href") ?? readText(link, "#text");
    }
  }
  return readText(entry, "link");
}

function atomAuthor(entry: Record<string, unknown>): string | undefined {
  const author = recordAt(entry, "author");
  return author === undefined ? undefined : readText(author, "name");
}

function readDate(record: Record<string, unknown>, key: string): Date | undefined {
  const value = readText(record, key);
  if (value === undefined) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function readText(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text.length === 0 ? undefined : text;
  }
  if (isRecord(value)) {
    return readText(value, "#text");
  }
  return undefined;
}

function recordAt(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];
  if (Array.isArray(value)) {
    return isRecord(value[0]) ? value[0] : undefined;
  }
  return isRecord(value) ? value : undefined;
}

function arrayAt(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = record[key];
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const parser = new XMLParser({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
});
