import { describe, expect, it } from "vite-plus/test";

import { RssFeedProcessor } from "../../src/agents/rssFeedProcessor.js";
import type { RssFeedSubscription, RssProcessedArticle } from "../../src/domain/rssFeeds.js";
import { rssArticleKey } from "../../src/domain/rssFeeds.js";
import type {
  LlmCapability,
  LlmRequest,
  LlmResult,
  ModelInfo,
} from "../../src/providers/contracts.js";
import { MissingModelCapabilityError } from "../../src/providers/modelRegistry.js";

const channelModel: ModelInfo = {
  capabilities: ["text", "web_search"],
  id: "openai:gpt-4o",
  provider: "openai",
  providerModelId: "gpt-4o",
};
const workspaceModel: ModelInfo = {
  capabilities: ["text", "web_search"],
  id: "google:gemini-2.5-flash",
  provider: "google",
  providerModelId: "gemini-2.5-flash",
};
const textOnlyModel: ModelInfo = {
  capabilities: ["text"],
  id: "openai:gpt-5-mini",
  provider: "openai",
  providerModelId: "gpt-5-mini",
};

describe("RssFeedProcessor", () => {
  it("fetches each feed once and resolves channel before workspace models", async () => {
    const repository = new MemoryRssRepository([
      subscription({
        channelId: "C1",
        id: "S1",
        prompt: "Prioritize product updates and write with an executive tone.",
      }),
      subscription({ channelId: "C2", id: "S2" }),
    ]);
    const feedFetcher = new CountingFeedFetcher();
    const providerRouter = new FakeProviderRouter();
    const publisher = new RecordingPublisher();
    const processor = new RssFeedProcessor({
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
    expect(providerRouter.requests[0]?.system).toContain(
      "Use the available web search tool to inspect or verify linked article URLs",
    );
    expect(providerRouter.requests[0]?.system).toContain(
      "Prioritize product updates and write with an executive tone.",
    );
    expect(providerRouter.requests[1]?.system).not.toContain("RSS-specific posting instruction");
    expect(providerRouter.resolveRequirements).toEqual([["web_search"], ["web_search"]]);
    expect(providerRouter.requests.map((request) => request.requiredCapabilities)).toEqual([
      ["web_search"],
      ["web_search"],
    ]);
    expect(
      providerRouter.requests[0]?.history.messages.map((message) => message.role),
    ).not.toContain("system");
    expect(providerRouter.requests[0]?.history.messages[0]?.content[0]).toMatchObject({
      type: "text",
    });
    expect(publisher.posts).toHaveLength(2);
    expect(publisher.batches).toHaveLength(2);
    expect(publisher.batches.map((batch) => batch.articles)).toEqual([
      [expect.objectContaining({ articleKey: expect.any(String) })],
      [expect.objectContaining({ articleKey: expect.any(String) })],
    ]);
    expect(repository.completed.map((item) => item.modelSource)).toEqual(["channel", "workspace"]);
  });

  it("publishes multiple selected articles for one subscription as one Slack feed batch", async () => {
    const repository = new MemoryRssRepository([subscription({ id: "S1" })]);
    const publisher = new RecordingPublisher();
    const processor = new RssFeedProcessor({
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
      providerRouter: new FakeProviderRouter(),
      repository,
    });

    await expect(processor.processDueRssFeeds()).resolves.toMatchObject({
      failedArticles: 0,
      postedArticles: 2,
    });
    expect(publisher.batches).toHaveLength(1);
    expect(publisher.batches[0]).toMatchObject({
      channelId: "C1",
      feedUrl: "https://example.com/feed.xml",
      teamId: "T1",
    });
    expect(publisher.batches[0]?.articles).toHaveLength(2);
    expect(publisher.posts).toHaveLength(2);
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

  it("skips subscriptions when the configured model does not support web search", async () => {
    const repository = new MemoryRssRepository([subscription({ id: "S1" })]);
    const providerRouter = new FakeProviderRouter();
    const processor = new RssFeedProcessor({
      articlePublisher: new RecordingPublisher(),
      feedFetcher: new CountingFeedFetcher(),
      modelSettingsRepository: {
        async findChannelSettings() {
          return { default_model_id: textOnlyModel.id };
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

  it("does not hide non-capability model resolution errors", async () => {
    const repository = new MemoryRssRepository([subscription({ id: "S1" })]);
    const providerRouter = new FakeProviderRouter();
    const processor = new RssFeedProcessor({
      articlePublisher: new RecordingPublisher(),
      feedFetcher: new CountingFeedFetcher(),
      modelSettingsRepository: {
        async findChannelSettings() {
          return { default_model_id: "openai:missing-model" };
        },
        async findWorkspaceSettings() {
          return undefined;
        },
      },
      providerRouter,
      repository,
    });

    await expect(processor.processDueRssFeeds()).rejects.toThrow("No model configured.");
    expect(providerRouter.requests).toHaveLength(0);
  });

  it("counts unusable LLM draft output as failed articles", async () => {
    const repository = new MemoryRssRepository([subscription({ id: "S1" })]);
    const providerRouter = new FakeProviderRouter({ draftContent: "not json" });
    const publisher = new RecordingPublisher();
    const processor = new RssFeedProcessor({
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
      failedArticles: 1,
      postedArticles: 0,
    });
    expect(repository.reservationCount).toBe(0);
    expect(repository.cursorUpdates).toHaveLength(0);
    expect(publisher.posts).toHaveLength(0);
  });

  it("records empty LLM draft selections as model-skipped articles", async () => {
    const repository = new MemoryRssRepository([subscription({ id: "S1" })]);
    const providerRouter = new FakeProviderRouter({ draftContent: JSON.stringify({ posts: [] }) });
    const publisher = new RecordingPublisher();
    const processor = new RssFeedProcessor({
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
      failedArticles: 0,
      postedArticles: 0,
    });
    expect(repository.reservationCount).toBe(1);
    expect(repository.reservationsPayloads).toEqual([{ status: "skipped_by_model" }]);
    expect(repository.cursorUpdates).toHaveLength(1);
    expect(publisher.posts).toHaveLength(0);

    await expect(processor.processDueRssFeeds()).resolves.toMatchObject({
      failedArticles: 0,
      postedArticles: 0,
    });
    expect(providerRouter.requests).toHaveLength(1);
  });

  it("counts non-empty LLM draft output with no usable posts as failed articles", async () => {
    const repository = new MemoryRssRepository([subscription({ id: "S1" })]);
    const providerRouter = new FakeProviderRouter({
      draftContent: JSON.stringify({ posts: [{ articleKey: "missing", text: "No match" }] }),
    });
    const publisher = new RecordingPublisher();
    const processor = new RssFeedProcessor({
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
      failedArticles: 1,
      postedArticles: 0,
    });
    expect(repository.reservationCount).toBe(0);
    expect(repository.cursorUpdates).toHaveLength(0);
    expect(publisher.posts).toHaveLength(0);
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
  readonly resolveRequirements: string[][] = [];

  constructor(private readonly options: { draftContent?: string } = {}) {}

  resolveModel(
    input: { channelModelId?: string | null; workspaceModelId?: string | null },
    requiredCapabilities: readonly LlmCapability[] = [],
  ) {
    this.resolveRequirements.push([...requiredCapabilities]);
    let resolved: { model: ModelInfo; source: "channel" | "workspace" } | undefined;
    if (input.channelModelId === channelModel.id) {
      resolved = { model: channelModel, source: "channel" as const };
    } else if (input.channelModelId === textOnlyModel.id) {
      resolved = { model: textOnlyModel, source: "channel" as const };
    } else if (input.workspaceModelId === workspaceModel.id) {
      resolved = { model: workspaceModel, source: "workspace" as const };
    }
    if (resolved === undefined) {
      throw new Error("No model configured.");
    }
    const missing = requiredCapabilities.filter(
      (capability) => !resolved.model.capabilities.includes(capability),
    );
    if (missing.length > 0) {
      throw new MissingModelCapabilityError(resolved.model, missing);
    }
    return resolved;
  }

  async generate(request: LlmRequest): Promise<LlmResult> {
    this.requests.push(request);
    if (this.options.draftContent !== undefined) {
      return { content: this.options.draftContent };
    }
    const textPart = request.history.messages[0]?.content.find((part) => part.type === "text");
    const text = textPart?.type === "text" ? textPart.text : "";
    const articleKeys = [...text.matchAll(/^\d+\. Article Key: (.+)$/gmu)].map((match) => match[1]);
    return {
      content: JSON.stringify({
        posts: articleKeys.map((articleKey) => ({
          articleKey,
          text: `Feed update from ${request.model.id}`,
        })),
      }),
    };
  }
}

class RecordingPublisher {
  readonly batches: Array<{
    articles: ReadonlyArray<{ articleKey: string }>;
    channelId: string;
    feedUrl: string;
    teamId: string;
  }> = [];
  readonly posts: unknown[] = [];

  constructor(private readonly options: { failArticleKeys?: Set<string> } = {}) {}

  async publishFeedArticles(input: {
    articles: ReadonlyArray<{ articleKey: string }>;
    channelId: string;
    feedUrl: string;
    teamId: string;
  }) {
    this.batches.push(input);
    return input.articles.map((article) => {
      if (this.options.failArticleKeys?.has(article.articleKey) === true) {
        return {
          articleKey: article.articleKey,
          error: new Error("Slack failed."),
          status: "failed" as const,
        };
      }
      this.posts.push({ article, channelId: input.channelId });
      return {
        articleKey: article.articleKey,
        slackMessageTs: `${this.posts.length}.0`,
        status: "posted" as const,
      };
    });
  }
}

class MemoryRssRepository {
  readonly completed: Array<{ modelSource: string }> = [];
  readonly cursorUpdates: Array<{ lastSeenPublishedAt?: Date }> = [];
  readonly releaseCalls: Array<{ articleKey: string; subscriptionId: string }> = [];
  readonly reservationsPayloads: unknown[] = [];
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

  async disableSubscription() {
    return false;
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
    this.reservationsPayloads.push(article.payload);
    if (article.payload.status === "skipped_by_model") {
      this.processed.add(reservationKey);
    }
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

  async saveSubscription() {}
}

function subscription(input: {
  channelId?: string;
  id: string;
  prompt?: string;
}): RssFeedSubscription {
  return {
    channelId: input.channelId ?? "C1",
    createdAt: new Date("2026-05-12T00:00:00.000Z"),
    enabled: true,
    feedUrl: "https://example.com/feed.xml",
    id: input.id,
    payload: input.prompt === undefined ? {} : { prompt: input.prompt },
    teamId: "T1",
    updatedAt: new Date("2026-05-12T00:00:00.000Z"),
  };
}
