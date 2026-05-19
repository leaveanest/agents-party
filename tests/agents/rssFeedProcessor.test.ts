import { describe, expect, it } from "vite-plus/test";

import { RssFeedProcessor } from "../../src/agents/rssFeedProcessor.js";
import type { RssFeedSubscription, RssProcessedArticle } from "../../src/domain/rssFeeds.js";
import { rssArticleKey } from "../../src/domain/rssFeeds.js";
import type { LlmRequest, LlmResult, ModelInfo } from "../../src/providers/contracts.js";

const channelModel: ModelInfo = {
  capabilities: ["text"],
  id: "openai:gpt-4o",
  provider: "openai",
  providerModelId: "gpt-4o",
};
const workspaceModel: ModelInfo = {
  capabilities: ["text"],
  id: "google:gemini-2.5-flash",
  provider: "google",
  providerModelId: "gemini-2.5-flash",
};

describe("RssFeedProcessor", () => {
  it("fetches each feed once and resolves channel before workspace models", async () => {
    const repository = new MemoryRssRepository([
      subscription({ channelId: "C1", id: "S1" }),
      subscription({ channelId: "C2", id: "S2" }),
    ]);
    const feedFetcher = new CountingFeedFetcher();
    const providerRouter = new FakeProviderRouter();
    const publisher = new RecordingPublisher();
    const processor = new RssFeedProcessor({
      articleContentFetcher: {
        async fetchArticleContent() {
          return "Article body";
        },
      },
      articlePublisher: publisher,
      feedFetcher,
      modelSettingsRepository: {
        async findChannelSettings(_teamId, channelId) {
          return channelId === "C1" ? { default_model_id: channelModel.id } : undefined;
        },
        async findWorkspaceSettings() {
          return { default_model_id: workspaceModel.id };
        },
      },
      now: () => new Date("2026-05-12T00:00:00.000Z"),
      providerRouter,
      repository,
    });

    await expect(processor.processDueRssFeeds()).resolves.toMatchObject({
      fetchedFeeds: 1,
      postedArticles: 2,
      skippedSubscriptions: 0,
    });
    expect(feedFetcher.calls).toEqual(["https://example.com/feed.xml"]);
    expect(providerRouter.requests.map((request) => request.model.id)).toEqual([
      "openai:gpt-4o",
      "google:gemini-2.5-flash",
    ]);
    expect(providerRouter.requests[0]?.system).toBe(
      "You write concise Slack mrkdwn updates for RSS articles. Summarize the article in Japanese, include why it matters, and keep the response under 900 characters.",
    );
    expect(
      providerRouter.requests[0]?.history.messages.map((message) => message.role),
    ).not.toContain("system");
    expect(publisher.posts).toHaveLength(2);
    expect(repository.completed.map((item) => item.modelSource)).toEqual(["channel", "workspace"]);
  });

  it("skips processed articles before LLM and Slack posting", async () => {
    const articleKey = rssArticleKey({
      articleUrl: "https://example.com/post-1",
      guid: "guid-1",
      title: "Post 1",
    });
    const repository = new MemoryRssRepository(
      [subscription({ id: "S1" })],
      new Set([`S1:${articleKey}`]),
    );
    const providerRouter = new FakeProviderRouter();
    const publisher = new RecordingPublisher();
    const processor = new RssFeedProcessor({
      articleContentFetcher: {
        async fetchArticleContent() {
          return "Article body";
        },
      },
      articlePublisher: publisher,
      feedFetcher: new CountingFeedFetcher(),
      modelSettingsRepository: {
        async findChannelSettings() {
          return { default_model_id: channelModel.id };
        },
        async findWorkspaceSettings() {
          return undefined;
        },
      },
      providerRouter,
      repository,
    });

    await expect(processor.processDueRssFeeds()).resolves.toMatchObject({
      postedArticles: 0,
    });
    expect(providerRouter.requests).toHaveLength(0);
    expect(publisher.posts).toHaveLength(0);
  });

  it("fails closed when neither channel nor workspace model is configured", async () => {
    const repository = new MemoryRssRepository([subscription({ id: "S1" })]);
    const providerRouter = new FakeProviderRouter();
    const processor = new RssFeedProcessor({
      articleContentFetcher: {
        async fetchArticleContent() {
          return "Article body";
        },
      },
      articlePublisher: new RecordingPublisher(),
      feedFetcher: new CountingFeedFetcher(),
      modelSettingsRepository: {
        async findChannelSettings() {
          return undefined;
        },
        async findWorkspaceSettings() {
          return undefined;
        },
      },
      providerRouter,
      repository,
    });

    await expect(processor.processDueRssFeeds()).resolves.toMatchObject({
      postedArticles: 0,
      skippedSubscriptions: 1,
    });
    expect(providerRouter.requests).toHaveLength(0);
  });

  it("advances the published cursor only for successfully posted articles", async () => {
    const repository = new MemoryRssRepository([subscription({ id: "S1" })]);
    const failedArticleKey = rssArticleKey({
      articleUrl: "https://example.com/post-2",
      guid: "guid-2",
      title: "Post 2",
    });
    const publisher = new RecordingPublisher({ failArticleKeys: new Set([failedArticleKey]) });
    const processor = new RssFeedProcessor({
      articleContentFetcher: {
        async fetchArticleContent() {
          return "Article body";
        },
      },
      articlePublisher: publisher,
      feedFetcher: new MultiItemFeedFetcher(),
      modelSettingsRepository: {
        async findChannelSettings() {
          return { default_model_id: channelModel.id };
        },
        async findWorkspaceSettings() {
          return undefined;
        },
      },
      now: () => new Date("2026-05-12T03:00:00.000Z"),
      providerRouter: new FakeProviderRouter(),
      repository,
    });

    await expect(processor.processDueRssFeeds()).resolves.toMatchObject({
      failedArticles: 1,
      postedArticles: 1,
    });
    expect(repository.cursorUpdates[0]?.lastSeenPublishedAt?.toISOString()).toBe(
      "2026-05-12T01:00:00.000Z",
    );
  });

  it("keeps failed older articles eligible even when a newer article advances the cursor", async () => {
    const failedArticleKey = rssArticleKey({
      articleUrl: "https://example.com/post-1",
      guid: "guid-1",
      title: "Post 1",
    });
    const failArticleKeys = new Set([failedArticleKey]);
    const repository = new MemoryRssRepository([subscription({ id: "S1" })]);
    const publisher = new RecordingPublisher({ failArticleKeys });
    const processor = new RssFeedProcessor({
      articleContentFetcher: {
        async fetchArticleContent() {
          return "Article body";
        },
      },
      articlePublisher: publisher,
      feedFetcher: new MultiItemFeedFetcher(),
      modelSettingsRepository: {
        async findChannelSettings() {
          return { default_model_id: channelModel.id };
        },
        async findWorkspaceSettings() {
          return undefined;
        },
      },
      now: () => new Date("2026-05-12T03:00:00.000Z"),
      providerRouter: new FakeProviderRouter(),
      repository,
    });

    await expect(processor.processDueRssFeeds()).resolves.toMatchObject({
      failedArticles: 1,
      postedArticles: 1,
    });
    expect(repository.cursorUpdates[0]?.lastSeenPublishedAt?.toISOString()).toBe(
      "2026-05-12T02:00:00.000Z",
    );

    failArticleKeys.clear();
    await expect(processor.processDueRssFeeds()).resolves.toMatchObject({
      failedArticles: 0,
      postedArticles: 1,
    });
    expect(publisher.posts).toHaveLength(2);
    expect(publisher.posts.at(-1)).toMatchObject({
      article: { articleKey: failedArticleKey },
    });
  });

  it("does not release a reservation when completion fails after Slack posting succeeds", async () => {
    const repository = new MemoryRssRepository([subscription({ id: "S1" })], undefined, {
      failCompletion: true,
    });
    const processor = new RssFeedProcessor({
      articleContentFetcher: {
        async fetchArticleContent() {
          return "Article body";
        },
      },
      articlePublisher: new RecordingPublisher(),
      feedFetcher: new CountingFeedFetcher(),
      modelSettingsRepository: {
        async findChannelSettings() {
          return { default_model_id: channelModel.id };
        },
        async findWorkspaceSettings() {
          return undefined;
        },
      },
      providerRouter: new FakeProviderRouter(),
      repository,
    });

    await expect(processor.processDueRssFeeds()).resolves.toMatchObject({
      failedArticles: 1,
      postedArticles: 0,
    });
    expect(repository.releaseCalls).toHaveLength(0);
    expect(repository.reservationCount).toBe(1);
  });
});

