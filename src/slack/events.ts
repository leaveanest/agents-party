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
  FEATURE_SETTINGS_CONFIGURE_ACTION_ID,
  FEATURE_SETTINGS_MODAL_CALLBACK_ID,
  MODEL_ROUTING_CHANNEL_CONFIGURE_ACTION_ID,
  MODEL_ROUTING_CONFIGURE_ACTION_ID,
  MODEL_ROUTING_DEFAULT_MODEL_ACTION_ID,
  MODEL_ROUTING_MODAL_CALLBACK_ID,
  MODEL_ROUTING_THREAD_CONFIGURE_ACTION_ID,
  RSS_FEED_CONFIGURE_ACTION_ID,
  RSS_FEED_MODAL_CALLBACK_ID,
  SALESFORCE_PDF_WORKFLOW_CONFIGURE_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_MODAL_CALLBACK_ID,
  WORKSPACE_CREDENTIAL_CONFIGURE_ACTION_ID,
  WORKSPACE_CREDENTIAL_MODAL_CALLBACK_ID,
  WORKSPACE_CREDENTIAL_PROVIDER_ACTION_ID,
} from "./interactiveIds.js";

export type SlackEventFeatureHandlers = {
  handleAppHomeOpened(args: SlackEventArgs<"app_home_opened">): Promise<void>;
  handleAppMention(args: SlackEventArgs<"app_mention">): Promise<void>;
  handleAssistantThreadContextChanged(
    args: SlackEventArgs<"assistant_thread_context_changed">,
  ): Promise<void>;
  handleAssistantThreadStarted(args: SlackEventArgs<"assistant_thread_started">): Promise<void>;
  handleWorkspaceCredentialConfigureAction(
    args: SlackActionMiddlewareArgs & AllMiddlewareArgs,
  ): Promise<void>;
  handleModelRoutingConfigureAction(
    args: SlackActionMiddlewareArgs & AllMiddlewareArgs,
  ): Promise<void>;
  handleModelRoutingDefaultModelSelectAction(
    args: SlackActionMiddlewareArgs & AllMiddlewareArgs,
  ): Promise<void>;
  handleModelRoutingModalSubmission(
    args: SlackViewMiddlewareArgs & AllMiddlewareArgs,
  ): Promise<void>;
  handleWorkspaceCredentialProviderSelectAction(
    args: SlackActionMiddlewareArgs & AllMiddlewareArgs,
  ): Promise<void>;
  handleWorkspaceCredentialModalSubmission(
    args: SlackViewMiddlewareArgs & AllMiddlewareArgs,
  ): Promise<void>;
  handleMessage(args: SlackEventArgs<"message">): Promise<void>;
  handleReactionAdded(args: SlackEventArgs<"reaction_added">): Promise<void>;
  handleSalesforcePdfWorkflowConfigureAction(
    args: SlackActionMiddlewareArgs & AllMiddlewareArgs,
  ): Promise<void>;
  handleSalesforcePdfWorkflowModalSubmission(
    args: SlackViewMiddlewareArgs & AllMiddlewareArgs,
  ): Promise<void>;
  handleFeatureSettingsConfigureAction(
    args: SlackActionMiddlewareArgs & AllMiddlewareArgs,
  ): Promise<void>;
  handleFeatureSettingsModalSubmission(
    args: SlackViewMiddlewareArgs & AllMiddlewareArgs,
  ): Promise<void>;
  handleRssFeedConfigureAction(args: SlackActionMiddlewareArgs & AllMiddlewareArgs): Promise<void>;
  handleRssFeedModalSubmission(args: SlackViewMiddlewareArgs & AllMiddlewareArgs): Promise<void>;
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
  app.event("assistant_thread_context_changed", async (args) =>
    handlers.handleAssistantThreadContextChanged(args),
  );
  app.event("assistant_thread_started", async (args) =>
    handlers.handleAssistantThreadStarted(args),
  );
  app.event("message", async (args) => handlers.handleMessage(args));
  app.event("reaction_added", async (args) => handlers.handleReactionAdded(args));
  app.action(WORKSPACE_CREDENTIAL_CONFIGURE_ACTION_ID, async (args) =>
    handlers.handleWorkspaceCredentialConfigureAction(args),
  );
  app.action(MODEL_ROUTING_CONFIGURE_ACTION_ID, async (args) =>
    handlers.handleModelRoutingConfigureAction(args),
  );
  app.action(MODEL_ROUTING_CHANNEL_CONFIGURE_ACTION_ID, async (args) =>
    handlers.handleModelRoutingConfigureAction(args),
  );
  app.action(MODEL_ROUTING_THREAD_CONFIGURE_ACTION_ID, async (args) =>
    handlers.handleModelRoutingConfigureAction(args),
  );
  app.action(MODEL_ROUTING_DEFAULT_MODEL_ACTION_ID, async (args) =>
    handlers.handleModelRoutingDefaultModelSelectAction(args),
  );
  app.action(WORKSPACE_CREDENTIAL_PROVIDER_ACTION_ID, async (args) =>
    handlers.handleWorkspaceCredentialProviderSelectAction(args),
  );
  app.action(SALESFORCE_PDF_WORKFLOW_CONFIGURE_ACTION_ID, async (args) =>
    handlers.handleSalesforcePdfWorkflowConfigureAction(args),
  );
  app.action(FEATURE_SETTINGS_CONFIGURE_ACTION_ID, async (args) =>
    handlers.handleFeatureSettingsConfigureAction(args),
  );
  app.action(RSS_FEED_CONFIGURE_ACTION_ID, async (args) =>
    handlers.handleRssFeedConfigureAction(args),
  );
  app.view(WORKSPACE_CREDENTIAL_MODAL_CALLBACK_ID, async (args) =>
    handlers.handleWorkspaceCredentialModalSubmission(args),
  );
  app.view(MODEL_ROUTING_MODAL_CALLBACK_ID, async (args) =>
    handlers.handleModelRoutingModalSubmission(args),
  );
  app.view(SALESFORCE_PDF_WORKFLOW_MODAL_CALLBACK_ID, async (args) =>
    handlers.handleSalesforcePdfWorkflowModalSubmission(args),
  );
  app.view(FEATURE_SETTINGS_MODAL_CALLBACK_ID, async (args) =>
    handlers.handleFeatureSettingsModalSubmission(args),
  );
  app.view(RSS_FEED_MODAL_CALLBACK_ID, async (args) => handlers.handleRssFeedModalSubmission(args));
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
                text: "Agents party",
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
    async handleAssistantThreadContextChanged({ body, context, logger }) {
      logger.warn("Slack assistant_thread_context_changed feature execution is not ported yet.", {
        eventId: readSlackEventId(body),
        retryNum: context.retryNum,
        retryReason: context.retryReason,
      });
    },
    async handleAssistantThreadStarted({ body, context, logger }) {
      logger.warn("Slack assistant_thread_started feature execution is not ported yet.", {
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
    async handleModelRoutingConfigureAction({ ack }) {
      await ack();
    },
    async handleModelRoutingDefaultModelSelectAction({ ack }) {
      await ack();
    },
    async handleModelRoutingModalSubmission({ ack }) {
      await ack();
    },
    async handleWorkspaceCredentialProviderSelectAction({ ack }) {
      await ack();
    },
    async handleWorkspaceCredentialModalSubmission({ ack }) {
      await ack();
    },
    async handleSalesforcePdfWorkflowConfigureAction({ ack }) {
      await ack();
    },
    async handleSalesforcePdfWorkflowModalSubmission({ ack }) {
      await ack();
    },
    async handleFeatureSettingsConfigureAction({ ack }) {
      await ack();
    },
    async handleFeatureSettingsModalSubmission({ ack }) {
      await ack();
    },
    async handleRssFeedConfigureAction({ ack }) {
      await ack();
    },
    async handleRssFeedModalSubmission({ ack }) {
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
