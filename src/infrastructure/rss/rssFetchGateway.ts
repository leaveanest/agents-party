import type { RssFeedRepository } from "../../repositories/rssFeeds.js";
import {
  fetchSafeRssUrl,
  type RssUrlHostnameResolver,
  UnsafeRssFeedUrlError,
} from "./rssUrlSafety.js";

export type RssFetchResult = {
  body: string;
  cacheStatus: "hit" | "miss" | "revalidated";
  feedUrl: string;
};

export class RssFeedFetchGateway {
  constructor(
    private readonly options: {
      fetchFn?: typeof fetch;
      now?: () => Date;
      repository: Pick<RssFeedRepository, "findFeedFetchCache" | "saveFeedFetchCache">;
      ttlMs?: number;
      failureTtlMs?: number;
      resolveHostname?: RssUrlHostnameResolver;
    },
  ) {}

  async fetchFeed(feedUrl: string): Promise<RssFetchResult | undefined> {
    const now = this.now();
    const cache = await this.options.repository.findFeedFetchCache(feedUrl);
    if (cache !== undefined && cache.expiresAt > now) {
      return cache.body === undefined
        ? undefined
        : { body: cache.body, cacheStatus: "hit", feedUrl };
    }

    const headers: Record<string, string> = {};
    if (cache?.etag !== undefined) {
      headers["if-none-match"] = cache.etag;
    }
    if (cache?.lastModified !== undefined) {
      headers["if-modified-since"] = cache.lastModified;
    }

    let response: Response;
    try {
      response = await fetchSafeRssUrl({
        fetchFn: this.fetchFn(),
        init: { headers },
        resolveHostname: this.options.resolveHostname,
        url: feedUrl,
      });
    } catch (error) {
      await this.saveFailure(
        feedUrl,
        cache,
        now,
        error instanceof UnsafeRssFeedUrlError ? error.reason : "network_error",
      );
      return cache?.body === undefined
        ? undefined
        : { body: cache.body, cacheStatus: "hit", feedUrl };
    }

    if (response.status === 304 && cache?.body !== undefined) {
      await this.options.repository.saveFeedFetchCache({
        ...cache,
        errorCount: 0,
        expiresAt: addMs(now, this.options.ttlMs ?? DEFAULT_FEED_TTL_MS),
        fetchedAt: now,
        lastError: undefined,
        status: 304,
      });
      return { body: cache.body, cacheStatus: "revalidated", feedUrl };
    }

    if (!response.ok) {
      await this.saveFailure(feedUrl, cache, now, `http_${response.status}`, response.status);
      return cache?.body === undefined
        ? undefined
        : { body: cache.body, cacheStatus: "hit", feedUrl };
    }

    const body = await response.text();
    await this.options.repository.saveFeedFetchCache({
      body,
      errorCount: 0,
      etag: header(response, "etag") ?? cache?.etag,
      expiresAt: addMs(now, this.options.ttlMs ?? DEFAULT_FEED_TTL_MS),
      feedUrl,
      fetchedAt: now,
      lastError: undefined,
      lastModified: header(response, "last-modified") ?? cache?.lastModified,
      status: response.status,
    });
    return { body, cacheStatus: cache === undefined ? "miss" : "revalidated", feedUrl };
  }

  private async saveFailure(
    feedUrl: string,
    cache: Awaited<ReturnType<RssFeedRepository["findFeedFetchCache"]>>,
    now: Date,
    error: string,
    status?: number,
  ): Promise<void> {
    await this.options.repository.saveFeedFetchCache({
      body: cache?.body,
      errorCount: (cache?.errorCount ?? 0) + 1,
      etag: cache?.etag,
      expiresAt: addMs(now, this.options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS),
      feedUrl,
      fetchedAt: now,
      lastError: error,
      lastModified: cache?.lastModified,
      status,
    });
  }

  private fetchFn(): typeof fetch {
    return this.options.fetchFn ?? fetch;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function header(response: Response, name: string): string | undefined {
  const value = response.headers.get(name);
  return value === null || value.trim() === "" ? undefined : value;
}

function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

const DEFAULT_FEED_TTL_MS = 30 * 60 * 1000;
const DEFAULT_FAILURE_TTL_MS = 30 * 60 * 1000;
