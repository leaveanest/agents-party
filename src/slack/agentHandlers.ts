import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  SlackEventMiddlewareArgs,
  SlackViewMiddlewareArgs,
  StringIndexed,
} from "@slack/bolt";

import {
  AgentRunnerExecutionError,
  type AgentRunner,
  type AgentRunnerResult,
} from "../agents/runner.js";
import { agentSpecialistSchema, type AgentSpecialist } from "../agents/schemas.js";
import type { JsonValue } from "../domain/messageHistory.js";
import type { CredentialProviderKind } from "../providers/credentials.js";
import {
  salesforceAuthConfigSchema,
  salesforceConnectionSchema,
} from "../integrations/oauth/domain.js";
import type { JsonObject } from "../infrastructure/postgres/jsonDocumentRepository.js";
import type { SlackEventFeatureHandlers } from "./events.js";
import {
  WORKSPACE_CREDENTIAL_BASE_URL_ACTION_ID,
  WORKSPACE_CREDENTIAL_BASE_URL_BLOCK_ID,
  WORKSPACE_CREDENTIAL_CONFIGURE_ACTION_ID,
  WORKSPACE_CREDENTIAL_MODAL_CALLBACK_ID,
  WORKSPACE_CREDENTIAL_PROVIDER_ACTION_ID,
  WORKSPACE_CREDENTIAL_PROVIDER_BLOCK_ID,
  WORKSPACE_CREDENTIAL_SECRET_ACTION_ID,
  WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID,
} from "./interactiveIds.js";

type SlackEventArgs<TEvent extends string> = SlackEventMiddlewareArgs<TEvent> & AllMiddlewareArgs;
type SlackActionArgs = SlackActionMiddlewareArgs & AllMiddlewareArgs;
type SlackViewArgs = SlackViewMiddlewareArgs & AllMiddlewareArgs;
type SlackClient = SlackEventArgs<"app_mention">["client"];

const workspaceCredentialProviderKinds = [
  "openai",
  "azure_openai",
  "anthropic",
  "google",
  "google_maps",
  "groq",
  "xai",
  "plamo",
  "nvidia",
  "litellm",
] as const satisfies readonly CredentialProviderKind[];

const workspaceCredentialProviderOptions = [
  { text: { text: "OpenAI", type: "plain_text" }, value: "openai" },
  { text: { text: "Azure OpenAI", type: "plain_text" }, value: "azure_openai" },
  { text: { text: "Anthropic", type: "plain_text" }, value: "anthropic" },
  { text: { text: "Google", type: "plain_text" }, value: "google" },
  { text: { text: "Google Maps", type: "plain_text" }, value: "google_maps" },
  { text: { text: "Groq", type: "plain_text" }, value: "groq" },
  { text: { text: "xAI", type: "plain_text" }, value: "xai" },
  { text: { text: "PLaMo", type: "plain_text" }, value: "plamo" },
  { text: { text: "NVIDIA", type: "plain_text" }, value: "nvidia" },
  { text: { text: "LiteLLM", type: "plain_text" }, value: "litellm" },
] as const satisfies readonly {
  text: { text: string; type: "plain_text" };
  value: CredentialProviderKind;
}[];

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

export type WorkspaceCredentialSettingsHome = {
  saveProviderApiKey(input: {
    createdByUserId?: string;
    payload?: JsonObject;
    providerKind: CredentialProviderKind;
    secret: string;
    teamId: string;
  }): Promise<void>;
};

