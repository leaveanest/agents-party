import type { ConversationHistory } from "../domain/messageHistory.js";
import { type RssArticle, type RssFeedSubscription, rssArticleKey } from "../domain/rssFeeds.js";
import { parseRssArticles } from "../infrastructure/rss/rssParser.js";
import type { LlmRequest, ModelInfo } from "../providers/contracts.js";
import type { ProviderRouter } from "../providers/providerRouter.js";
import type { RssFeedRepository } from "../repositories/rssFeeds.js";

export type RssModelSettingsRepository = {
  findChannelSettings(
    teamId: string,
    channelId: string,
  ): Promise<Record<string, unknown> | undefined>;
  findWorkspaceSettings(teamId: string): Promise<Record<string, unknown> | undefined>;
};

export type RssFeedFetcher = {
  fetchFeed(feedUrl: string): Promise<{ body: string; cacheStatus: string } | undefined>;
};

export type RssArticleContentFetcher = {
  fetchArticleContent(articleUrl: string): Promise<string | undefined>;
};

export type RssArticlePost = {
  articleKey: string;
  articleUrl: string;
  text: string;
  title: string;
};

export type RssArticlePublisher = {
  publishFeedArticle(input: {
    article: RssArticlePost;
    channelId: string;
    feedUrl: string;
    teamId: string;
  }): Promise<string>;
};

export type RssFeedProcessorOptions = {
  articleContentFetcher: RssArticleContentFetcher;
  articlePublisher: RssArticlePublisher;
  feedFetcher: RssFeedFetcher;
  logger?: RssProcessorLogger;
  maxArticlesPerSubscription?: number;
  modelSettingsRepository: RssModelSettingsRepository;
  now?: () => Date;
  providerRouter: Pick<ProviderRouter, "generate" | "resolveModel">;
  repository: RssFeedRepository;
};

export type RssProcessorLogger = {
  error?(message: string, fields?: Record<string, unknown>): void;
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
};

export type RssBatchResult = {
  failedArticles: number;
  fetchedFeeds: number;
  postedArticles: number;
  skippedSubscriptions: number;
};

export class RssFeedProcessor {
  constructor(private readonly options: RssFeedProcessorOptions) {}

  async processDueRssFeeds(input: { limit?: number } = {}): Promise<RssBatchResult> {
    const subscriptions = await this.options.repository.listEnabledSubscriptions({
      limit: input.limit,
    });
    const feedBodies = await this.fetchFeedsOnce(subscriptions);
    const result: RssBatchResult = {
      failedArticles: 0,
      fetchedFeeds: feedBodies.size,
      postedArticles: 0,
      skippedSubscriptions: 0,
    };

    for (const subscription of subscriptions) {
      const feed = feedBodies.get(subscription.feedUrl);
      if (feed === undefined) {
        result.skippedSubscriptions += 1;
        continue;
      }
      const subscriptionResult = await this.processSubscription(subscription, feed.body);
      result.failedArticles += subscriptionResult.failedArticles;
      result.postedArticles += subscriptionResult.postedArticles;
      result.skippedSubscriptions += subscriptionResult.skipped ? 1 : 0;
    }
    this.options.logger?.info?.("RSS batch completed.", result);
    return result;
  }

  private async fetchFeedsOnce(
    subscriptions: readonly RssFeedSubscription[],
  ): Promise<Map<string, { body: string }>> {
    const feedBodies = new Map<string, { body: string }>();
    for (const feedUrl of new Set(subscriptions.map((subscription) => subscription.feedUrl))) {
      const feed = await this.options.feedFetcher.fetchFeed(feedUrl);
      if (feed !== undefined) {
        feedBodies.set(feedUrl, { body: feed.body });
      }
      this.options.logger?.info?.("RSS feed fetch completed.", {
        cacheStatus: feed?.cacheStatus ?? "unavailable",
        feedUrl,
      });
    }
    return feedBodies;
  }

