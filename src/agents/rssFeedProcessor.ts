import type { ConversationHistory } from "../domain/messageHistory.js";
import { type RssArticle, type RssFeedSubscription, rssArticleKey } from "../domain/rssFeeds.js";
import { parseRssArticles } from "../infrastructure/rss/rssParser.js";
import type { LlmRequest, ModelInfo } from "../providers/contracts.js";
import { MissingModelCapabilityError } from "../providers/modelRegistry.js";
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

export type RssArticlePost = {
  articleKey: string;
  articleUrl: string;
  text: string;
  title: string;
};

export type RssArticlePublishResult =
  | {
      articleKey: string;
      slackMessageTs: string;
      status: "posted";
    }
  | {
      articleKey: string;
      error: unknown;
      status: "failed";
    };

export type RssArticlePublisher = {
  publishFeedArticles(input: {
    articles: readonly RssArticlePost[];
    channelId: string;
    feedUrl: string;
    teamId: string;
  }): Promise<RssArticlePublishResult[]>;
};

export type RssFeedProcessorOptions = {
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
    let resolvedModel: { model: ModelInfo; source: "channel" | "workspace" } | undefined;
    try {
      resolvedModel = await this.resolveModel(subscription);
    } catch (error) {
      if (!isMissingWebSearchCapability(error)) {
        throw error;
      }
      this.options.logger?.warn?.("RSS subscription skipped because web search is unavailable.", {
        channelId: subscription.channelId,
        error,
        subscriptionId: subscription.id,
        teamId: subscription.teamId,
      });
      return { failedArticles: 0, postedArticles: 0, skipped: true };
    }
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

    let failedArticles = 0;
    let posts: RssArticlePost[];
    try {
      posts = await this.draftFeedPosts({
        candidates,
        model: resolvedModel.model,
        subscription,
      });
    } catch (error) {
      this.options.logger?.error?.("RSS feed item drafting failed.", {
        error,
        subscriptionId: subscription.id,
      });
      return { failedArticles: candidates.length, postedArticles: 0, skipped: false };
    }
    if (posts.length === 0) {
      const failedSkippedArticles = await this.recordModelSkippedArticles(
        subscription,
        candidates,
        resolvedModel,
      );
      await this.options.repository.updateSubscriptionCursor({
        lastProcessedAt: this.now(),
        lastSeenPublishedAt: newestPublishedAt(candidates.map((candidate) => candidate.article)),
        subscriptionId: subscription.id,
      });
      return { failedArticles: failedSkippedArticles, postedArticles: 0, skipped: false };
    }

    const reservedPosts: RssArticlePost[] = [];
    for (const post of posts) {
      const candidate = candidates.find((item) => item.articleKey === post.articleKey);
      if (candidate === undefined) {
        continue;
      }
      try {
        const reserved = await this.options.repository.reserveProcessedArticle({
          articleKey: post.articleKey,
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
        reservedPosts.push(post);
      } catch (error) {
        failedArticles += 1;
        this.options.logger?.error?.("RSS article processing failed.", {
          articleKey: post.articleKey,
          error,
          subscriptionId: subscription.id,
        });
      }
    }

    if (reservedPosts.length === 0) {
      return { failedArticles, postedArticles: 0, skipped: false };
    }
    const postedArticles: Array<{ article: RssArticle; articleKey: string }> = [];
    let publishResultsByArticleKey: Map<string, RssArticlePublishResult>;
    try {
      const publishResults = await this.options.articlePublisher.publishFeedArticles({
        articles: reservedPosts,
        channelId: subscription.channelId,
        feedUrl: subscription.feedUrl,
        teamId: subscription.teamId,
      });
      publishResultsByArticleKey = new Map(
        publishResults.map((publishResult) => [publishResult.articleKey, publishResult]),
      );
    } catch (error) {
      failedArticles += reservedPosts.length;
      for (const post of reservedPosts) {
        await this.options.repository.releaseProcessedArticleReservation({
          articleKey: post.articleKey,
          subscriptionId: subscription.id,
        });
      }
      this.options.logger?.error?.("RSS Slack feed thread posting failed.", {
        articleKeys: reservedPosts.map((post) => post.articleKey),
        error,
        subscriptionId: subscription.id,
      });
      await this.options.repository.updateSubscriptionCursor({
        lastProcessedAt: this.now(),
        subscriptionId: subscription.id,
      });
      return { failedArticles, postedArticles: 0, skipped: false };
    }
    for (const post of reservedPosts) {
      const publishResult = publishResultsByArticleKey.get(post.articleKey);
      if (publishResult === undefined || publishResult.status === "failed") {
        const error =
          publishResult?.error ?? new Error("RSS Slack posting returned no result for article.");
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
          slackMessageTs: publishResult.slackMessageTs,
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
          slackMessageTs: publishResult.slackMessageTs,
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

  private async recordModelSkippedArticles(
    subscription: RssFeedSubscription,
    candidates: ReadonlyArray<{ article: RssArticle; articleKey: string }>,
    resolvedModel: { model: ModelInfo; source: "channel" | "workspace" },
  ): Promise<number> {
    let failedArticles = 0;
    for (const candidate of candidates) {
      try {
        await this.options.repository.reserveProcessedArticle({
          articleKey: candidate.articleKey,
          articleUrl: candidate.article.articleUrl,
          modelId: resolvedModel.model.id,
          modelSource: resolvedModel.source,
          payload: { status: "skipped_by_model" },
          processedAt: this.now(),
          publishedAt: candidate.article.publishedAt,
          slackChannelId: subscription.channelId,
          subscriptionId: subscription.id,
        });
      } catch (error) {
        failedArticles += 1;
        this.options.logger?.error?.("RSS skipped article recording failed.", {
          articleKey: candidate.articleKey,
          error,
          subscriptionId: subscription.id,
        });
      }
    }
    return failedArticles;
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
    const resolved = this.options.providerRouter.resolveModel(
      {
        channelModelId,
        workspaceModelId,
      },
      ["web_search"],
    );
    return {
      model: resolved.model,
      source: resolved.source === "channel" ? "channel" : "workspace",
    };
  }

  private async draftFeedPosts(input: {
    candidates: ReadonlyArray<{ article: RssArticle; articleKey: string }>;
    model: ModelInfo;
    subscription: RssFeedSubscription;
  }): Promise<RssArticlePost[]> {
    const result = await this.options.providerRouter.generate({
      context: {
        workspaceId: input.subscription.teamId,
      },
      history: rssFeedSelectionHistory(input.subscription.feedUrl, input.candidates),
      metadata: {
        rss_channel_id: input.subscription.channelId,
        rss_feed_url: input.subscription.feedUrl,
        rss_subscription_id: input.subscription.id,
        rss_web_search: true,
      },
      model: input.model,
      requiredCapabilities: ["web_search"],
      system: rssFeedSystemPrompt(input.candidates.length, input.subscription.payload),
    } satisfies LlmRequest);
    return parseDraftedFeedPosts(result.content, input.candidates);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function rssFeedSystemPrompt(
  candidateCount: number,
  payload: RssFeedSubscription["payload"],
): string {
  const basePrompt = `You review RSS feed items for a Slack channel. The user message contains feed-provided title, URL, author, published timestamp, summary, and feed content. Use the available web search tool to inspect or verify linked article URLs when needed, and avoid relying on unstated assumptions. Pick up to ${candidateCount} items worth posting. For each selected item, write a concise Japanese Slack mrkdwn update. Return strict JSON with a top-level "posts" array of objects containing "articleKey" and "text".`;
  const customPrompt = rssSubscriptionPrompt(payload);
  if (customPrompt === undefined) {
    return basePrompt;
  }
  return `${basePrompt}\n\nRSS-specific posting instruction:\n${customPrompt}\n\nApply the RSS-specific instruction when selecting items and writing text. It must not override the required JSON schema, articleKey matching, or the instruction to avoid unstated assumptions.`;
}

function rssSubscriptionPrompt(payload: RssFeedSubscription["payload"]): string | undefined {
  const value = payload.prompt;
  if (typeof value !== "string") {
    return undefined;
  }
  const prompt = value.trim();
  return prompt.length === 0 ? undefined : prompt;
}

function rssFeedSelectionHistory(
  feedUrl: string,
  candidates: ReadonlyArray<{ article: RssArticle; articleKey: string }>,
): ConversationHistory {
  return {
    messages: [
      {
        author: { id: "rss-feed", kind: "system" },
        content: [
          {
            text: [`Feed URL: ${feedUrl}`, "Articles:", ...candidates.map(formatFeedItem)]
              .join("\n\n")
              .trim(),
            type: "text",
          },
        ],
        id: "rss-feed-items",
        role: "user",
      },
    ],
  };
}

function formatFeedItem(
  candidate: { article: RssArticle; articleKey: string },
  index: number,
): string {
  const { article, articleKey } = candidate;
  return [
    `${index + 1}. Article Key: ${articleKey}`,
    `Title: ${article.title}`,
    `URL: ${article.articleUrl}`,
    article.publishedAt === undefined
      ? undefined
      : `Published: ${article.publishedAt.toISOString()}`,
    article.author === undefined ? undefined : `Author: ${article.author}`,
    article.summary === undefined ? undefined : `Summary: ${truncateFeedText(article.summary)}`,
    article.content === undefined
      ? undefined
      : `Feed Content: ${truncateFeedText(article.content)}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function parseDraftedFeedPosts(
  value: string,
  candidates: ReadonlyArray<{ article: RssArticle; articleKey: string }>,
): RssArticlePost[] {
  const parsed = parseJsonObject(value);
  if (parsed === undefined || !Array.isArray(parsed.posts)) {
    throw new Error("RSS feed item drafting returned invalid JSON.");
  }
  const posts = Array.isArray(parsed?.posts) ? parsed.posts : [];
  const candidatesByKey = new Map(candidates.map((candidate) => [candidate.articleKey, candidate]));
  const drafted: RssArticlePost[] = [];
  const seen = new Set<string>();
  for (const post of posts) {
    if (!isRecord(post)) {
      continue;
    }
    const articleKey = stringValue(post.articleKey);
    const text = stringValue(post.text)?.trim();
    if (
      articleKey === undefined ||
      text === undefined ||
      text.length === 0 ||
      seen.has(articleKey)
    ) {
      continue;
    }
    const candidate = candidatesByKey.get(articleKey);
    if (candidate === undefined) {
      continue;
    }
    seen.add(articleKey);
    drafted.push({
      articleKey,
      articleUrl: candidate.article.articleUrl,
      text,
      title: candidate.article.title,
    });
  }
  if (posts.length > 0 && drafted.length === 0) {
    throw new Error("RSS feed item drafting returned no usable posts.");
  }
  return drafted;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  const jsonText = /^```(?:json)?\s*[\s\S]*```$/iu.test(trimmed)
    ? trimmed.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "")
    : trimmed;
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function truncateFeedText(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > MAX_FEED_FIELD_CHARS
    ? `${normalized.slice(0, MAX_FEED_FIELD_CHARS)}...`
    : normalized;
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingWebSearchCapability(error: unknown): boolean {
  return (
    error instanceof MissingModelCapabilityError && error.missingCapabilities.includes("web_search")
  );
}

const MAX_FEED_FIELD_CHARS = 2_000;
