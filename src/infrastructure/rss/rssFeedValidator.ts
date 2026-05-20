import { parseRssArticles } from "./rssParser.js";

export type RssFeedValidationResult =
  | { articleCount: number; ok: true }
  | { ok: false; reason: "not_feed" | "unreachable" };

export async function validateRssFeedUrl(input: {
  feedUrl: string;
  fetchFn?: typeof fetch;
}): Promise<RssFeedValidationResult> {
  const fetchFn = input.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(input.feedUrl, {
      headers: {
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      redirect: "follow",
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
