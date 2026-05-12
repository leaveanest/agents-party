import type { AllMiddlewareArgs, SlackEventMiddlewareArgs, StringIndexed } from "@slack/bolt";

import {
  AgentRunnerExecutionError,
  type AgentRunner,
  type AgentRunnerResult,
} from "../agents/runner.js";
import { agentSpecialistSchema, type AgentSpecialist } from "../agents/schemas.js";
import type { JsonValue } from "../domain/messageHistory.js";
import {
  salesforceAuthConfigSchema,
  salesforceConnectionSchema,
} from "../integrations/oauth/domain.js";
import type { JsonObject } from "../infrastructure/postgres/jsonDocumentRepository.js";
import type { SlackAgentJob, SlackAgentJobQueue } from "../queues/slackAgentJobs.js";
import type { SlackEventFeatureHandlers } from "./events.js";
import { readSlackEventId } from "./idempotency.js";

type SlackEventArgs<TEvent extends string> = SlackEventMiddlewareArgs<TEvent> & AllMiddlewareArgs;
export type SlackAgentClient = Pick<
  SlackEventArgs<"app_mention">["client"],
  "chat" | "conversations" | "filesUploadV2"
>;

export type SlackResolvedAgentRoute = {
  agent: JsonObject;
  agentId: string;
  modelId?: string;
  modelScope?: string;
  scope: string;
};

export type SlackAgentRoutingRepository = {
  activateThreadAgent(input: {
    agentId: string;
    channelId: string;
    lastMessageTs: string;
    modelId?: string;
    rootMessageTs: string;
    teamId: string;
    threadTs: string;
  }): Promise<JsonObject>;
  findSlackThread(
    teamId: string,
    channelId: string,
    threadTs: string,
  ): Promise<JsonObject | undefined>;
  isChannelEnabled(teamId: string, channelId: string): Promise<boolean>;
  isThreadAutoReplyEnabled(teamId: string, channelId: string): Promise<boolean>;
  resolveAgent?(input: {
    channelId: string;
    teamId: string;
    threadTs?: string;
  }): Promise<SlackResolvedAgentRoute | undefined>;
};

export type SalesforceConnectionHomeRepository = {
  listSalesforceAuthConfigs(teamId: string): Promise<JsonObject[]>;
  listSalesforceConnections(teamId: string, slackUserId?: string): Promise<JsonObject[]>;
};

export type SalesforceConnectionHome = {
  buildStartUrl(input: {
    redirectAfterConnect?: string | null;
    salesforceOrgId: string;
    slackUserId: string;
    teamId: string;
  }): string;
  repository: SalesforceConnectionHomeRepository;
};

export type AgentSlackHandlerOptions = {
  agentJobQueue?: SlackAgentJobQueue;
  routingRepository?: SlackAgentRoutingRepository;
  salesforceConnectionHome?: SalesforceConnectionHome;
};

export function createAgentSlackHandlers(
  runner: AgentRunner,
  options: AgentSlackHandlerOptions = {},
): SlackEventFeatureHandlers {
  return {
    async handleAppHomeOpened({ body, client, event, logger }) {
      if (!hasStringField(event, "user")) {
        logger.warn("Ignoring app_home_opened without a Slack user id.");
        return;
      }
      const teamId = readTeamId(body, event);
      const blocks = await buildAppHomeBlocks({
        logger,
        options,
        slackUserId: event.user,
        teamId,
      });
      await client.views.publish({
        user_id: event.user,
        view: {
          blocks: blocks as never,
          type: "home",
        },
      });
    },
    async handleAppMention(args) {
      await handleMention(args, runner, options);
    },
    async handleMessage(args) {
      await handleMessage(args, runner, options);
    },
    async handleReactionAdded(args) {
      await handleReactionAdded(args, runner, options);
    },
  };
}