export type AgentSlackHandlerOptions = {
  routingRepository?: SlackAgentRoutingRepository;
  salesforceConnectionHome?: SalesforceConnectionHome;
  workspaceCredentialSettings?: WorkspaceCredentialSettingsHome;
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
    async handleWorkspaceCredentialConfigureAction(args) {
      await handleWorkspaceCredentialConfigureAction(args, options);
    },
    async handleWorkspaceCredentialModalSubmission(args) {
      await handleWorkspaceCredentialModalSubmission(args, options);
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
      text: { text: "Party on Slack", type: "plain_text" },
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
  if (input.options.workspaceCredentialSettings !== undefined && input.teamId !== undefined) {
    blocks.push({ type: "divider" });
    blocks.push({
      text: { text: "API keys", type: "plain_text" },
      type: "header",
    });
    blocks.push({
      accessory: {
        action_id: WORKSPACE_CREDENTIAL_CONFIGURE_ACTION_ID,
        text: { text: "Configure", type: "plain_text" },
        type: "button",
      },
      text: {
        text: "Store workspace provider API keys for this Slack workspace.",
        type: "mrkdwn",
      },
      type: "section",
    });
  }
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

async function handleWorkspaceCredentialConfigureAction(
  { ack, body, client, logger }: SlackActionArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  await ack();
  const teamId = readTeamId(body, {});
  const slackUserId = readSlackUserId(body);
  const triggerId = isRecord(body) ? readString(body, "trigger_id") : undefined;
  if (teamId === undefined || slackUserId === undefined || triggerId === undefined) {
    logger.warn("Ignoring API key configuration action with missing Slack context.");
    return;
  }
  if (options.workspaceCredentialSettings === undefined) {
    await client.views.open({
      trigger_id: triggerId,
      view: buildWorkspaceCredentialUnavailableModal() as never,
    });
    return;
  }
  await client.views.open({
    trigger_id: triggerId,
    view: buildWorkspaceCredentialModal(teamId) as never,
  });
}

async function handleWorkspaceCredentialModalSubmission(
  { ack, body, client, logger, view }: SlackViewArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  const metadataTeamId = readString(view as unknown as StringIndexed, "private_metadata");
  const bodyTeamId = readTeamId(body, {});
  const teamId = bodyTeamId ?? metadataTeamId;
  const slackUserId = readSlackUserId(body);
  if (options.workspaceCredentialSettings === undefined) {
    await ack({
      errors: {
        [WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID]: "API key storage is not configured.",
      },
      response_action: "errors",
    });
    return;
  }
  if (metadataTeamId !== undefined && bodyTeamId !== undefined && metadataTeamId !== bodyTeamId) {
    await ack({
      errors: {
        [WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID]: "Slack workspace context does not match.",
      },
      response_action: "errors",
    });
    return;
  }
  if (teamId === undefined || slackUserId === undefined) {
    await ack({
      errors: {
        [WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID]: "Slack workspace context is missing.",
      },
      response_action: "errors",
    });
    return;
  }
  const parsed = parseWorkspaceCredentialModal(view);
  if ("errors" in parsed) {
    await ack({
      errors: parsed.errors,
      response_action: "errors",
    });
    return;
  }

  await ack({
    response_action: "update",
    view: buildWorkspaceCredentialSavingModal() as never,
  });

  try {
    if (!(await isWorkspaceAdmin(client, slackUserId, logger))) {
      await updateWorkspaceCredentialModal(
        client,
        view,
        buildWorkspaceCredentialResultModal(
          "API key",
          "Only Slack workspace admins and owners can configure API keys.",
        ),
        logger,
      );
      return;
    }
    await options.workspaceCredentialSettings.saveProviderApiKey({
      createdByUserId: slackUserId,
      payload: {
        ...(parsed.baseURL === undefined ? {} : { base_url: parsed.baseURL }),
        source: "slack_app_home",
      },
      providerKind: parsed.providerKind,
      secret: parsed.apiKey,
      teamId,
    });
    logInfo(logger, "Saved workspace provider API key from Slack modal.", {
      providerKind: parsed.providerKind,
      teamId,
    });
    await updateWorkspaceCredentialModal(
      client,
      view,
      buildWorkspaceCredentialResultModal("API key saved", "The workspace API key was saved."),
      logger,
    );
  } catch (error) {
    logger.error("Failed to save workspace provider API key from Slack modal.", {
      error,
      providerKind: parsed.providerKind,
      teamId,
    });
    await updateWorkspaceCredentialModal(
      client,
      view,
      buildWorkspaceCredentialResultModal(
        "API key",
        "Could not save this API key. Try again later.",
      ),
      logger,
    );
  }
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
  { body, client, event, logger }: SlackEventArgs<"message">,
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
  if (isRecord(body)) {
    if (typeof body.team_id === "string") {
      return body.team_id;
    }
    if (typeof body.team === "string") {
      return body.team;
    }
    if (isRecord(body.team) && typeof body.team.id === "string") {
      return body.team.id;
    }
    if (isRecord(body.user) && typeof body.user.team_id === "string") {
      return body.user.team_id;
    }
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
  client: SlackEventArgs<"message">["client"],
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

async function postAgentResult(input: {
  channel: string;
  client: SlackClient;
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

function buildWorkspaceCredentialModal(teamId: string): Record<string, unknown> {
  return {
    callback_id: WORKSPACE_CREDENTIAL_MODAL_CALLBACK_ID,
    private_metadata: teamId,
    submit: { text: "Save", type: "plain_text" },
    title: { text: "API key", type: "plain_text" },
    type: "modal",
    blocks: [
      {
        block_id: WORKSPACE_CREDENTIAL_PROVIDER_BLOCK_ID,
        element: {
          action_id: WORKSPACE_CREDENTIAL_PROVIDER_ACTION_ID,
          initial_option: workspaceCredentialProviderOptions[0],
          options: workspaceCredentialProviderOptions,
          type: "static_select",
        },
        label: { text: "Provider", type: "plain_text" },
        type: "input",
      },
      {
        block_id: WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID,
        element: {
          action_id: WORKSPACE_CREDENTIAL_SECRET_ACTION_ID,
          type: "plain_text_input",
        },
        label: { text: "API key", type: "plain_text" },
        type: "input",
      },
      {
        block_id: WORKSPACE_CREDENTIAL_BASE_URL_BLOCK_ID,
        element: {
          action_id: WORKSPACE_CREDENTIAL_BASE_URL_ACTION_ID,
          placeholder: { text: "https://proxy.example/v1", type: "plain_text" },
          type: "plain_text_input",
        },
        label: { text: "Base URL", type: "plain_text" },
        optional: true,
        type: "input",
      },
    ],
  };
}

function buildWorkspaceCredentialSavingModal(): Record<string, unknown> {
  return buildWorkspaceCredentialResultModal("API key", "Saving API key...");
}

function buildWorkspaceCredentialResultModal(title: string, text: string): Record<string, unknown> {
  return {
    close: { text: "Close", type: "plain_text" },
    title: { text: title, type: "plain_text" },
    type: "modal",
    blocks: [
      {
        text: {
          text,
          type: "mrkdwn",
        },
        type: "section",
      },
    ],
  };
}

function buildWorkspaceCredentialUnavailableModal(): Record<string, unknown> {
  return {
    close: { text: "Close", type: "plain_text" },
    title: { text: "API key", type: "plain_text" },
    type: "modal",
    blocks: [
      {
        text: {
          text: "API key storage is not configured for this app process.",
          type: "mrkdwn",
        },
        type: "section",
      },
    ],
  };
}

async function updateWorkspaceCredentialModal(
  client: SlackClient,
  view: unknown,
  modal: Record<string, unknown>,
  logger: unknown,
): Promise<void> {
  const viewId = readString(view as unknown as StringIndexed, "id");
  if (viewId === undefined) {
    logWarn(logger, "Could not update API key modal without Slack view id.", {});
    return;
  }
  try {
    await client.views.update({
      view: modal as never,
      view_id: viewId,
    });
  } catch (error) {
    logWarn(logger, "Failed to update API key modal.", { error, viewId });
  }
}

function parseWorkspaceCredentialModal(view: unknown):
  | {
      apiKey: string;
      baseURL?: string;
      providerKind: CredentialProviderKind;
    }
  | { errors: Record<string, string> } {
  const providerValue = readSelectedOptionValue(
    view,
    WORKSPACE_CREDENTIAL_PROVIDER_BLOCK_ID,
    WORKSPACE_CREDENTIAL_PROVIDER_ACTION_ID,
  );
  const providerKind = parseCredentialProviderKind(providerValue);
  const apiKey = readModalInputValue(
    view,
    WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID,
    WORKSPACE_CREDENTIAL_SECRET_ACTION_ID,
  )?.trim();
  const baseURL = readModalInputValue(
    view,
    WORKSPACE_CREDENTIAL_BASE_URL_BLOCK_ID,
    WORKSPACE_CREDENTIAL_BASE_URL_ACTION_ID,
  )?.trim();
  const errors: Record<string, string> = {};
  if (providerKind === undefined) {
    errors[WORKSPACE_CREDENTIAL_PROVIDER_BLOCK_ID] = "Choose a supported provider.";
  }
  if (apiKey === undefined || apiKey === "") {
    errors[WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID] = "Enter an API key.";
  }
  if (baseURL !== undefined && baseURL !== "" && !isHttpUrl(baseURL)) {
    errors[WORKSPACE_CREDENTIAL_BASE_URL_BLOCK_ID] = "Enter a valid http or https URL.";
  }
  if (Object.keys(errors).length > 0) {
    return { errors };
  }
  return {
    apiKey: apiKey as string,
    baseURL: baseURL === undefined || baseURL === "" ? undefined : baseURL,
    providerKind: providerKind as CredentialProviderKind,
  };
}

function parseCredentialProviderKind(
  value: string | undefined,
): CredentialProviderKind | undefined {
  return workspaceCredentialProviderKinds.find((providerKind) => providerKind === value);
}

async function isWorkspaceAdmin(
  client: SlackClient,
  slackUserId: string,
  logger: unknown,
): Promise<boolean> {
  try {
    const response = await client.users.info({ user: slackUserId });
    const user = response.user;
    if (!isRecord(user)) {
      return false;
    }
    return (
      readBoolean(user, "is_admin") === true ||
      readBoolean(user, "is_owner") === true ||
      readBoolean(user, "is_primary_owner") === true
    );
  } catch (error) {
    logWarn(logger, "Failed to verify Slack workspace admin status.", {
      error,
      slackUserId,
    });
    return false;
  }
}

function readSlackUserId(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  if (typeof body.user === "string") {
    return body.user;
  }
  if (isRecord(body.user) && typeof body.user.id === "string") {
    return body.user.id;
  }
  return undefined;
}

function readModalInputValue(view: unknown, blockId: string, actionId: string): string | undefined {
  const element = readModalElement(view, blockId, actionId);
  return isRecord(element) && typeof element.value === "string" ? element.value : undefined;
}

function readSelectedOptionValue(
  view: unknown,
  blockId: string,
  actionId: string,
): string | undefined {
  const element = readModalElement(view, blockId, actionId);
  const option = isRecord(element) ? element.selected_option : undefined;
  return isRecord(option) && typeof option.value === "string" ? option.value : undefined;
}

function readModalElement(view: unknown, blockId: string, actionId: string): unknown {
  if (!isRecord(view)) {
    return undefined;
  }
  const state = view.state;
  if (!isRecord(state)) {
    return undefined;
  }
  const values = state.values;
  if (!isRecord(values)) {
    return undefined;
  }
  const block = values[blockId];
  if (!isRecord(block)) {
    return undefined;
  }
  return block[actionId];
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
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

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBoolean(value: StringIndexed, field: string): boolean | undefined {
  const fieldValue = value[field];
  return typeof fieldValue === "boolean" ? fieldValue : undefined;
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
