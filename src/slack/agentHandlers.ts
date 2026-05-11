import type { AllMiddlewareArgs, SlackEventMiddlewareArgs, StringIndexed } from "@slack/bolt";

import type { AgentRunner } from "../agents/runner.js";
import type { SlackEventFeatureHandlers } from "./events.js";

type SlackEventArgs<TEvent extends string> = SlackEventMiddlewareArgs<TEvent> & AllMiddlewareArgs;

export function createAgentSlackHandlers(runner: AgentRunner): SlackEventFeatureHandlers {
  return {
    async handleAppHomeOpened({ client, event, logger }) {
      if (!hasStringField(event, "user")) {
        logger.warn("Ignoring app_home_opened without a Slack user id.");
        return;
      }
      await client.views.publish({
        user_id: event.user,
        view: {
          blocks: [
            {
              text: { text: "Agents Party", type: "plain_text" },
              type: "header",
            },
            {
              text: {
                text: "Mention the app in a channel or thread to talk to the assistant.",
                type: "mrkdwn",
              },
              type: "section",
            },
          ],
          type: "home",
        },
      });
    },
    async handleAppMention(args) {
      await handleMention(args, runner);
    },
    async handleMessage({ logger }) {
      logger.info("Slack message auto-routing is pending the TypeScript thread policy cutover.");
    },
    async handleReactionAdded({ logger }) {
      logger.info("Slack reaction execution is pending the TypeScript specialist command cutover.");
    },
  };
}

async function handleMention(
  { body, client, context, event, logger }: SlackEventArgs<"app_mention">,
  runner: AgentRunner,
): Promise<void> {
  if (
    !hasStringField(event, "channel") ||
    !hasStringField(event, "user") ||
    !hasStringField(event, "ts")
  ) {
    logger.warn("Ignoring app_mention with missing channel, user, or timestamp.");
    return;
  }
  const teamId = readTeamId(body, event);
  if (teamId === undefined) {
    logger.warn("Ignoring app_mention without a team id.");
    return;
  }

  const threadTs = readString(event, "thread_ts") ?? event.ts;
  let text: string;
  try {
    const result = await runner.run({
      channelId: event.channel,
      messageTs: event.ts,
      teamId,
      text: stripBotMention(readString(event, "text") ?? "", context.botUserId),
      threadTs,
      userId: event.user,
      viewerContextChannelIds: [event.channel],
    });
    text = result.message;
  } catch (error) {
    logger.error("TypeScript AgentRunner failed while handling app_mention.", {
      error,
      teamId,
      threadTs,
    });
    text = "I couldn't complete that request. Please try again in a moment.";
  }

  await client.chat.postMessage({
    channel: event.channel,
    text,
    thread_ts: threadTs,
  });
}

function readTeamId(body: unknown, event: StringIndexed): string | undefined {
  if (isRecord(body) && typeof body.team_id === "string") {
    return body.team_id;
  }
  return readString(event, "team");
}

function stripBotMention(text: string, botUserId: string | undefined): string {
  if (botUserId === undefined) {
    return text.trim();
  }
  return text.replace(new RegExp(`<@${escapeRegExp(botUserId)}>\\s*`, "u"), "").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function readString(value: StringIndexed, field: string): string | undefined {
  const fieldValue = value[field];
  return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : undefined;
}

function hasStringField<TField extends string>(
  value: StringIndexed,
  field: TField,
): value is StringIndexed & Record<TField, string> {
  return readString(value, field) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
