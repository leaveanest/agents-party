import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import type { JsonValue } from "../../domain/messageHistory.js";
import type {
  RssFeedFetchCacheEntry,
  RssFeedSubscription,
  RssProcessedArticle,
} from "../../domain/rssFeeds.js";
import type { RssFeedRepository } from "../../repositories/rssFeeds.js";

export class PostgresRssFeedRepository implements RssFeedRepository {
  constructor(private readonly pool: Pool) {}

  async saveSubscription(subscription: RssFeedSubscription): Promise<void> {
    await this.pool.query(
      `
        insert into rss_feed_subscriptions
          (id, team_id, channel_id, feed_url, enabled, last_seen_published_at,
           last_processed_at, payload, created_at, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        on conflict (team_id, channel_id, feed_url)
        do update set
          enabled = excluded.enabled,
          last_seen_published_at = excluded.last_seen_published_at,
          last_processed_at = excluded.last_processed_at,
          payload = excluded.payload,
          updated_at = excluded.updated_at
      `,
      [
        subscription.id,
        subscription.teamId,
        subscription.channelId,
        subscription.feedUrl,
        subscription.enabled,
        subscription.lastSeenPublishedAt ?? null,
        subscription.lastProcessedAt ?? null,
        JSON.stringify(subscription.payload),
        subscription.createdAt,
        subscription.updatedAt,
      ],
    );
  }

  async listEnabledSubscriptions(
    input: { limit?: number; offset?: number; teamId?: string } = {},
  ): Promise<RssFeedSubscription[]> {
    const result = await this.pool.query<RssFeedSubscriptionRow>(
      `
        select id, team_id, channel_id, feed_url, enabled, last_seen_published_at,
               last_processed_at, payload, created_at, updated_at
        from rss_feed_subscriptions
        where enabled = true
          and ($2::text is null or team_id = $2)
        order by updated_at desc, team_id, channel_id, feed_url
        limit $1
        offset $3
      `,
      [input.limit ?? 500, input.teamId ?? null, input.offset ?? 0],
    );
    return result.rows.map(mapSubscription);
  }

  async disableSubscription(input: {
    subscriptionId: string;
    teamId: string;
    updatedAt: Date;
  }): Promise<boolean> {
    const result = await this.pool.query<{ id: string }>(
      `
        update rss_feed_subscriptions
        set enabled = false,
            updated_at = $3
        where id = $1
          and team_id = $2
          and enabled = true
        returning id
      `,
      [input.subscriptionId, input.teamId, input.updatedAt],
    );
    return result.rows.length === 1;
  }

  async findFeedFetchCache(feedUrl: string): Promise<RssFeedFetchCacheEntry | undefined> {
    const result = await this.pool.query<RssFeedFetchCacheRow>(
      `
        select feed_url, etag, last_modified, body, status, fetched_at,
               expires_at, error_count, last_error
        from rss_feed_fetch_cache
        where feed_url = $1
      `,
      [feedUrl],
    );
    return result.rows[0] === undefined ? undefined : mapFeedFetchCache(result.rows[0]);
  }

  async saveFeedFetchCache(entry: RssFeedFetchCacheEntry): Promise<void> {
    await this.pool.query(
      `
        insert into rss_feed_fetch_cache
          (feed_url, etag, last_modified, body, status, fetched_at,
           expires_at, error_count, last_error)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        on conflict (feed_url)
        do update set
          etag = excluded.etag,
          last_modified = excluded.last_modified,
          body = excluded.body,
          status = excluded.status,
          fetched_at = excluded.fetched_at,
          expires_at = excluded.expires_at,
          error_count = excluded.error_count,
          last_error = excluded.last_error
      `,
      [
        entry.feedUrl,
        entry.etag ?? null,
        entry.lastModified ?? null,
        entry.body ?? null,
        entry.status ?? null,
        entry.fetchedAt,
        entry.expiresAt,
        entry.errorCount,
        entry.lastError ?? null,
      ],
    );
  }

  async listProcessedArticleKeys(
    subscriptionId: string,
    articleKeys: readonly string[],
  ): Promise<Set<string>> {
    if (articleKeys.length === 0) {
      return new Set();
    }
    const result = await this.pool.query<{ article_key: string }>(
      `
        select article_key
        from rss_processed_articles
        where subscription_id = $1
          and article_key = any($2::text[])
      `,
      [subscriptionId, [...articleKeys]],
    );
    return new Set(result.rows.map((row) => row.article_key));
  }

