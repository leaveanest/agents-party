import type {
  AllMiddlewareArgs,
  App,
  AnyMiddlewareArgs,
  SlackActionMiddlewareArgs,
  SlackEventMiddlewareArgs,
  SlackViewMiddlewareArgs,
  StringIndexed,
} from "@slack/bolt";

import type { SlackEventDeduplicator } from "./idempotency.js";
import { readSlackEventId } from "./idempotency.js";
import {
  WORKSPACE_CREDENTIAL_CONFIGURE_ACTION_ID,
  WORKSPACE_CREDENTIAL_MODAL_CALLBACK_ID,
} from "./interactiveIds.js";

export type SlackEventFeatureHandlers = {
  handleAppHomeOpened(args: SlackEventArgs<"app_home_opened">): Promise<void>;
  handleAppMention(args: SlackEventArgs<"app_mention">): Promise<void>;
  handleWorkspaceCredentialConfigureAction(
    args: SlackActionMiddlewareArgs & AllMiddlewareArgs,
  ): Promise<void>;
  handleWorkspaceCredentialModalSubmission(
    args: SlackViewMiddlewareArgs & AllMiddlewareArgs,
  ): Promise<void>;
  handleMessage(args: SlackEventArgs<"message">): Promise<void>;
  handleReactionAdded(args: SlackEventArgs<"reaction_added">): Promise<void>;
};

type SlackAppRegistration = Pick<App, "action" | "event" | "use" | "view">;
type SlackEventArgs<TEvent extends string> = SlackEventMiddlewareArgs<TEvent> & AllMiddlewareArgs;

export function registerSlackEventHandlers(
  app: SlackAppRegistration,
  handlers: SlackEventFeatureHandlers,
  deduplicator: SlackEventDeduplicator,
): void {
  app.use(async ({ body, context, logger, next }: AnyMiddlewareArgs & AllMiddlewareArgs) => {
    const eventId = readSlackEventId(body);
    if (eventId === undefined) {
      await next();
      return;
    }

    const isFirstDelivery = deduplicator.markProcessing(eventId);
    if (!isFirstDelivery) {
      logger.info("Skipping duplicate Slack event delivery.", {
        eventId,
        retryNum: context.retryNum,
        retryReason: context.retryReason,
      });
      return;
    }
    await next();
  });

  app.event("app_home_opened", async (args) => handlers.handleAppHomeOpened(args));
  app.event("app_mention", async (args) => handlers.handleAppMention(args));
  app.event("message", async (args) => handlers.handleMessage(args));
  app.event("reaction_added", async (args) => handlers.handleReactionAdded(args));
  app.action(WORKSPACE_CREDENTIAL_CONFIGURE_ACTION_ID, async (args) =>
    handlers.handleWorkspaceCredentialConfigureAction(args),
  );
  app.view(WORKSPACE_CREDENTIAL_MODAL_CALLBACK_ID, async (args) =>
    handlers.handleWorkspaceCredentialModalSubmission(args),
  );
}

export function createMigrationGapSlackHandlers(): SlackEventFeatureHandlers {
  return {
    async handleAppHomeOpened({ client, event, logger }) {
      if (!hasStringField(event, "user")) {
        logger.warn("Ignoring app_home_opened without a Slack user id.");
        return;
      }
      await client.views.publish({
        user_id: event.user,
        view: {
          type: "home",
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: "Agents Party",
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "Mention the app in a channel or thread to talk to the assistant.",
              },
            },
          ],
        },
      });
    },
    async handleAppMention({ body, context, logger }) {
      logger.warn("Slack app_mention feature execution is not ported yet.", {
        eventId: readSlackEventId(body),
        retryNum: context.retryNum,
        retryReason: context.retryReason,
      });
    },
    async handleMessage({ body, context, logger }) {
      logger.warn("Slack message feature execution is not ported yet.", {
        eventId: readSlackEventId(body),
        retryNum: context.retryNum,
        retryReason: context.retryReason,
      });
    },
    async handleReactionAdded({ body, context, logger }) {
      logger.warn("Slack reaction_added feature execution is not ported yet.", {
        eventId: readSlackEventId(body),
        retryNum: context.retryNum,
        retryReason: context.retryReason,
      });
    },
    async handleWorkspaceCredentialConfigureAction({ ack }) {
      await ack();
    },
    async handleWorkspaceCredentialModalSubmission({ ack }) {
      await ack();
    },
  };
}

function hasStringField<TField extends string>(
  value: StringIndexed,
  field: TField,
): value is StringIndexed & Record<TField, string> {
  return typeof value[field] === "string" && value[field].length > 0;
}