async function buildAppHomeBlocks(input: {
  logger: SlackEventArgs<"app_home_opened">["logger"];
  options: AgentSlackHandlerOptions;
  slackUserId: string;
  teamId: string | undefined;
}): Promise<Record<string, unknown>[]> {
  const blocks: Record<string, unknown>[] = [
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
  ];
  if (input.options.salesforceConnectionHome === undefined || input.teamId === undefined) {
    return blocks;
  }

  try {
    const { repository } = input.options.salesforceConnectionHome;
    const [rawConfigs, rawConnections] = await Promise.all([
      repository.listSalesforceAuthConfigs(input.teamId),
      repository.listSalesforceConnections(input.teamId, input.slackUserId),
    ]);
    const configs = rawConfigs.map((config) => salesforceAuthConfigSchema.parse(config));
    const connections = rawConnections.map((connection) =>
      salesforceConnectionSchema.parse(connection),
    );
    if (configs.length === 0) {
      return blocks;
    }
    blocks.push({ type: "divider" });
    blocks.push({
      text: { text: "Salesforce", type: "plain_text" },
      type: "header",
    });
    for (const config of configs) {
      const connection = connections.find(
        (item) => item.salesforce_org_id === config.salesforce_org_id,
      );
      const status = connection?.connection_status ?? "not_connected";
      const actionLabel = status === "active" ? "Reconnect" : "Connect";
      blocks.push({
        accessory: {
          text: { text: actionLabel, type: "plain_text" },
          type: "button",
          url: input.options.salesforceConnectionHome.buildStartUrl({
            redirectAfterConnect: "/",
            salesforceOrgId: config.salesforce_org_id,
            slackUserId: input.slackUserId,
            teamId: input.teamId,
          }),
        },
        text: {
          text: `*${config.salesforce_org_name ?? config.salesforce_org_id}*\n${salesforceStatusText(
            status,
            connection?.salesforce_username ?? connection?.salesforce_user_email ?? undefined,
          )}`,
          type: "mrkdwn",
        },
        type: "section",
      });
    }
  } catch (error) {
    input.logger.warn("Failed to load Salesforce App Home connection status.", { error });
  }
  return blocks;
}

function salesforceStatusText(status: string, accountLabel: string | undefined): string {
  if (status === "active") {
    return accountLabel === undefined ? "Connected" : `Connected as ${accountLabel}`;
  }
  if (status === "expired") {
    return "Reconnect required";
  }
  if (status === "revoked") {
    return "Disconnected";
  }
  if (status === "error") {
    return "Connection needs attention";
  }
  return "Not connected";
}