class CountingFeedFetcher {
  readonly calls: string[] = [];

  async fetchFeed(feedUrl: string) {
    this.calls.push(feedUrl);
    return {
      body: `<rss><channel><item>
        <title>Post 1</title>
        <link>https://example.com/post-1</link>
        <guid>guid-1</guid>
        <pubDate>Tue, 12 May 2026 00:00:00 GMT</pubDate>
        <description>Summary</description>
      </item></channel></rss>`,
      cacheStatus: "miss",
    };
  }
}

class MultiItemFeedFetcher {
  async fetchFeed() {
    return {
      body: `<rss><channel>
        <item>
          <title>Post 1</title>
          <link>https://example.com/post-1</link>
          <guid>guid-1</guid>
          <pubDate>Tue, 12 May 2026 01:00:00 GMT</pubDate>
        </item>
        <item>
          <title>Post 2</title>
          <link>https://example.com/post-2</link>
          <guid>guid-2</guid>
          <pubDate>Tue, 12 May 2026 02:00:00 GMT</pubDate>
        </item>
      </channel></rss>`,
      cacheStatus: "miss",
    };
  }
}

class FakeProviderRouter {
  readonly requests: LlmRequest[] = [];

  resolveModel(input: { channelModelId?: string | null; workspaceModelId?: string | null }) {
    if (input.channelModelId === channelModel.id) {
      return { model: channelModel, source: "channel" as const };
    }
    if (input.workspaceModelId === workspaceModel.id) {
      return { model: workspaceModel, source: "workspace" as const };
    }
    throw new Error("No model configured.");
  }

