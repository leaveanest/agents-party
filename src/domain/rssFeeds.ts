import { createHash } from "node:crypto";

import type { JsonValue } from "./messageHistory.js";

export type RssFeedSubscription = {
  channelId: string;
  createdAt: Date;
  enabled: boolean;
  feedUrl: string;
  id: string;
  lastProcessedAt?: Date;
  lastSeenPublishedAt?: Date;
  payload: Record<string, JsonValue>;
  teamId: string;
  updatedAt: Date;
};

export type RssArticle = {
  articleUrl: string;
  author?: string;
  content?: string;
  feedUrl: string;
  guid?: string;
  publishedAt?: Date;
  summary?: string;
  title: string;
};

export type RssProcessedArticle = {
  articleKey: string;
  articleUrl: string;
  llmOutput?: string;
  modelId?: string;
  modelSource?: "channel" | "workspace";
  payload: Record<string, JsonValue>;
  processedAt: Date;
  publishedAt?: Date;
  slackChannelId: string;
  slackMessageTs?: string;
  subscriptionId: string;
};

export type RssFeedFetchCacheEntry = {
  body?: string;
  errorCount: number;
  etag?: string;
  expiresAt: Date;
  feedUrl: string;
  fetchedAt: Date;
  lastError?: string;
  lastModified?: string;
  status?: number;
};

export type RssArticleContentCacheEntry = {
  articleUrl: string;
  content?: string;
  contentHash?: string;
  errorCount: number;
  expiresAt: Date;
  fetchFailedAt?: Date;
  fetchedAt: Date;
  lastError?: string;
};

export function normalizeRssFeedUrl(value: string): string {
  return normalizeUrl(value);
}

export function canonicalizeArticleUrl(value: string): string {
  return normalizeUrl(value, { dropHash: true, dropTrackingParams: true });
}

export function rssArticleKey(
  article: Pick<RssArticle, "articleUrl" | "guid" | "publishedAt" | "title">,
): string {
  const guid = article.guid?.trim();
  if (guid !== undefined && guid.length > 0) {
    return `guid:${sha256(guid)}`;
  }
  const articleUrl = article.articleUrl.trim();
  if (articleUrl.length > 0) {
    return `url:${sha256(canonicalizeArticleUrl(articleUrl))}`;
  }
  return `fallback:${sha256(`${article.title}\n${article.publishedAt?.toISOString() ?? ""}`)}`;
}

export function contentHash(content: string): string {
  return sha256(content);
}

function normalizeUrl(
  value: string,
  options: { dropHash?: boolean; dropTrackingParams?: boolean } = {},
): string {
  const url = new URL(value.trim());
  url.hash = options.dropHash === true ? "" : url.hash;
  url.protocol = url.protocol.toLocaleLowerCase();
  url.hostname = url.hostname.toLocaleLowerCase();
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  ) {
    url.port = "";
  }
  if (options.dropTrackingParams === true) {
    for (const key of Array.from(url.searchParams.keys())) {
      if (TRACKING_QUERY_PARAM_PATTERN.test(key)) {
        url.searchParams.delete(key);
      }
    }
  }
  return url.toString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const TRACKING_QUERY_PARAM_PATTERN = /^(utm_|fbclid$|gclid$|yclid$|mc_cid$|mc_eid$)/iu;