async function handleMention(
  { body, client, context, event, logger }: SlackEventArgs<"app_mention">,
  runner: AgentRunner,
  options: AgentSlackHandlerOptions,
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
  if (options.agentJobQueue !== undefined) {
    if (
      options.routingRepository !== undefined &&
      !(await options.routingRepository.isChannelEnabled(teamId, event.channel))
    ) {
      return;
    }
    await enqueueSlackAgentJob({
      body,
      client,
      eventType: "app_mention",
      job: {
        botUserId: context.botUserId,
        channelId: event.channel,
        enterpriseId: readBodyString(body, "enterprise_id"),
        eventId: readSlackEventId(body),
        eventType: "app_mention",
        isEnterpriseInstall: readBodyBoolean(body, "is_enterprise_install"),
        messageTs: event.ts,
        retryNum: readOptionalContextValue(context.retryNum),
        retryReason: readOptionalContextValue(context.retryReason),
        teamId,
        text: stripBotMention(readString(event, "text") ?? "", context.botUserId),
        threadTs,
        userId: event.user,
      },
      logger,
      queue: options.agentJobQueue,
      threadTs,
    });
    return;
  }

  let runnerResult: AgentRunnerResult | undefined;
  let text: string;
  try {
    if (
      options.routingRepository !== undefined &&
      !(await options.routingRepository.isChannelEnabled(teamId, event.channel))
    ) {
      return;
    }
    const route = await resolveSlackAgentRoute(options.routingRepository, {
      channelId: event.channel,
      teamId,
      threadTs,
    });
    if (options.routingRepository?.resolveAgent !== undefined && route === undefined) {
      text = "No agent is configured for this channel or workspace.";
      await client.chat.postMessage({
        channel: event.channel,
        text,
        thread_ts: threadTs,
      });
      return;
    }
    const routedSpecialist = specialistFromRoute(route);
    if (route !== undefined && routedSpecialist === undefined) {
      text = "The configured agent is not runnable. Please check the agent settings.";
      await client.chat.postMessage({
        channel: event.channel,
        text,
        thread_ts: threadTs,
      });
      return;
    }
    const result = await runner.run({
      channelId: event.channel,
      messageTs: event.ts,
      modelId: route?.modelId,
      specialist: routedSpecialist,
      teamId,
      text: stripBotMention(readString(event, "text") ?? "", context.botUserId),
      threadTs,
      userId: event.user,
      viewerContextChannelIds: [event.channel],
    });
    runnerResult = result;
    text = result.message;
    logAgentRunnerSuccess(logger, {
      channelId: event.channel,
      eventType: "app_mention",
      messageTs: event.ts,
      result,
      teamId,
      threadTs,
    });
    if (options.routingRepository !== undefined) {
      try {
        await options.routingRepository.activateThreadAgent({
          agentId: route?.agentId ?? result.decision.specialist,
          channelId: event.channel,
          lastMessageTs: event.ts,
          modelId: threadScopedModelId(route),
          rootMessageTs: threadTs,
          teamId,
          threadTs,
        });
      } catch (error) {
        logger.warn("Failed to persist Slack thread routing state after app_mention.", {
          error,
          teamId,
          threadTs,
        });
      }
    }
  } catch (error) {
    logger.error("TypeScript AgentRunner failed while handling app_mention.", {
      error,
      ...runnerFailureLogFields(error),
      teamId,
      threadTs,
    });
    text = "I couldn't complete that request. Please try again in a moment.";
  }

  await postAgentResult({
    channel: event.channel,
    client,
    logger,
    result: runnerResult,
    text,
    threadTs,
  });
}

async function handleMessage(
  { body, client, context, event, logger }: SlackEventArgs<"message">,
  runner: AgentRunner,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  if (
    !hasStringField(event, "channel") ||
    !hasStringField(event, "user") ||
    !hasStringField(event, "ts")
  ) {
    logger.warn("Ignoring message with missing channel, user, or timestamp.");
    return;
  }
  const teamId = readTeamId(body, event);
  if (teamId === undefined) {
    logger.warn("Ignoring message without a team id.");
    return;
  }
  const threadTs = readString(event, "thread_ts");
  if (!isSupportedFollowUpMessage(event, threadTs) || options.routingRepository === undefined) {
    return;
  }
  if (threadTs === undefined) {
    return;
  }

  const [thread, autoReplyEnabled, channelEnabled] = await Promise.all([
    options.routingRepository.findSlackThread(teamId, event.channel, threadTs),
    options.routingRepository.isThreadAutoReplyEnabled(teamId, event.channel),
    options.routingRepository.isChannelEnabled(teamId, event.channel),
  ]);
  if (!channelEnabled || !autoReplyEnabled || !isActiveThread(thread)) {
    return;
  }

  if (options.agentJobQueue !== undefined) {
    await enqueueSlackAgentJob({
      body,
      client,
      eventType: "message_follow_up",
      job: {
        channelId: event.channel,
        enterpriseId: readBodyString(body, "enterprise_id"),
        eventId: readSlackEventId(body),
        eventType: "message_follow_up",
        isEnterpriseInstall: readBodyBoolean(body, "is_enterprise_install"),
        messageTs: event.ts,
        retryNum: readOptionalContextValue(context.retryNum),
        retryReason: readOptionalContextValue(context.retryReason),
        teamId,
        text: readString(event, "text") ?? "",
        threadTs,
        userId: event.user,
      },
      logger,
      queue: options.agentJobQueue,
      threadTs,
    });
    return;
  }

  let runnerResult: AgentRunnerResult | undefined;
  let text: string;
  try {
    const route = await resolveSlackAgentRoute(options.routingRepository, {
      channelId: event.channel,
      teamId,
      threadTs,
    });
    if (options.routingRepository.resolveAgent !== undefined && route === undefined) {
      return;
    }
    const routedSpecialist = specialistFromRoute(route);
    if (route !== undefined && routedSpecialist === undefined) {
      return;
    }
    const specialist = routedSpecialist ?? stringField(thread, "agent_id");
    const modelId = route === undefined ? stringField(thread, "model_id") : route.modelId;
    const result = await runner.run({
      channelId: event.channel,
      messageTs: event.ts,
      modelId,
      specialist,
      teamId,
      text: readString(event, "text") ?? "",
      threadMessages: await readThreadTextMessages(client, event.channel, threadTs),
      threadTs,
      userId: event.user,
      viewerContextChannelIds: [event.channel],
    });
    runnerResult = result;
    text = result.message;
    logAgentRunnerSuccess(logger, {
      channelId: event.channel,
      eventType: "message_follow_up",
      messageTs: event.ts,
      result,
      teamId,
      threadTs,
    });
    try {
      await options.routingRepository.activateThreadAgent({
        agentId: route?.agentId ?? result.decision.specialist,
        channelId: event.channel,
        lastMessageTs: event.ts,
        modelId: route === undefined ? stringField(thread, "model_id") : threadScopedModelId(route),
        rootMessageTs: stringField(thread, "root_message_ts") ?? threadTs,
        teamId,
        threadTs,
      });
    } catch (error) {
      logger.warn("Failed to persist Slack thread routing state after message follow-up.", {
        error,
        teamId,
        threadTs,
      });
    }
  } catch (error) {
    logger.error("TypeScript AgentRunner failed while handling message follow-up.", {
      error,
      ...runnerFailureLogFields(error),
      teamId,
      threadTs,
    });
    text = "I couldn't complete that request. Please try again in a moment.";
  }

  await postAgentResult({
    channel: event.channel,
    client,
    logger,
    result: runnerResult,
    text,
    threadTs,
  });
}

