import type { WebClient } from "@slack/web-api";

import type { RssArticlePublisher, RssArticlePost } from "../agents/rssFeedProcessor.js";
import type { SlackWebClientProvider } from "./webClient.js";

export function createSlackRssArticlePublisher(input: {
  clientProvider: Pick<SlackWebClientProvider, "forTeam">;
}): RssArticlePublisher {
  return {
    async publishFeedArticle(payload) {
      const client = await input.clientProvider.forTeam({ teamId: payload.teamId });
      return publishFeedArticle(client, payload);
    },
  };
}

async function publishFeedArticle(
  client: Pick<WebClient, "chat">,
  input: {
    article: RssArticlePost;
    channelId: string;
    feedUrl: string;
    teamId: string;
  },
): Promise<string> {
  const parent = await client.chat.postMessage({
    channel: input.channelId,
    text: `RSS updates: ${input.feedUrl}`,
  });
  const threadTs = stringField(parent, "ts");
  if (threadTs === undefined) {
    throw new Error("Slack did not return a timestamp for the RSS parent message.");
  }

  const response = await client.chat.postMessage({
    channel: input.channelId,
    text: renderArticlePost(input.article),
    thread_ts: threadTs,
  });
  const ts = stringField(response, "ts");
  if (ts === undefined) {
    throw new Error("Slack did not return a timestamp for the RSS article message.");
  }
  return ts;
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
