import { parseRssArticles } from "./rssParser.js";
import { fetchSafeRssUrl, type RssUrlHostnameResolver } from "./rssUrlSafety.js";

export type RssFeedValidationResult =
  | { articleCount: number; ok: true }
  | { ok: false; reason: "not_feed" | "unreachable" };

export async function validateRssFeedUrl(input: {
  feedUrl: string;
  fetchFn?: typeof fetch;
  resolveHostname?: RssUrlHostnameResolver;
}): Promise<RssFeedValidationResult> {
  let response: Response;
  try {
    response = await fetchSafeRssUrl({
      fetchFn: input.fetchFn,
      init: {
        headers: {
          accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        },
      },
      resolveHostname: input.resolveHostname,
      url: input.feedUrl,
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  if (!response.ok) {
    return { ok: false, reason: "unreachable" };
  }

  let body: string;
  try {
    body = await response.text();
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  try {
    const articles = parseRssArticles(input.feedUrl, body);
    if (articles.length === 0) {
      return { ok: false, reason: "not_feed" };
    }
    return { articleCount: articles.length, ok: true };
  } catch {
    return { ok: false, reason: "not_feed" };
  }
}