export async function processSlackAgentJob(
  job: SlackAgentJob,
  input: {
    client: SlackAgentClient;
    logger: unknown;
    routingRepository?: SlackAgentRoutingRepository;
    runner: AgentRunner;
  },
): Promise<void> {
  if (job.eventType === "app_mention") {
    await processAppMentionJob(job, input);
    return;
  }
  await processFollowUpMessageJob(job, input);
}

async function processAppMentionJob(
  job: SlackAgentJob,
  input: {
    client: SlackAgentClient;
    logger: unknown;
    routingRepository?: SlackAgentRoutingRepository;
    runner: AgentRunner;
  },
): Promise<void> {
  if (
    input.routingRepository !== undefined &&
    !(await input.routingRepository.isChannelEnabled(job.teamId, job.channelId))
  ) {
    return;
  }

  let runnerResult: AgentRunnerResult | undefined;
  let text: string;
  try {
    const route = await resolveSlackAgentRoute(input.routingRepository, {
      channelId: job.channelId,
      teamId: job.teamId,
      threadTs: job.threadTs,
    });
    if (input.routingRepository?.resolveAgent !== undefined && route === undefined) {
      await input.client.chat.postMessage({
        channel: job.channelId,
        text: "No agent is configured for this channel or workspace.",
        thread_ts: job.threadTs,
      });
      return;
    }
    const routedSpecialist = specialistFromRoute(route);
    if (route !== undefined && routedSpecialist === undefined) {
      await input.client.chat.postMessage({
        channel: job.channelId,
        text: "The configured agent is not runnable. Please check the agent settings.",
        thread_ts: job.threadTs,
      });
      return;
    }
    const result = await input.runner.run({
      channelId: job.channelId,
      messageTs: job.messageTs,
      modelId: route?.modelId,
      specialist: routedSpecialist,
      teamId: job.teamId,
      text: job.text,
      threadTs: job.threadTs,
      userId: job.userId,
      viewerContextChannelIds: [job.channelId],
    });
    runnerResult = result;
    text = result.message;
    logAgentRunnerSuccess(input.logger, {
      channelId: job.channelId,
      eventType: "app_mention",
      messageTs: job.messageTs,
      result,
      teamId: job.teamId,
      threadTs: job.threadTs,
    });
    if (input.routingRepository !== undefined) {
      try {
        await input.routingRepository.activateThreadAgent({
          agentId: route?.agentId ?? result.decision.specialist,
          channelId: job.channelId,
          lastMessageTs: job.messageTs,
          modelId: threadScopedModelId(route),
          rootMessageTs: job.threadTs,
          teamId: job.teamId,
          threadTs: job.threadTs,
        });
      } catch (error) {
        logWarn(input.logger, "Failed to persist Slack thread routing state after app_mention.", {
          error,
          teamId: job.teamId,
          threadTs: job.threadTs,
        });
      }
    }
  } catch (error) {
    logError(input.logger, "TypeScript AgentRunner failed while handling app_mention.", {
      error,
      ...runnerFailureLogFields(error),
      teamId: job.teamId,
      threadTs: job.threadTs,
    });
    text = "I couldn't complete that request. Please try again in a moment.";
  }

  await postAgentResult({
    channel: job.channelId,
    client: input.client,
    logger: input.logger,
    result: runnerResult,
    text,
    threadTs: job.threadTs,
  });
}

