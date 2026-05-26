import type {
  RssFeedFetchCacheEntry,
  RssFeedSubscription,
  RssProcessedArticle,
} from "../domain/rssFeeds.js";

export type RssFeedRepository = {
  completeProcessedArticle(input: {
    articleKey: string;
    llmOutput: string;
    modelId: string;
    modelSource: "channel" | "workspace";
    processedAt: Date;
    slackMessageTs: string;
    subscriptionId: string;
  }): Promise<void>;
  findFeedFetchCache(feedUrl: string): Promise<RssFeedFetchCacheEntry | undefined>;
  disableSubscription(input: {
    subscriptionId: string;
    teamId: string;
    updatedAt: Date;
  }): Promise<boolean>;
  listEnabledSubscriptions(input?: {
    limit?: number;
    offset?: number;
    teamId?: string;
  }): Promise<RssFeedSubscription[]>;
  listProcessedArticleKeys(
    subscriptionId: string,
    articleKeys: readonly string[],
  ): Promise<Set<string>>;
  releaseProcessedArticleReservation(input: {
    articleKey: string;
    subscriptionId: string;
  }): Promise<void>;
  reserveProcessedArticle(article: RssProcessedArticle): Promise<boolean>;
  saveFeedFetchCache(entry: RssFeedFetchCacheEntry): Promise<void>;
  saveSubscription(subscription: RssFeedSubscription): Promise<void>;
  updateSubscriptionCursor(input: {
    lastProcessedAt: Date;
    lastSeenPublishedAt?: Date;
    subscriptionId: string;
  }): Promise<void>;
};
