import { contentHash } from "../../domain/rssFeeds.js";
import type { RssFeedRepository } from "../../repositories/rssFeeds.js";

export class ArticleContentGateway {
  constructor(
    private readonly options: {
      fetchFn?: typeof fetch;
      now?: () => Date;
      repository: Pick<RssFeedRepository, "findArticleContentCache" | "saveArticleContentCache">;
      ttlMs?: number;
      failureTtlMs?: number;
    },
  ) {}

  async fetchArticleContent(articleUrl: string): Promise<string | undefined> {
    const now = this.now();
    const cache = await this.options.repository.findArticleContentCache(articleUrl);
    if (cache !== undefined && cache.expiresAt > now) {
      return cache.content;
    }

    let response: Response;
    try {
      response = await this.fetchFn()(articleUrl);
    } catch {
      await this.saveFailure(articleUrl, cache, now, "network_error");
      return cache?.content;
    }
    if (!response.ok) {
      await this.saveFailure(articleUrl, cache, now, `http_${response.status}`);
      return cache?.content;
    }

    const html = await response.text();
    const content = extractReadableText(html);
    await this.options.repository.saveArticleContentCache({
      articleUrl,
      content,
      contentHash: contentHash(content),
      errorCount: 0,
      expiresAt: addMs(now, this.options.ttlMs ?? DEFAULT_ARTICLE_TTL_MS),
      fetchedAt: now,
      lastError: undefined,
    });
    return content;
  }

  private async saveFailure(
    articleUrl: string,
    cache: Awaited<ReturnType<RssFeedRepository["findArticleContentCache"]>>,
    now: Date,
    error: string,
  ): Promise<void> {
    await this.options.repository.saveArticleContentCache({
      articleUrl,
      content: cache?.content,
      contentHash: cache?.contentHash,
      errorCount: (cache?.errorCount ?? 0) + 1,
      expiresAt: addMs(now, this.options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS),
      fetchFailedAt: now,
      fetchedAt: now,
      lastError: error,
    });
  }

  private fetchFn(): typeof fetch {
    return this.options.fetchFn ?? fetch;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export function extractReadableText(html: string): string {
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/giu, " ");
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/iu.exec(withoutScripts)?.[1] ?? withoutScripts;
  return decodeHtmlEntities(body.replace(/<[^>]+>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_ARTICLE_CONTENT_CHARS);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'");
}

function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

const DEFAULT_ARTICLE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_FAILURE_TTL_MS = 60 * 60 * 1000;
const MAX_ARTICLE_CONTENT_CHARS = 12_000;