async function processFollowUpMessageJob(
  job: SlackAgentJob,
  input: {
    client: SlackAgentClient;
    logger: unknown;
    routingRepository?: SlackAgentRoutingRepository;
    runner: AgentRunner;
  },
): Promise<void> {
  if (input.routingRepository === undefined) {
    return;
  }
  const [thread, autoReplyEnabled, channelEnabled] = await Promise.all([
    input.routingRepository.findSlackThread(job.teamId, job.channelId, job.threadTs),
    input.routingRepository.isThreadAutoReplyEnabled(job.teamId, job.channelId),
    input.routingRepository.isChannelEnabled(job.teamId, job.channelId),
  ]);
  if (!channelEnabled || !autoReplyEnabled || !isActiveThread(thread)) {
    return;
  }

  let runnerResult: AgentRunnerResult | undefined;
  let text: string;
  try {
    const route = await resolveSlackAgentRoute(input.routingRepository, {
      channelId: job.channelId,
      teamId: job.teamId,
      threadTs: job.threadTs,
    });
    if (input.routingRepository.resolveAgent !== undefined && route === undefined) {
      return;
    }
    const routedSpecialist = specialistFromRoute(route);
    if (route !== undefined && routedSpecialist === undefined) {
      return;
    }
    const specialist = routedSpecialist ?? stringField(thread, "agent_id");
    const modelId = route === undefined ? stringField(thread, "model_id") : route.modelId;
    const result = await input.runner.run({
      channelId: job.channelId,
      messageTs: job.messageTs,
      modelId,
      specialist,
      teamId: job.teamId,
      text: job.text,
      threadMessages: await readThreadTextMessages(input.client, job.channelId, job.threadTs),
      threadTs: job.threadTs,
      userId: job.userId,
      viewerContextChannelIds: [job.channelId],
    });
    runnerResult = result;
    text = result.message;
    logAgentRunnerSuccess(input.logger, {
      channelId: job.channelId,
      eventType: "message_follow_up",
      messageTs: job.messageTs,
      result,
      teamId: job.teamId,
      threadTs: job.threadTs,
    });
    try {
      await input.routingRepository.activateThreadAgent({
        agentId: route?.agentId ?? result.decision.specialist,
        channelId: job.channelId,
        lastMessageTs: job.messageTs,
        modelId: route === undefined ? stringField(thread, "model_id") : threadScopedModelId(route),
        rootMessageTs: stringField(thread, "root_message_ts") ?? job.threadTs,
        teamId: job.teamId,
        threadTs: job.threadTs,
      });
    } catch (error) {
      logWarn(
        input.logger,
        "Failed to persist Slack thread routing state after message follow-up.",
        {
          error,
          teamId: job.teamId,
          threadTs: job.threadTs,
        },
      );
    }
  } catch (error) {
    logError(input.logger, "TypeScript AgentRunner failed while handling message follow-up.", {
      error,
      ...runnerFailureLogFields(error),
      teamId: job.teamId,
      threadTs: job.threadTs,
    });
    text = "I couldn't complete that request. Please try again in a moment.";
  }

  await postAgentResult({
    channel: job.channelId,
    client: input.client,
    logger: input.logger,
    result: runnerResult,
    text,
    threadTs: job.threadTs,
  });
}

