import type { WebClient } from "@slack/web-api";

import type {
  RssArticlePublisher,
  RssArticlePublishResult,
  RssArticlePost,
} from "../agents/rssFeedProcessor.js";
import { FALLBACK_LOCALE, createTranslator, type Locale } from "../i18n/index.js";
import type { SlackWebClientProvider } from "./webClient.js";

export function createSlackRssArticlePublisher(input: {
  clientProvider: Pick<SlackWebClientProvider, "forTeam">;
  defaultLocale?: Locale;
}): RssArticlePublisher {
  return {
    async publishFeedArticles(payload) {
      const client = await input.clientProvider.forTeam({ teamId: payload.teamId });
      return publishFeedArticles(client, {
        ...payload,
        locale: input.defaultLocale ?? FALLBACK_LOCALE,
      });
    },
  };
}

async function publishFeedArticles(
  client: Pick<WebClient, "chat">,
  input: {
    articles: readonly RssArticlePost[];
    channelId: string;
    feedUrl: string;
    locale: Locale;
    teamId: string;
  },
): Promise<RssArticlePublishResult[]> {
  const translator = createTranslator(input.locale);
  const parent = await client.chat.postMessage({
    channel: input.channelId,
    text: translator.t("rss.parent", { feedUrl: input.feedUrl }),
  });
  const threadTs = stringField(parent, "ts");
  if (threadTs === undefined) {
    throw new Error("Slack did not return a timestamp for the RSS parent message.");
  }

  const results: RssArticlePublishResult[] = [];
  for (const article of input.articles) {
    try {
      const response = await client.chat.postMessage({
        channel: input.channelId,
        text: renderArticlePost(article),
        thread_ts: threadTs,
      });
      const ts = stringField(response, "ts");
      if (ts === undefined) {
        throw new Error("Slack did not return a timestamp for the RSS article message.");
      }
      results.push({
        articleKey: article.articleKey,
        slackMessageTs: ts,
        status: "posted",
      });
    } catch (error) {
      results.push({
        articleKey: article.articleKey,
        error,
        status: "failed",
      });
    }
  }
  return results;
}

function renderArticlePost(article: RssArticlePost): string {
  return `*<${article.articleUrl}|${escapeMrkdwn(article.title)}>*\n${article.text}`;
}

function escapeMrkdwn(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function stringField(record: unknown, field: string): string | undefined {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return undefined;
  }
  const value = (record as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