  async generate(request: LlmRequest): Promise<LlmResult> {
    this.requests.push(request);
    return { content: `Summary from ${request.model.id}` };
  }
}

class RecordingPublisher {
  readonly posts: unknown[] = [];

  constructor(private readonly options: { failArticleKeys?: Set<string> } = {}) {}

  async publishFeedArticle(input: { article: { articleKey: string }; channelId: string }) {
    if (this.options.failArticleKeys?.has(input.article.articleKey) === true) {
      throw new Error("Slack failed.");
    }
    this.posts.push(input);
    return `${this.posts.length}.0`;
  }
}

class MemoryRssRepository {
  readonly completed: Array<{ modelSource: string }> = [];
  readonly cursorUpdates: Array<{ lastSeenPublishedAt?: Date }> = [];
  readonly releaseCalls: Array<{ articleKey: string; subscriptionId: string }> = [];
  private readonly reservations = new Set<string>();

  constructor(
    private readonly subscriptions: RssFeedSubscription[],
    private readonly processed = new Set<string>(),
    private readonly options: { failCompletion?: boolean } = {},
  ) {}

  get reservationCount() {
    return this.reservations.size;
  }

  async listEnabledSubscriptions() {
    return this.subscriptions;
  }

  async listProcessedArticleKeys(subscriptionId: string, articleKeys: readonly string[]) {
    return new Set(articleKeys.filter((key) => this.processed.has(`${subscriptionId}:${key}`)));
  }

  async reserveProcessedArticle(article: RssProcessedArticle) {
    const reservationKey = `${article.subscriptionId}:${article.articleKey}`;
    if (this.reservations.has(reservationKey) || this.processed.has(reservationKey)) {
      return false;
    }
    this.reservations.add(reservationKey);
    return true;
  }

  async completeProcessedArticle(input: {
    articleKey: string;
    modelSource: "channel" | "workspace";
    subscriptionId: string;
  }) {
    if (this.options.failCompletion === true) {
      throw new Error("DB completion failed.");
    }
    this.completed.push({ modelSource: input.modelSource });
    this.processed.add(`${input.subscriptionId}:${input.articleKey}`);
  }

  async releaseProcessedArticleReservation(input: { articleKey: string; subscriptionId: string }) {
    this.releaseCalls.push(input);
    this.reservations.delete(`${input.subscriptionId}:${input.articleKey}`);
  }

  async updateSubscriptionCursor(input: { lastSeenPublishedAt?: Date }) {
    this.cursorUpdates.push(input);
  }

  async findFeedFetchCache() {
    return undefined;
  }

  async saveFeedFetchCache() {}

  async findArticleContentCache() {
    return undefined;
  }

  async saveArticleContentCache() {}

  async saveSubscription() {}
}

function subscription(input: { channelId?: string; id: string }): RssFeedSubscription {
  return {
    channelId: input.channelId ?? "C1",
    createdAt: new Date("2026-05-12T00:00:00.000Z"),
    enabled: true,
    feedUrl: "https://example.com/feed.xml",
    id: input.id,
    payload: {},
    teamId: "T1",
    updatedAt: new Date("2026-05-12T00:00:00.000Z"),
  };
}