async function enqueueSlackAgentJob(input: {
  body: unknown;
  client: SlackAgentClient;
  eventType: SlackAgentJob["eventType"];
  job: SlackAgentJob;
  logger: unknown;
  queue: SlackAgentJobQueue;
  threadTs: string;
}): Promise<void> {
  try {
    const result = await input.queue.enqueue(input.job);
    logInfo(input.logger, "Queued Slack agent job.", {
      deduplicated: result.deduplicated,
      eventId: readSlackEventId(input.body),
      eventType: input.eventType,
      jobId: result.jobId,
      teamId: input.job.teamId,
      threadTs: input.threadTs,
    });
  } catch (error) {
    logError(input.logger, "Failed to queue Slack agent job.", {
      error,
      eventId: readSlackEventId(input.body),
      eventType: input.eventType,
      teamId: input.job.teamId,
      threadTs: input.threadTs,
    });
    await input.client.chat.postMessage({
      channel: input.job.channelId,
      text: "I couldn't queue that request. Please try again in a moment.",
      thread_ts: input.threadTs,
    });
  }
}

async function handleReactionAdded(
  { body, client, event, logger }: SlackEventArgs<"reaction_added">,
  runner: AgentRunner,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  const targetLanguage = resolveTranslationLanguageFromReaction(readString(event, "reaction"));
  if (targetLanguage === undefined) {
    return;
  }
  const teamId = readTeamId(body, event);
  const item = event.item;
  if (teamId === undefined || !isRecord(item) || item.type !== "message") {
    return;
  }
  const channelId = typeof item.channel === "string" ? item.channel : undefined;
  const messageTs = typeof item.ts === "string" ? item.ts : undefined;
  if (channelId === undefined || messageTs === undefined) {
    return;
  }
  if (options.routingRepository === undefined) {
    return;
  }
  if (!(await options.routingRepository.isChannelEnabled(teamId, channelId))) {
    return;
  }

  let sourceText: string | undefined;
  let threadTs = messageTs;
  try {
    const sourceMessage = await fetchSingleMessage(client, channelId, messageTs);
    sourceText = readString(sourceMessage, "text");
    threadTs = readString(sourceMessage, "thread_ts") ?? messageTs;
  } catch (error) {
    logger.warn("Could not fetch source message for translation reaction.", {
      error,
      teamId,
      threadTs,
    });
  }

  let text: string;
  try {
    const route = await resolveSlackAgentRoute(options.routingRepository, {
      channelId,
      teamId,
      threadTs,
    });
    if (options.routingRepository.resolveAgent !== undefined && route === undefined) {
      return;
    }
    const routedSpecialist = specialistFromRoute(route);
    if (route !== undefined && routedSpecialist !== "translation") {
      return;
    }
    if (sourceText === undefined || sourceText.trim() === "") {
      await client.chat.postMessage({
        channel: channelId,
        text: "I couldn't read text from the reacted message.",
        thread_ts: threadTs,
      });
      return;
    }
    const result = await runner.run({
      channelId,
      messageTs,
      modelId: route?.modelId,
      specialist: "translation",
      teamId,
      text: `Translate the following Slack message to ${targetLanguage}:\n\n${sourceText}`,
      threadTs,
      userId: readString(event, "user") ?? "unknown",
      viewerContextChannelIds: [channelId],
    });
    text = result.message;
    logAgentRunnerSuccess(logger, {
      channelId,
      eventType: "reaction_added",
      messageTs,
      result,
      teamId,
      threadTs,
    });
  } catch (error) {
    logger.error("TypeScript AgentRunner failed while handling translation reaction.", {
      error,
      ...runnerFailureLogFields(error),
      teamId,
      threadTs,
    });
    text = "I couldn't translate that message. Please try again in a moment.";
  }

  await client.chat.postMessage({
    channel: channelId,
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

function isSupportedFollowUpMessage(event: StringIndexed, threadTs: string | undefined): boolean {
  if (typeof event.bot_id === "string") {
    return false;
  }
  if (isRecord(event.bot_profile)) {
    return false;
  }
  const subtype = readString(event, "subtype");
  if (subtype !== undefined) {
    return false;
  }
  if (threadTs === undefined || threadTs === event.ts) {
    return false;
  }
  return (readString(event, "text") ?? "").trim() !== "";
}

async function readThreadTextMessages(
  client: SlackAgentClient,
  channelId: string,
  threadTs: string,
): Promise<string[]> {
  try {
    const response = await client.conversations.replies({
      channel: channelId,
      limit: 20,
      ts: threadTs,
    });
    const messages = Array.isArray(response.messages) ? response.messages : [];
    return messages
      .map((message) => (isRecord(message) ? readString(message, "text") : undefined))
      .filter((text): text is string => text !== undefined);
  } catch {
    return [];
  }
}

export async function postAgentResult(input: {
  channel: string;
  client: SlackAgentClient;
  logger: unknown;
  result: AgentRunnerResult | undefined;
  text: string;
  threadTs: string;
}): Promise<void> {
  const media = readGeneratedMedia(input.result?.structuredResult);
  if (media?.dataBase64 !== undefined) {
    await input.client.filesUploadV2({
      channel_id: input.channel,
      file: Buffer.from(media.dataBase64, "base64"),
      filename: mediaFilename(media),
      initial_comment: input.text,
      thread_ts: input.threadTs,
    });
    logInfo(input.logger, "Delivered generated media to Slack.", {
      channelId: input.channel,
      delivery: "file_upload",
      mediaKind: media.kind,
      threadTs: input.threadTs,
    });
    return;
  }

  const suffix = media?.uri ?? media?.operationName;
  await input.client.chat.postMessage({
    channel: input.channel,
    text: suffix === undefined ? input.text : `${input.text}\n${suffix}`,
    thread_ts: input.threadTs,
  });
  if (suffix !== undefined) {
    logInfo(input.logger, "Delivered generated media handoff to Slack.", {
      channelId: input.channel,
      delivery: media?.uri === undefined ? "operation" : "uri",
      mediaKind: media?.kind,
      threadTs: input.threadTs,
    });
  }
}

function logAgentRunnerSuccess(
  logger: unknown,
  input: {
    channelId: string;
    eventType: "app_mention" | "message_follow_up" | "reaction_added";
    messageTs: string;
    result: AgentRunnerResult;
    teamId: string;
    threadTs: string;
  },
): void {
  const media = readGeneratedMedia(input.result.structuredResult);
  logInfo(logger, "TypeScript AgentRunner completed Slack event.", {
    channelId: input.channelId,
    eventType: input.eventType,
    hasStructuredResult: input.result.structuredResult !== undefined,
    mediaKind: media?.kind,
    messageTs: input.messageTs,
    modelId: input.result.model?.id,
    provider: input.result.model?.provider,
    specialist: input.result.decision.specialist,
    teamId: input.teamId,
    threadTs: input.threadTs,
    toolResultCount: input.result.toolResults.length,
  });
}

function logInfo(logger: unknown, message: string, metadata: Record<string, unknown>): void {
  if (isRecord(logger) && typeof logger.info === "function") {
    logger.info(message, metadata);
  }
}

function logWarn(logger: unknown, message: string, metadata: Record<string, unknown>): void {
  if (isRecord(logger) && typeof logger.warn === "function") {
    logger.warn(message, metadata);
  }
}

function logError(logger: unknown, message: string, metadata: Record<string, unknown>): void {
  if (isRecord(logger) && typeof logger.error === "function") {
    logger.error(message, metadata);
  }
}

function runnerFailureLogFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof AgentRunnerExecutionError)) {
    return {};
  }
  return {
    modelId: error.model?.id,
    provider: error.model?.provider,
    specialist: error.specialist,
  };
}