  async reserveProcessedArticle(article: RssProcessedArticle): Promise<boolean> {
    const result = await this.pool.query<{ id: string }>(
      `
        insert into rss_processed_articles
          (id, subscription_id, team_id, article_key, article_url, published_at,
           model_id, model_source, llm_output, slack_channel_id,
           slack_message_ts, processed_at, payload)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        on conflict (subscription_id, article_key) do nothing
        returning id
      `,
      [
        randomUUID(),
        article.subscriptionId,
        article.teamId,
        article.articleKey,
        article.articleUrl,
        article.publishedAt ?? null,
        article.modelId ?? null,
        article.modelSource ?? null,
        article.llmOutput ?? null,
        article.slackChannelId,
        article.slackMessageTs ?? null,
        article.processedAt,
        JSON.stringify(article.payload),
      ],
    );
    return result.rows.length === 1;
  }

  async releaseProcessedArticleReservation(input: {
    articleKey: string;
    subscriptionId: string;
  }): Promise<void> {
    await this.pool.query(
      `
        delete from rss_processed_articles
        where subscription_id = $1
          and article_key = $2
          and slack_message_ts is null
          and payload ->> 'status' = 'reserved'
      `,
      [input.subscriptionId, input.articleKey],
    );
  }

  async completeProcessedArticle(input: {
    articleKey: string;
    llmOutput: string;
    modelId: string;
    modelSource: "channel" | "workspace";
    processedAt: Date;
    slackMessageTs: string;
    subscriptionId: string;
  }): Promise<void> {
    await this.pool.query(
      `
        update rss_processed_articles
        set llm_output = $3,
            model_id = $4,
            model_source = $5,
            slack_message_ts = $6,
            processed_at = $7,
            payload = payload || '{"status":"posted"}'::jsonb
        where subscription_id = $1
          and article_key = $2
      `,
      [
        input.subscriptionId,
        input.articleKey,
        input.llmOutput,
        input.modelId,
        input.modelSource,
        input.slackMessageTs,
        input.processedAt,
      ],
    );
  }

  async updateSubscriptionCursor(input: {
    lastProcessedAt: Date;
    lastSeenPublishedAt?: Date;
    subscriptionId: string;
  }): Promise<void> {
    await this.pool.query(
      `
        update rss_feed_subscriptions
        set last_processed_at = $2,
            last_seen_published_at = greatest(
              coalesce(last_seen_published_at, $3),
              coalesce($3, last_seen_published_at)
            ),
            updated_at = $2
        where id = $1
      `,
      [input.subscriptionId, input.lastProcessedAt, input.lastSeenPublishedAt ?? null],
    );
  }
}

type RssFeedSubscriptionRow = {
  channel_id: string;
  created_at: Date;
  enabled: boolean;
  feed_url: string;
  id: string;
  last_processed_at: Date | null;
  last_seen_published_at: Date | null;
  payload: Record<string, JsonValue>;
  team_id: string;
  updated_at: Date;
};

type RssFeedFetchCacheRow = {
  body: string | null;
  error_count: number;
  etag: string | null;
  expires_at: Date;
  feed_url: string;
  fetched_at: Date;
  last_error: string | null;
  last_modified: string | null;
  status: number | null;
};

function mapSubscription(row: RssFeedSubscriptionRow): RssFeedSubscription {
  return {
    channelId: row.channel_id,
    createdAt: row.created_at,
    enabled: row.enabled,
    feedUrl: row.feed_url,
    id: row.id,
    lastProcessedAt: row.last_processed_at ?? undefined,
    lastSeenPublishedAt: row.last_seen_published_at ?? undefined,
    payload: row.payload,
    teamId: row.team_id,
    updatedAt: row.updated_at,
  };
}

function mapFeedFetchCache(row: RssFeedFetchCacheRow): RssFeedFetchCacheEntry {
  return {
    body: row.body ?? undefined,
    errorCount: row.error_count,
    etag: row.etag ?? undefined,
    expiresAt: row.expires_at,
    feedUrl: row.feed_url,
    fetchedAt: row.fetched_at,
    lastError: row.last_error ?? undefined,
    lastModified: row.last_modified ?? undefined,
    status: row.status ?? undefined,
  };
}