  private async processSubscription(
    subscription: RssFeedSubscription,
    feedBody: string,
  ): Promise<{ failedArticles: number; postedArticles: number; skipped: boolean }> {
    const resolvedModel = await this.resolveModel(subscription);
    if (resolvedModel === undefined) {
      this.options.logger?.warn?.("RSS subscription skipped because no model is configured.", {
        channelId: subscription.channelId,
        subscriptionId: subscription.id,
        teamId: subscription.teamId,
      });
      return { failedArticles: 0, postedArticles: 0, skipped: true };
    }

    const articles = parseRssArticles(subscription.feedUrl, feedBody);
    const candidates = await this.selectCandidateArticles(subscription, articles);
    if (candidates.length === 0) {
      return { failedArticles: 0, postedArticles: 0, skipped: false };
    }

    const posts: RssArticlePost[] = [];
    let failedArticles = 0;
    for (const candidate of candidates) {
      try {
        const content =
          candidate.article.content ??
          (await this.options.articleContentFetcher.fetchArticleContent(
            candidate.article.articleUrl,
          ));
        const text = await this.summarizeArticle({
          article: { ...candidate.article, content },
          model: resolvedModel.model,
          subscription,
        });
        const reserved = await this.options.repository.reserveProcessedArticle({
          articleKey: candidate.articleKey,
          articleUrl: candidate.article.articleUrl,
          payload: { status: "reserved" },
          processedAt: this.now(),
          publishedAt: candidate.article.publishedAt,
          slackChannelId: subscription.channelId,
          subscriptionId: subscription.id,
        });
        if (!reserved) {
          continue;
        }
        posts.push({
          articleKey: candidate.articleKey,
          articleUrl: candidate.article.articleUrl,
          text,
          title: candidate.article.title,
        });
      } catch (error) {
        failedArticles += 1;
        this.options.logger?.error?.("RSS article processing failed.", {
          articleKey: candidate.articleKey,
          error,
          subscriptionId: subscription.id,
        });
      }
    }

    if (posts.length === 0) {
      return { failedArticles, postedArticles: 0, skipped: false };
    }
    const postedArticles: Array<{ article: RssArticle; articleKey: string }> = [];
    for (const post of posts) {
      let slackMessageTs: string;
      try {
        slackMessageTs = await this.options.articlePublisher.publishFeedArticle({
          article: post,
          channelId: subscription.channelId,
          feedUrl: subscription.feedUrl,
          teamId: subscription.teamId,
        });
      } catch (error) {
        failedArticles += 1;
        await this.options.repository.releaseProcessedArticleReservation({
          articleKey: post.articleKey,
          subscriptionId: subscription.id,
        });
        this.options.logger?.error?.("RSS Slack posting failed.", {
          articleKey: post.articleKey,
          error,
          subscriptionId: subscription.id,
        });
        continue;
      }
      try {
        await this.options.repository.completeProcessedArticle({
          articleKey: post.articleKey,
          llmOutput: post.text,
          modelId: resolvedModel.model.id,
          modelSource: resolvedModel.source,
          processedAt: this.now(),
          slackMessageTs,
          subscriptionId: subscription.id,
        });
        const candidate = candidates.find((item) => item.articleKey === post.articleKey);
        if (candidate !== undefined) {
          postedArticles.push(candidate);
        }
      } catch (error) {
        failedArticles += 1;
        this.options.logger?.error?.("RSS processed article completion failed after Slack post.", {
          articleKey: post.articleKey,
          error,
          slackMessageTs,
          subscriptionId: subscription.id,
        });
      }
    }
    await this.options.repository.updateSubscriptionCursor({
      lastProcessedAt: this.now(),
      lastSeenPublishedAt: newestPublishedAt(postedArticles.map((candidate) => candidate.article)),
      subscriptionId: subscription.id,
    });
    return { failedArticles, postedArticles: postedArticles.length, skipped: false };
  }

  private async selectCandidateArticles(
    subscription: RssFeedSubscription,
    articles: readonly RssArticle[],
  ): Promise<Array<{ article: RssArticle; articleKey: string }>> {
    const keyedArticles = articles.map((article) => ({
      article,
      articleKey: rssArticleKey(article),
    }));
    const processed = await this.options.repository.listProcessedArticleKeys(
      subscription.id,
      keyedArticles.map((article) => article.articleKey),
    );
    return keyedArticles
      .filter(({ articleKey }) => {
        if (processed.has(articleKey)) {
          return false;
        }
        return true;
      })
      .sort(
        (left, right) => dateValue(left.article.publishedAt) - dateValue(right.article.publishedAt),
      )
      .slice(0, this.options.maxArticlesPerSubscription ?? 5);
  }

  private async resolveModel(
    subscription: RssFeedSubscription,
  ): Promise<{ model: ModelInfo; source: "channel" | "workspace" } | undefined> {
    const [channelSettings, workspaceSettings] = await Promise.all([
      this.options.modelSettingsRepository.findChannelSettings(
        subscription.teamId,
        subscription.channelId,
      ),
      this.options.modelSettingsRepository.findWorkspaceSettings(subscription.teamId),
    ]);
    const channelModelId = stringField(channelSettings, "default_model_id");
    const workspaceModelId = stringField(workspaceSettings, "default_model_id");
    if (channelModelId === undefined && workspaceModelId === undefined) {
      return undefined;
    }
    const resolved = this.options.providerRouter.resolveModel({
      channelModelId,
      workspaceModelId,
    });
    return {
      model: resolved.model,
      source: resolved.source === "channel" ? "channel" : "workspace",
    };
  }

  private async summarizeArticle(input: {
    article: RssArticle;
    model: ModelInfo;
    subscription: RssFeedSubscription;
  }): Promise<string> {
    const result = await this.options.providerRouter.generate({
      context: {
        workspaceId: input.subscription.teamId,
      },
      history: rssArticleHistory(input.article),
      maxOutputTokens: 700,
      metadata: {
        rss_article_url: input.article.articleUrl,
        rss_channel_id: input.subscription.channelId,
        rss_feed_url: input.subscription.feedUrl,
        rss_subscription_id: input.subscription.id,
      },
      model: input.model,
      requiredCapabilities: ["text"],
      system:
        "You write concise Slack mrkdwn updates for RSS articles. Summarize the article in Japanese, include why it matters, and keep the response under 900 characters.",
    } satisfies LlmRequest);
    return result.content.trim();
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function rssArticleHistory(article: RssArticle): ConversationHistory {
  return {
    messages: [
      {
        author: { id: "rss-feed", kind: "system" },
        content: [
          {
            text: [
              `Title: ${article.title}`,
              `URL: ${article.articleUrl}`,
              article.publishedAt === undefined
                ? undefined
                : `Published: ${article.publishedAt.toISOString()}`,
              article.author === undefined ? undefined : `Author: ${article.author}`,
              article.summary === undefined ? undefined : `Summary: ${article.summary}`,
              article.content === undefined ? undefined : `Content: ${article.content}`,
            ]
              .filter((line): line is string => line !== undefined)
              .join("\n\n"),
            type: "text",
          },
        ],
        id: "rss-article",
        role: "user",
      },
    ],
  };
}

function newestPublishedAt(articles: readonly RssArticle[]): Date | undefined {
  const dates = articles
    .map((article) => article.publishedAt)
    .filter((date): date is Date => date !== undefined);
  if (dates.length === 0) {
    return undefined;
  }
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

function dateValue(value: Date | undefined): number {
  return value?.getTime() ?? 0;
}

function stringField(
  record: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const value = record?.[field];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