function readGeneratedMedia(value: JsonValue | undefined): GeneratedSlackMedia | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const media = value.media;
  if (!isRecord(media)) {
    return undefined;
  }
  if (media.kind !== "image" && media.kind !== "video") {
    return undefined;
  }
  return {
    dataBase64: readOptionalString(media.dataBase64),
    kind: media.kind,
    mimeType: readOptionalString(media.mimeType),
    operationName: readOptionalString(media.operationName),
    uri: readOptionalString(media.uri),
  };
}

type GeneratedSlackMedia = {
  dataBase64?: string;
  kind: "image" | "video";
  mimeType?: string;
  operationName?: string;
  uri?: string;
};

function mediaFilename(media: GeneratedSlackMedia): string {
  const extension = mediaExtension(media);
  return `generated-${media.kind}.${extension}`;
}

function mediaExtension(media: GeneratedSlackMedia): string {
  if (media.mimeType === "image/jpeg") {
    return "jpg";
  }
  if (media.mimeType === "image/webp") {
    return "webp";
  }
  if (media.mimeType === "video/mp4") {
    return "mp4";
  }
  return media.kind === "image" ? "png" : "mp4";
}

async function fetchSingleMessage(
  client: SlackEventArgs<"reaction_added">["client"],
  channelId: string,
  messageTs: string,
): Promise<StringIndexed> {
  const response = await client.conversations.history({
    channel: channelId,
    inclusive: true,
    latest: messageTs,
    limit: 1,
    oldest: messageTs,
  });
  const messages = Array.isArray(response.messages) ? response.messages : [];
  const message = messages[0];
  if (!isRecord(message)) {
    throw new Error("Slack history response did not contain a message.");
  }
  return message;
}

function resolveTranslationLanguageFromReaction(reaction: string | undefined): string | undefined {
  const normalized = reaction
    ?.trim()
    .toLocaleLowerCase()
    .replace(/^flag-/u, "");
  if (normalized === undefined || normalized === "") {
    return undefined;
  }
  return FLAG_REACTION_LANGUAGE_CODES[normalized];
}

function isActiveThread(thread: JsonObject | undefined): boolean {
  return (
    thread !== undefined &&
    stringField(thread, "status") === "active" &&
    stringField(thread, "agent_id") !== undefined
  );
}

async function resolveSlackAgentRoute(
  repository: SlackAgentRoutingRepository | undefined,
  input: {
    channelId: string;
    teamId: string;
    threadTs?: string;
  },
): Promise<SlackResolvedAgentRoute | undefined> {
  return repository?.resolveAgent?.(input);
}

function specialistFromRoute(
  route: SlackResolvedAgentRoute | undefined,
): AgentSpecialist | undefined {
  if (route === undefined) {
    return undefined;
  }
  const candidate = stringField(route.agent, "specialist") ?? route.agentId;
  const parsed = agentSpecialistSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function threadScopedModelId(route: SlackResolvedAgentRoute | undefined): string | undefined {
  return route?.modelScope === "thread" ? route.modelId : undefined;
}

function stringField(value: JsonObject | undefined, field: string): string | undefined {
  const fieldValue = value?.[field];
  return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : undefined;
}

const FLAG_REACTION_LANGUAGE_CODES: Record<string, string> = {
  au: "en",
  br: "pt",
  ca: "en",
  cn: "zh-CN",
  cz: "cs",
  de: "de",
  dk: "da",
  es: "es",
  fi: "fi",
  fr: "fr",
  gb: "en",
  gr: "el",
  hk: "zh-TW",
  hu: "hu",
  id: "id",
  il: "he",
  in: "hi",
  it: "it",
  jp: "ja",
  kr: "ko",
  mx: "es",
  nl: "nl",
  no: "no",
  nz: "en",
  pl: "pl",
  pt: "pt",
  ro: "ro",
  ru: "ru",
  sa: "ar",
  se: "sv",
  th: "th",
  tr: "tr",
  tw: "zh-TW",
  ua: "uk",
  us: "en",
  vn: "vi",
};

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

function readBodyString(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const fieldValue = value[field];
  return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : undefined;
}

function readBodyBoolean(value: unknown, field: string): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value[field] === "boolean" ? value[field] : undefined;
}

function readOptionalContextValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
