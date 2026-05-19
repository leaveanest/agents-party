import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  SlackEventMiddlewareArgs,
  SlackViewMiddlewareArgs,
  StringIndexed,
} from "@slack/bolt";
import { z } from "zod";

import {
  AgentRunnerExecutionError,
  type AgentRunner,
  type AgentRunnerResult,
  type AgentRunnerStructuredResult,
} from "../agents/runner.js";
import type { JsonValue } from "../domain/messageHistory.js";
import {
  FALLBACK_LOCALE,
  createTranslator,
  defaultTranslator,
  normalizeLocale,
  type Locale,
  type Translator,
} from "../i18n/index.js";
import type { CredentialProviderKind } from "../providers/credentials.js";
import {
  LlmReasoningEffortId,
  llmProviders,
  type LlmResponseFormat,
  type LlmProvider,
  type LlmReasoningEffort,
} from "../providers/contracts.js";
import {
  modelDefaultReasoningEffort,
  normalizeReasoningEffort,
  supportedReasoningEffortsForModel,
} from "../providers/reasoningOptions.js";
import {
  salesforceAuthConfigSchema,
  salesforceConnectionSchema,
} from "../integrations/oauth/domain.js";
import {
  salesforcePdfAttachTargetSchema,
  salesforcePdfWorkflowActionLabel,
  salesforcePdfWorkflowActions,
  salesforcePdfWorkflowSettingsSchema,
  type SalesforcePdfAttachTarget,
  type SalesforcePdfWorkflowAction,
  type SalesforcePdfWorkflowSettings,
} from "../domain/salesforcePdfWorkflows.js";
import type { JsonObject } from "../infrastructure/postgres/jsonDocumentRepository.js";
import type { TranscriptionGateway } from "../providers/transcriptionGateway.js";
import { createDefaultModelRegistry } from "../providers/modelRegistry.js";
import type { SlackAgentJob, SlackAgentJobQueue } from "../queues/slackAgentJobs.js";
import type { UserSettingsRepository } from "../repositories/userSettings.js";
import {
  SlackAudioProcessingError,
  hasSlackAudioFiles,
  resolveSlackAudioAttachments,
} from "./audioTranscription.js";
import {
  readSlackEnterpriseId,
  readSlackEnterpriseInstall,
  readTeamId,
  resolveSlackAppHomeContext,
  type SlackAppHomeContext,
} from "./appHomeContext.js";
import type { SlackEventFeatureHandlers } from "./events.js";
import { readSlackEventId } from "./idempotency.js";
import {
  MODEL_ROUTING_CHANNEL_CONFIGURE_ACTION_ID,
  MODEL_ROUTING_CONFIGURE_ACTION_ID,
  MODEL_ROUTING_DEFAULT_MODEL_ACTION_ID,
  MODEL_ROUTING_DEFAULT_MODEL_BLOCK_ID,
  MODEL_ROUTING_ENABLED_MODELS_ACTION_ID,
  MODEL_ROUTING_ENABLED_MODELS_BLOCK_ID,
  MODEL_ROUTING_MODAL_CALLBACK_ID,
  MODEL_ROUTING_REASONING_EFFORT_ACTION_ID,
  MODEL_ROUTING_REASONING_EFFORT_BLOCK_ID,
  MODEL_ROUTING_THREAD_CONFIGURE_ACTION_ID,
  MODEL_ROUTING_WORKSPACE_SELECT_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_ALLOWED_STAGES_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_ALLOWED_STAGES_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_ALLOWED_STATUSES_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_ALLOWED_STATUSES_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_AI_SUMMARY_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_AI_SUMMARY_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_APPROVAL_FIELD_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_APPROVAL_FIELD_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_APPROVAL_STATUSES_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_APPROVAL_STATUSES_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_ATTACH_TO_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_ATTACH_TO_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_CONFIGURE_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_CONFIRMATION_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_CONFIRMATION_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_ENABLED_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_ENABLED_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_FIELD_MAPPING_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_FIELD_MAPPING_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_MODAL_CALLBACK_ID,
  SALESFORCE_PDF_WORKFLOW_RECORD_TYPES_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_RECORD_TYPES_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_REQUIRED_FIELDS_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_REQUIRED_FIELDS_BLOCK_ID,
  SALESFORCE_PDF_WORKFLOW_TEMPLATE_ACTION_ID,
  SALESFORCE_PDF_WORKFLOW_TEMPLATE_BLOCK_ID,
  WORKSPACE_CREDENTIAL_BASE_URL_ACTION_ID,
  WORKSPACE_CREDENTIAL_BASE_URL_BLOCK_ID,
  WORKSPACE_CREDENTIAL_CONFIGURE_ACTION_ID,
  WORKSPACE_CREDENTIAL_MODAL_CALLBACK_ID,
  WORKSPACE_CREDENTIAL_PROVIDER_ACTION_ID,
  WORKSPACE_CREDENTIAL_PROVIDER_BLOCK_ID,
  WORKSPACE_CREDENTIAL_SORACOM_AUTH_KEY_ID_ACTION_ID,
  WORKSPACE_CREDENTIAL_SORACOM_AUTH_KEY_ID_BLOCK_ID,
  WORKSPACE_CREDENTIAL_SORACOM_COVERAGE_ACTION_ID,
  WORKSPACE_CREDENTIAL_SORACOM_COVERAGE_BLOCK_ID,
  WORKSPACE_CREDENTIAL_SORACOM_OPERATOR_ACTION_ID,
  WORKSPACE_CREDENTIAL_SORACOM_OPERATOR_BLOCK_ID,
  WORKSPACE_CREDENTIAL_SECRET_ACTION_ID,
  WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID,
} from "./interactiveIds.js";
import type { SlackInstalledWorkspace } from "./installationStore.js";
import { resolveUserSettingsTranslator } from "./userLocale.js";

type SlackEventArgs<TEvent extends string> = SlackEventMiddlewareArgs<TEvent> & AllMiddlewareArgs;
type SlackActionArgs = SlackActionMiddlewareArgs & AllMiddlewareArgs;
type SlackViewArgs = SlackViewMiddlewareArgs & AllMiddlewareArgs;
type SlackClient = SlackEventArgs<"app_mention">["client"];
type SlackOption = {
  text: {
    text: string;
    type: "plain_text";
  };
  value: string;
};
type SlackThreadHistoryMessage =
  | {
      messageTs?: string;
      role: "user";
      teamId: string;
      text: string;
      userId: string;
    }
  | {
      botId?: string;
      messageTs?: string;
      role: "assistant";
      teamId?: string;
      text: string;
      userId?: string;
    };
type ModelRoutingActionValue = {
  channelId?: string;
  enterpriseId?: string;
  selectedTeamId?: string;
  source?: "app_home" | "channel" | "thread";
  teamId?: string;
  threadTs?: string;
};

const DEFAULT_AGENT_OPTION = {
  description: "General Slack assistant.",
  displayName: "Assistant",
  id: "assistant",
} as const;
const REASONING_EFFORT_FIELD = "reasoning_effort";
const AGENTS_PARTY_CONTROL_EVENT_TYPE = "agents_party_control";
const SLACK_SECTION_TEXT_LIMIT = 3000;
const THREAD_HISTORY_CONVERSATION_SUBTYPES = new Set([
  "bot_message",
  "file_share",
  "me_message",
  "thread_broadcast",
]);
const translationResultSchema = z
  .object({
    translatedText: z.string().trim().min(1),
  })
  .strict();
const TRANSLATION_RESULT_RESPONSE_FORMAT: Extract<LlmResponseFormat, { type: "json" }> = {
  jsonSchema: {
    additionalProperties: false,
    properties: {
      translatedText: {
        description: "The translated Slack message text.",
        type: "string",
      },
    },
    required: ["translatedText"],
    type: "object",
  },
  jsonSchemaDescription: "A Slack message translation result.",
  jsonSchemaName: "slack_message_translation",
  type: "json",
};
export type SlackAgentClient = Pick<
  SlackClient,
  "chat" | "conversations" | "filesUploadV2" | "token" | "users"
> & {
  assistant?: {
    threads?: {
      setStatus(input: {
        channel_id: string;
        loading_messages?: string[];
        status: string;
        thread_ts: string;
      }): Promise<unknown>;
    };
  };
};

type WorkspaceCredentialProviderSelection = CredentialProviderKind | "google_service_account_json";

const workspaceCredentialProviderOptions = [
  { label: "OpenAI", value: "openai" },
  { label: "Azure OpenAI", value: "azure_openai" },
  { label: "Anthropic", value: "anthropic" },
  { label: "Amazon Bedrock", value: "bedrock" },
  { label: "Baseten", value: "baseten" },
  { label: "Cerebras", value: "cerebras" },
  { label: "Cohere", value: "cohere" },
  { label: "DeepInfra", value: "deepinfra" },
  { label: "DeepSeek", value: "deepseek" },
  { label: "Fireworks", value: "fireworks" },
  { label: "Google", value: "google" },
  { label: "Google service account JSON", value: "google_service_account_json" },
  { label: "Google Maps", value: "google_maps" },
  { label: "Groq", value: "groq" },
  { label: "Mistral", value: "mistral" },
  { label: "Perplexity", value: "perplexity" },
  { label: "Together.ai", value: "togetherai" },
  { label: "xAI", value: "xai" },
  { label: "PLaMo", value: "plamo" },
  { label: "NVIDIA", value: "nvidia" },
  { label: "LiteLLM", value: "litellm" },
  { label: "SORACOM", value: "soracom" },
] as const satisfies readonly {
  label: string;
  value: WorkspaceCredentialProviderSelection;
}[];

export type SlackResolvedAgentRoute = {
  agent: JsonObject;
  agentId: string;
  modelFallback?: {
    fromModelId: string;
    fromScope: string;
    toModelId?: string;
    toScope?: string;
  };
  modelId?: string;
  modelScope?: string;
  reasoningEffort?: string;
  scope: string;
};

export type SlackAgentRoutingRepository = {
  activateThreadAgent(input: {
    agentId: string;
    channelId: string;
    lastMessageTs: string;
    modelId?: string;
    reasoningEffort?: string;
    rootMessageTs: string;
    teamId: string;
    threadTs: string;
  }): Promise<JsonObject>;
  findSlackThread(
    teamId: string,
    channelId: string,
    threadTs: string,
  ): Promise<JsonObject | undefined>;
  findChannelSettings?(teamId: string, channelId: string): Promise<JsonObject | undefined>;
  findWorkspaceSettings?(teamId: string): Promise<JsonObject | undefined>;
  isChannelEnabled(teamId: string, channelId: string): Promise<boolean>;
  isThreadAutoReplyEnabled(teamId: string, channelId: string): Promise<boolean>;
  resolveAgent?(input: {
    channelId: string;
    teamId: string;
    threadTs?: string;
  }): Promise<SlackResolvedAgentRoute | undefined>;
  saveWorkspaceSettings?(document: {
    defaultAgentId?: string;
    defaultModelId?: string;
    enabledModelIds?: string[];
    payload: JsonObject;
    reasoningEffort?: string;
    teamId: string;
    threadAutoReply?: boolean;
    updatedAt: Date;
  }): Promise<void>;
  saveChannelSettings?(document: {
    channelId: string;
    defaultAgentId?: string;
    defaultModelId?: string;
    payload: JsonObject;
    reasoningEffort?: string;
    teamId: string;
    threadAutoReply?: boolean;
    updatedAt: Date;
  }): Promise<void>;
  saveAgent?(document: {
    agentId: string;
    enabled: boolean;
    payload: JsonObject;
    updatedAt: Date;
  }): Promise<void>;
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

export type SalesforcePdfWorkflowRepository = {
  findSalesforcePdfWorkflowSetting(
    teamId: string,
    salesforceOrgId: string,
    action: string,
  ): Promise<JsonObject | undefined>;
  listSalesforcePdfWorkflowSettings(
    teamId: string,
    salesforceOrgId?: string,
  ): Promise<JsonObject[]>;
  saveSalesforcePdfWorkflowSetting(document: {
    action: string;
    enabled: boolean;
    payload: JsonObject;
    salesforceOrgId: string;
    teamId: string;
    templateId: string;
    updatedAt: Date;
  }): Promise<void>;
};

export type SalesforcePdfWorkflowHome = {
  repository: SalesforcePdfWorkflowRepository;
};

export type WorkspaceCredentialSettingsHome = {
  listActiveProviderKinds?(input: { teamId: string }): Promise<CredentialProviderKind[]>;
  saveProviderApiKey(input: {
    createdByUserId?: string;
    credentialName?: string;
    payload?: JsonObject;
    providerKind: CredentialProviderKind;
    secret: string;
    teamId: string;
  }): Promise<void>;
};

export type SlackInstalledWorkspaceDirectory = {
  listInstalledWorkspaces(input: { enterpriseId?: string }): Promise<SlackInstalledWorkspace[]>;
};

export type AgentSlackHandlerOptions = {
  agentJobQueue?: SlackAgentJobQueue;
  audioFetchFn?: typeof fetch;
  audioTranscriptionGateway?: TranscriptionGateway;
  defaultLocale?: Locale;
  installedWorkspaceDirectory?: SlackInstalledWorkspaceDirectory;
  routingRepository?: SlackAgentRoutingRepository;
  salesforceConnectionHome?: SalesforceConnectionHome;
  salesforcePdfWorkflowHome?: SalesforcePdfWorkflowHome;
  userSettingsRepository?: UserSettingsRepository;
  workspaceCredentialSettings?: WorkspaceCredentialSettingsHome;
};

type SlackAgentJobRetryContext = {
  attempts: number;
  attemptsMade: number;
};

type SlackUserSettingsScope = {
  enterpriseId?: string;
  teamId?: string;
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
      const appHomeContext = resolveSlackAppHomeContext({ body, event });
      const teamId = appHomeContext.sourceTeamId;
      logDebug(logger, "Resolved Slack App Home context.", {
        authorizationTeamId: appHomeContext.authorizationTeamId,
        enterpriseId: appHomeContext.enterpriseId,
        eventTeamId: appHomeContext.eventTeamId,
        isEnterpriseInstall: appHomeContext.isEnterpriseInstall,
        mode: appHomeContext.mode,
        sourceTeamId: appHomeContext.sourceTeamId,
        userTeamId: appHomeContext.userTeamId,
      });
      const enterpriseId = readSlackEnterpriseId(body);
      const translator = await resolveHandlerTranslator(
        { enterpriseId, teamId },
        event.user,
        options,
        logger,
      );
      const blocks = await buildAppHomeBlocks({
        logger,
        appHomeContext,
        options,
        slackUserId: event.user,
        teamId,
        translator,
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
    async handleModelRoutingConfigureAction(args) {
      await handleModelRoutingConfigureAction(args, options);
    },
    async handleModelRoutingDefaultModelSelectAction(args) {
      await handleModelRoutingDefaultModelSelectAction(args, options);
    },
    async handleModelRoutingModalSubmission(args) {
      await handleModelRoutingModalSubmission(args, options);
    },
    async handleWorkspaceCredentialProviderSelectAction(args) {
      await handleWorkspaceCredentialProviderSelectAction(args, options);
    },
    async handleWorkspaceCredentialModalSubmission(args) {
      await handleWorkspaceCredentialModalSubmission(args, options);
    },
    async handleSalesforcePdfWorkflowConfigureAction(args) {
      await handleSalesforcePdfWorkflowConfigureAction(args, options);
    },
    async handleSalesforcePdfWorkflowModalSubmission(args) {
      await handleSalesforcePdfWorkflowModalSubmission(args, options);
    },
  };
}

async function buildAppHomeBlocks(input: {
  appHomeContext: SlackAppHomeContext;
  logger: SlackEventArgs<"app_home_opened">["logger"];
  options: AgentSlackHandlerOptions;
  slackUserId: string;
  teamId: string | undefined;
  translator: Translator;
}): Promise<Record<string, unknown>[]> {
  const { translator } = input;
  const blocks: Record<string, unknown>[] = [
    {
      text: { text: translator.t("appHome.title"), type: "plain_text" },
      type: "header",
    },
    {
      text: {
        text: translator.t("appHome.intro"),
        type: "mrkdwn",
      },
      type: "section",
    },
  ];
  blocks.push(...(await buildModelRoutingAppHomeBlocks(input)));
  if (input.options.workspaceCredentialSettings !== undefined && input.teamId !== undefined) {
    blocks.push({ type: "divider" });
    blocks.push({
      text: { text: translator.t("appHome.apiKeys.title"), type: "plain_text" },
      type: "header",
    });
    blocks.push({
      accessory: {
        action_id: WORKSPACE_CREDENTIAL_CONFIGURE_ACTION_ID,
        text: { text: translator.t("appHome.configure"), type: "plain_text" },
        type: "button",
      },
      text: {
        text: translator.t("appHome.apiKeys.body"),
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
    const [rawConfigs, rawConnections, rawWorkflowSettings] = await Promise.all([
      repository.listSalesforceAuthConfigs(input.teamId),
      repository.listSalesforceConnections(input.teamId, input.slackUserId),
      input.options.salesforcePdfWorkflowHome?.repository.listSalesforcePdfWorkflowSettings(
        input.teamId,
      ) ?? Promise.resolve([]),
    ]);
    const configs = rawConfigs.map((config) => salesforceAuthConfigSchema.parse(config));
    const connections = rawConnections.map((connection) =>
      salesforceConnectionSchema.parse(connection),
    );
    const workflowSettings = rawWorkflowSettings
      .map((setting) => salesforcePdfWorkflowSettingsSchema.safeParse(setting))
      .filter((result) => result.success)
      .map((result) => result.data);
    if (configs.length === 0) {
      return blocks;
    }
    blocks.push({ type: "divider" });
    blocks.push({
      text: { text: translator.t("appHome.salesforce.title"), type: "plain_text" },
      type: "header",
    });
    for (const config of configs) {
      const connection = connections.find(
        (item) => item.salesforce_org_id === config.salesforce_org_id,
      );
      const status = connection?.connection_status ?? "not_connected";
      const actionLabel =
        status === "active"
          ? translator.t("appHome.salesforce.reconnect")
          : translator.t("appHome.salesforce.connect");
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
            translator,
          )}`,
          type: "mrkdwn",
        },
        type: "section",
      });
      if (input.options.salesforcePdfWorkflowHome !== undefined) {
        blocks.push(
          ...buildSalesforcePdfWorkflowBlocks(
            config.salesforce_org_id,
            workflowSettings,
            translator,
          ),
        );
      }
    }
  } catch (error) {
    input.logger.warn("Failed to load Salesforce App Home connection status.", { error });
  }
  return blocks;
}

async function buildModelRoutingAppHomeBlocks(input: {
  appHomeContext: SlackAppHomeContext;
  logger: SlackEventArgs<"app_home_opened">["logger"];
  options: AgentSlackHandlerOptions;
  translator: Translator;
}): Promise<Record<string, unknown>[]> {
  const { appHomeContext, translator } = input;
  const installedWorkspaces = await listAppHomeInstalledWorkspaces(input);
  const selectedTeamId =
    appHomeContext.mode === "enterprise_grid"
      ? installedWorkspaces[0]?.teamId
      : appHomeContext.sourceTeamId;
  return [
    { type: "divider" },
    {
      text: { text: translator.t("appHome.modelRouting.title"), type: "plain_text" },
      type: "header",
    },
    {
      accessory: {
        action_id: MODEL_ROUTING_CONFIGURE_ACTION_ID,
        text: { text: translator.t("appHome.configure"), type: "plain_text" },
        type: "button",
        value: JSON.stringify({
          enterpriseId: appHomeContext.enterpriseId,
          selectedTeamId,
          source: "app_home",
        }),
      },
      text: {
        text:
          appHomeContext.mode === "enterprise_grid"
            ? translator.t("appHome.modelRouting.bodyGrid", {
                count: installedWorkspaces.length,
              })
            : translator.t("appHome.modelRouting.body"),
        type: "mrkdwn",
      },
      type: "section",
    },
  ];
}

async function listAppHomeInstalledWorkspaces(input: {
  appHomeContext: SlackAppHomeContext;
  logger: SlackEventArgs<"app_home_opened">["logger"];
  options: AgentSlackHandlerOptions;
}): Promise<SlackInstalledWorkspace[]> {
  if (
    input.appHomeContext.mode !== "enterprise_grid" ||
    input.options.installedWorkspaceDirectory === undefined
  ) {
    return [];
  }
  try {
    return await input.options.installedWorkspaceDirectory.listInstalledWorkspaces({
      enterpriseId: input.appHomeContext.enterpriseId,
    });
  } catch (error) {
    input.logger.warn("Failed to list installed Slack workspaces for App Home.", {
      enterpriseId: input.appHomeContext.enterpriseId,
      error,
    });
    return [];
  }
}

async function handleModelRoutingConfigureAction(
  { ack, body, client, logger }: SlackActionArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  await ack();
  const actionValue = parseModelRoutingActionValue(readActionValue(body));
  const enterpriseId = actionValue?.enterpriseId ?? readSlackEnterpriseId(body);
  const bodyTeamId = readTeamId(body, {});
  const selectedTeamId =
    enterpriseId === undefined
      ? bodyTeamId
      : (actionValue?.selectedTeamId ?? actionValue?.teamId ?? bodyTeamId);
  const isChannelSettings = actionValue?.source === "channel";
  const isThreadSettings = actionValue?.source === "thread";
  const slackUserId = readSlackUserId(body);
  const triggerId = isRecord(body) ? readString(body, "trigger_id") : undefined;
  if (slackUserId === undefined || triggerId === undefined) {
    logger.warn("Ignoring model routing configuration action with missing Slack context.");
    return;
  }
  const ackTranslator = createTranslator(options.defaultLocale ?? FALLBACK_LOCALE);
  let openedView: unknown;
  try {
    const response = await client.views.open({
      trigger_id: triggerId,
      view: buildModelRoutingOpeningModal(
        ackTranslator,
        isThreadSettings
          ? ackTranslator.t("modelRouting.title.thread")
          : isChannelSettings
            ? ackTranslator.t("modelRouting.title.channel")
            : undefined,
      ) as never,
    });
    openedView = isRecord(response) ? response.view : undefined;
  } catch (error) {
    logger.warn("Failed to open model routing loading modal.", { error });
    return;
  }
  const translator = await resolveHandlerTranslator(
    { enterpriseId, teamId: selectedTeamId ?? bodyTeamId },
    slackUserId,
    options,
    logger,
  );
  const userContext = await resolveSlackUserContext(client, slackUserId, translator, logger);
  if (!userContext.isWorkspaceAdmin) {
    await updateModelRoutingModal(
      client,
      openedView,
      buildModelRoutingResultModal(
        userContext.translator.t("modelRouting.error.unauthorized"),
        userContext.translator,
      ),
      logger,
    );
    return;
  }

  if (isChannelSettings) {
    await updateChannelModelRoutingModal({
      actionValue,
      bodyTeamId,
      client,
      logger,
      openedView,
      options,
      translator: userContext.translator,
    });
    return;
  }

  if (isThreadSettings) {
    await updateThreadModelRoutingModal({
      actionValue,
      bodyTeamId,
      client,
      logger,
      openedView,
      options,
      translator: userContext.translator,
    });
    return;
  }

  let installedWorkspaces: SlackInstalledWorkspace[] = [];
  if (enterpriseId !== undefined && options.installedWorkspaceDirectory !== undefined) {
    try {
      installedWorkspaces = await options.installedWorkspaceDirectory.listInstalledWorkspaces({
        enterpriseId,
      });
    } catch (error) {
      logger.warn("Failed to list installed Slack workspaces for model routing modal.", {
        enterpriseId,
        error,
      });
    }
  }
  const effectiveTeamId =
    enterpriseId === undefined
      ? bodyTeamId
      : (selectedTeamId ?? installedWorkspaces[0]?.teamId ?? bodyTeamId);
  const workspaceSettings =
    effectiveTeamId === undefined
      ? undefined
      : await options.routingRepository?.findWorkspaceSettings?.(effectiveTeamId);
  const credentialedProviders =
    effectiveTeamId === undefined
      ? []
      : await listWorkspaceCredentialedLlmProviders(effectiveTeamId, options, logger);
  await updateModelRoutingModal(
    client,
    openedView,
    credentialedProviders.length === 0
      ? buildModelRoutingResultModal(
          userContext.translator.t("modelRouting.error.noCredentialedModels"),
          userContext.translator,
        )
      : buildModelRoutingModal({
          credentialedProviders,
          enterpriseId,
          selectedTeamId: effectiveTeamId,
          translator: userContext.translator,
          workspaceSettings,
          workspaces: installedWorkspaces,
        }),
    logger,
  );
}

async function updateChannelModelRoutingModal(input: {
  actionValue: ModelRoutingActionValue | undefined;
  bodyTeamId?: string;
  client: SlackClient;
  logger: unknown;
  openedView: unknown;
  options: AgentSlackHandlerOptions;
  translator: Translator;
}): Promise<void> {
  const selectedTeamId =
    input.actionValue?.teamId ?? input.actionValue?.selectedTeamId ?? input.bodyTeamId;
  const channelId = input.actionValue?.channelId;
  if (
    selectedTeamId === undefined ||
    channelId === undefined ||
    input.options.routingRepository?.findChannelSettings === undefined ||
    input.options.routingRepository.findWorkspaceSettings === undefined
  ) {
    await updateModelRoutingModal(
      input.client,
      input.openedView,
      buildModelRoutingResultModal(
        input.translator.t("modelRouting.error.notConfigured"),
        input.translator,
        input.translator.t("modelRouting.title.channel"),
      ),
      input.logger,
    );
    return;
  }

  const [channelSettings, workspaceSettings, credentialedProviders] = await Promise.all([
    input.options.routingRepository.findChannelSettings(selectedTeamId, channelId),
    input.options.routingRepository.findWorkspaceSettings(selectedTeamId),
    listWorkspaceCredentialedLlmProviders(selectedTeamId, input.options, input.logger),
  ]);
  const modelOptions = channelModelOptions({
    credentialedProviders,
    workspaceSettings,
  });
  if (modelOptions.length === 0) {
    await updateModelRoutingModal(
      input.client,
      input.openedView,
      buildModelRoutingResultModal(
        input.translator.t("modelRouting.error.noCredentialedModels"),
        input.translator,
        input.translator.t("modelRouting.title.channel"),
      ),
      input.logger,
    );
    return;
  }

  await updateModelRoutingModal(
    input.client,
    input.openedView,
    buildChannelModelRoutingModal({
      channelId,
      channelSettings,
      enterpriseId: input.actionValue?.enterpriseId,
      modelOptions,
      selectedTeamId,
      translator: input.translator,
      workspaceSettings,
    }),
    input.logger,
  );
}

async function updateThreadModelRoutingModal(input: {
  actionValue: ModelRoutingActionValue | undefined;
  bodyTeamId?: string;
  client: SlackClient;
  logger: unknown;
  openedView: unknown;
  options: AgentSlackHandlerOptions;
  translator: Translator;
}): Promise<void> {
  const selectedTeamId =
    input.actionValue?.teamId ?? input.actionValue?.selectedTeamId ?? input.bodyTeamId;
  const channelId = input.actionValue?.channelId;
  const threadTs = input.actionValue?.threadTs;
  if (
    selectedTeamId === undefined ||
    channelId === undefined ||
    threadTs === undefined ||
    input.options.routingRepository?.findSlackThread === undefined ||
    input.options.routingRepository.findWorkspaceSettings === undefined
  ) {
    await updateModelRoutingModal(
      input.client,
      input.openedView,
      buildModelRoutingResultModal(
        input.translator.t("modelRouting.error.notConfigured"),
        input.translator,
        input.translator.t("modelRouting.title.thread"),
      ),
      input.logger,
    );
    return;
  }

  const [threadSettings, channelSettings, workspaceSettings, credentialedProviders] =
    await Promise.all([
      input.options.routingRepository.findSlackThread(selectedTeamId, channelId, threadTs),
      input.options.routingRepository.findChannelSettings?.(selectedTeamId, channelId) ??
        Promise.resolve(undefined),
      input.options.routingRepository.findWorkspaceSettings(selectedTeamId),
      listWorkspaceCredentialedLlmProviders(selectedTeamId, input.options, input.logger),
    ]);
  const modelOptions = channelModelOptions({
    credentialedProviders,
    workspaceSettings,
  });
  if (modelOptions.length === 0) {
    await updateModelRoutingModal(
      input.client,
      input.openedView,
      buildModelRoutingResultModal(
        input.translator.t("modelRouting.error.noCredentialedModels"),
        input.translator,
        input.translator.t("modelRouting.title.thread"),
      ),
      input.logger,
    );
    return;
  }

  await updateModelRoutingModal(
    input.client,
    input.openedView,
    buildThreadModelRoutingModal({
      channelId,
      channelSettings,
      enterpriseId: input.actionValue?.enterpriseId,
      modelOptions,
      selectedTeamId,
      threadSettings,
      threadTs,
      translator: input.translator,
      workspaceSettings,
    }),
    input.logger,
  );
}

function buildModelRoutingModal(input: {
  credentialedProviders: readonly LlmProvider[];
  enterpriseId?: string;
  selectedTeamId?: string;
  translator: Translator;
  workspaceSettings?: JsonObject;
  workspaces: readonly SlackInstalledWorkspace[];
}): Record<string, unknown> {
  const workspaceOptions = input.workspaces.map((workspace) => ({
    text: {
      text: workspace.teamName ?? workspace.teamId,
      type: "plain_text",
    },
    value: workspace.teamId,
  }));
  const selectedOption = workspaceOptions.find((option) => option.value === input.selectedTeamId);
  const blocks: Record<string, unknown>[] = [
    {
      text: {
        text: input.translator.t("modelRouting.modal.intro"),
        type: "mrkdwn",
      },
      type: "section",
    },
  ];
  if (workspaceOptions.length > 0) {
    blocks.push({
      block_id: MODEL_ROUTING_WORKSPACE_SELECT_ACTION_ID,
      element: {
        action_id: MODEL_ROUTING_WORKSPACE_SELECT_ACTION_ID,
        initial_option: selectedOption,
        options: workspaceOptions.slice(0, 100),
        placeholder: {
          text: input.translator.t("modelRouting.modal.workspacePlaceholder"),
          type: "plain_text",
        },
        type: "static_select",
      },
      label: {
        text: input.translator.t("modelRouting.modal.workspace"),
        type: "plain_text",
      },
      optional: false,
      type: "input",
    });
  }
  const modelOptions = createDefaultModelRegistry()
    .list()
    .filter(
      (model) =>
        model.capabilities.includes("text") && input.credentialedProviders.includes(model.provider),
    )
    .map((model) => ({
      text: {
        text: model.displayName ?? model.id,
        type: "plain_text" as const,
      },
      value: model.id,
    }))
    .slice(0, 100);
  const enabledModelIds = stringArrayField(input.workspaceSettings, "enabled_model_ids");
  const enabledInitialOptions = modelOptions.filter((option) =>
    enabledModelIds.includes(option.value),
  );
  const defaultModelId = stringField(input.workspaceSettings, "default_model_id");
  const defaultInitialOption = modelOptions.find((option) => option.value === defaultModelId);
  const shouldShowReasoningEffort = modelSupportsReasoningSettings(defaultModelId);
  blocks.push(
    {
      block_id: MODEL_ROUTING_ENABLED_MODELS_BLOCK_ID,
      element: {
        action_id: MODEL_ROUTING_ENABLED_MODELS_ACTION_ID,
        initial_options: enabledInitialOptions,
        options: modelOptions,
        placeholder: {
          text: input.translator.t("modelRouting.modal.enabledModelsPlaceholder"),
          type: "plain_text",
        },
        type: "multi_static_select",
      },
      label: {
        text: input.translator.t("modelRouting.modal.enabledModels"),
        type: "plain_text",
      },
      optional: false,
      type: "input",
    },
    {
      block_id: MODEL_ROUTING_DEFAULT_MODEL_BLOCK_ID,
      dispatch_action: true,
      element: {
        action_id: MODEL_ROUTING_DEFAULT_MODEL_ACTION_ID,
        initial_option: defaultInitialOption,
        options: modelOptions,
        placeholder: {
          text: input.translator.t("modelRouting.modal.defaultModelPlaceholder"),
          type: "plain_text",
        },
        type: "static_select",
      },
      label: {
        text: input.translator.t("modelRouting.modal.defaultModel"),
        type: "plain_text",
      },
      optional: false,
      type: "input",
    },
  );
  if (shouldShowReasoningEffort) {
    blocks.push(
      buildReasoningEffortBlock({
        initialEffort: selectedReasoningEffort(input.workspaceSettings, defaultModelId),
        modelId: defaultModelId,
        translator: input.translator,
      }),
    );
  }
  return {
    blocks,
    callback_id: MODEL_ROUTING_MODAL_CALLBACK_ID,
    close: { text: input.translator.t("common.close"), type: "plain_text" },
    private_metadata: JSON.stringify({
      enterpriseId: input.enterpriseId,
      selectedTeamId: input.selectedTeamId,
      source: "app_home",
    }),
    submit: { text: input.translator.t("common.save"), type: "plain_text" },
    title: { text: input.translator.t("modelRouting.title"), type: "plain_text" },
    type: "modal",
  };
}

function buildChannelModelRoutingModal(input: {
  channelId: string;
  channelSettings?: JsonObject;
  enterpriseId?: string;
  modelOptions: readonly SlackOption[];
  selectedTeamId: string;
  translator: Translator;
  workspaceSettings?: JsonObject;
}): Record<string, unknown> {
  const defaultModelId =
    stringField(input.channelSettings, "default_model_id") ??
    stringField(input.workspaceSettings, "default_model_id");
  const blocks: Record<string, unknown>[] = [
    {
      text: {
        text: input.translator.t("modelRouting.channelModal.intro"),
        type: "mrkdwn",
      },
      type: "section",
    },
    {
      block_id: MODEL_ROUTING_DEFAULT_MODEL_BLOCK_ID,
      dispatch_action: true,
      element: {
        action_id: MODEL_ROUTING_DEFAULT_MODEL_ACTION_ID,
        initial_option: input.modelOptions.find((option) => option.value === defaultModelId),
        options: input.modelOptions,
        placeholder: {
          text: input.translator.t("modelRouting.modal.defaultModelPlaceholder"),
          type: "plain_text",
        },
        type: "static_select",
      },
      label: {
        text: input.translator.t("modelRouting.channelModal.defaultModel"),
        type: "plain_text",
      },
      optional: false,
      type: "input",
    },
  ];
  if (modelSupportsReasoningSettings(defaultModelId)) {
    blocks.push(
      buildReasoningEffortBlock({
        initialEffort: selectedReasoningEffortFromSettings(
          [input.channelSettings, input.workspaceSettings],
          defaultModelId,
        ),
        modelId: defaultModelId,
        translator: input.translator,
      }),
    );
  }
  return {
    blocks,
    callback_id: MODEL_ROUTING_MODAL_CALLBACK_ID,
    close: { text: input.translator.t("common.close"), type: "plain_text" },
    private_metadata: JSON.stringify({
      channelId: input.channelId,
      enterpriseId: input.enterpriseId,
      source: "channel",
      teamId: input.selectedTeamId,
    }),
    submit: { text: input.translator.t("common.save"), type: "plain_text" },
    title: { text: input.translator.t("modelRouting.title.channel"), type: "plain_text" },
    type: "modal",
  };
}

function buildThreadModelRoutingModal(input: {
  channelId: string;
  channelSettings?: JsonObject;
  enterpriseId?: string;
  modelOptions: readonly SlackOption[];
  selectedTeamId: string;
  threadSettings?: JsonObject;
  threadTs: string;
  translator: Translator;
  workspaceSettings?: JsonObject;
}): Record<string, unknown> {
  const threadModelId =
    stringField(input.threadSettings, "model_scope") === "thread"
      ? stringField(input.threadSettings, "model_id")
      : undefined;
  const defaultModelId =
    threadModelId ??
    stringField(input.channelSettings, "default_model_id") ??
    stringField(input.workspaceSettings, "default_model_id");
  const blocks: Record<string, unknown>[] = [
    {
      text: {
        text: input.translator.t("modelRouting.threadModal.intro"),
        type: "mrkdwn",
      },
      type: "section",
    },
    {
      block_id: MODEL_ROUTING_DEFAULT_MODEL_BLOCK_ID,
      dispatch_action: true,
      element: {
        action_id: MODEL_ROUTING_DEFAULT_MODEL_ACTION_ID,
        initial_option: input.modelOptions.find((option) => option.value === defaultModelId),
        options: input.modelOptions,
        placeholder: {
          text: input.translator.t("modelRouting.modal.defaultModelPlaceholder"),
          type: "plain_text",
        },
        type: "static_select",
      },
      label: {
        text: input.translator.t("modelRouting.threadModal.defaultModel"),
        type: "plain_text",
      },
      optional: false,
      type: "input",
    },
  ];
  if (modelSupportsReasoningSettings(defaultModelId)) {
    blocks.push(
      buildReasoningEffortBlock({
        initialEffort: selectedReasoningEffortFromSettings(
          [input.threadSettings, input.channelSettings, input.workspaceSettings],
          defaultModelId,
        ),
        modelId: defaultModelId,
        translator: input.translator,
      }),
    );
  }
  return {
    blocks,
    callback_id: MODEL_ROUTING_MODAL_CALLBACK_ID,
    close: { text: input.translator.t("common.close"), type: "plain_text" },
    private_metadata: JSON.stringify({
      channelId: input.channelId,
      enterpriseId: input.enterpriseId,
      source: "thread",
      teamId: input.selectedTeamId,
      threadTs: input.threadTs,
    }),
    submit: { text: input.translator.t("common.save"), type: "plain_text" },
    title: { text: input.translator.t("modelRouting.title.thread"), type: "plain_text" },
    type: "modal",
  };
}

async function handleModelRoutingModalSubmission(
  { ack, body, client, logger, view }: SlackViewArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  const metadata = parseModelRoutingActionValue(
    readString(view as unknown as StringIndexed, "private_metadata"),
  );
  const bodyTeamId = readTeamId(body, {});
  const enterpriseId = metadata?.enterpriseId ?? readSlackEnterpriseId(body);
  const selectedTeamId =
    enterpriseId === undefined
      ? bodyTeamId
      : (readSelectedOptionValue(
          view,
          MODEL_ROUTING_WORKSPACE_SELECT_ACTION_ID,
          MODEL_ROUTING_WORKSPACE_SELECT_ACTION_ID,
        ) ??
        metadata?.selectedTeamId ??
        bodyTeamId);
  const translator = createTranslator(options.defaultLocale ?? FALLBACK_LOCALE);
  const slackUserId = readSlackUserId(body);
  if (metadata?.source === "channel") {
    await handleChannelModelRoutingModalSubmission({
      ack,
      body,
      client,
      logger,
      metadata,
      options,
      slackUserId,
      translator,
      view,
    });
    return;
  }
  if (metadata?.source === "thread") {
    await handleThreadModelRoutingModalSubmission({
      ack,
      body,
      client,
      logger,
      metadata,
      options,
      slackUserId,
      translator,
      view,
    });
    return;
  }
  if (
    selectedTeamId === undefined ||
    slackUserId === undefined ||
    options.routingRepository?.saveWorkspaceSettings === undefined ||
    options.routingRepository.findWorkspaceSettings === undefined
  ) {
    await ack({
      errors: {
        [MODEL_ROUTING_DEFAULT_MODEL_BLOCK_ID]: translator.t("modelRouting.error.notConfigured"),
      },
      response_action: "errors",
    });
    return;
  }
  const enabledModelIds = readSelectedOptionValues(
    view,
    MODEL_ROUTING_ENABLED_MODELS_BLOCK_ID,
    MODEL_ROUTING_ENABLED_MODELS_ACTION_ID,
  );
  const defaultModelId = readSelectedOptionValue(
    view,
    MODEL_ROUTING_DEFAULT_MODEL_BLOCK_ID,
    MODEL_ROUTING_DEFAULT_MODEL_ACTION_ID,
  );
  const reasoningEffort = readReasoningEffortValue(view, defaultModelId);
  const modelRegistry = createDefaultModelRegistry();
  const unknownModelIds = [...enabledModelIds, defaultModelId].filter(
    (modelId): modelId is string => modelId !== undefined && !modelRegistry.has(modelId),
  );
  const credentialedProviders = await listWorkspaceCredentialedLlmProviders(
    selectedTeamId,
    options,
    logger,
  );
  const uncredentialedModelIds = [...enabledModelIds, defaultModelId].filter(
    (modelId): modelId is string => {
      if (modelId === undefined || !modelRegistry.has(modelId)) {
        return false;
      }
      return !credentialedProviders.includes(modelRegistry.get(modelId).provider);
    },
  );
  if (enabledModelIds.length === 0 || defaultModelId === undefined) {
    await ack({
      errors: {
        [MODEL_ROUTING_ENABLED_MODELS_BLOCK_ID]: translator.t(
          "modelRouting.error.enabledModelsRequired",
        ),
      },
      response_action: "errors",
    });
    return;
  }
  if (
    unknownModelIds.length > 0 ||
    uncredentialedModelIds.length > 0 ||
    !enabledModelIds.includes(defaultModelId)
  ) {
    await ack({
      errors: {
        [MODEL_ROUTING_DEFAULT_MODEL_BLOCK_ID]: translator.t(
          "modelRouting.error.defaultNotEnabled",
        ),
      },
      response_action: "errors",
    });
    return;
  }
  await ack({
    response_action: "update",
    view: buildModelRoutingResultModal(
      translator.t("modelRouting.result.saving"),
      translator,
    ) as never,
  });
  const userContext = await resolveSlackUserContext(client, slackUserId, translator, logger);
  if (!userContext.isWorkspaceAdmin) {
    await updateModelRoutingModal(
      client,
      view,
      buildModelRoutingResultModal(
        userContext.translator.t("modelRouting.error.unauthorized"),
        userContext.translator,
      ),
      logger,
    );
    return;
  }
  const isSelectedWorkspaceAllowed = await canManageSelectedModelRoutingWorkspace(
    {
      enterpriseId,
      installedWorkspaceDirectory: options.installedWorkspaceDirectory,
      selectedTeamId,
      sourceTeamId: bodyTeamId,
    },
    logger,
  );
  if (!isSelectedWorkspaceAllowed) {
    await updateModelRoutingModal(
      client,
      view,
      buildModelRoutingResultModal(
        userContext.translator.t("modelRouting.error.unauthorized"),
        userContext.translator,
      ),
      logger,
    );
    return;
  }
  try {
    const existing = await options.routingRepository.findWorkspaceSettings(selectedTeamId);
    const defaultAgentId = stringField(existing, "default_agent_id") ?? DEFAULT_AGENT_OPTION.id;
    if (defaultAgentId === DEFAULT_AGENT_OPTION.id) {
      await options.routingRepository.saveAgent?.({
        agentId: DEFAULT_AGENT_OPTION.id,
        enabled: true,
        payload: {
          agent_id: DEFAULT_AGENT_OPTION.id,
          description: DEFAULT_AGENT_OPTION.description,
          name: DEFAULT_AGENT_OPTION.displayName,
        },
        updatedAt: new Date(),
      });
    }
    await options.routingRepository.saveWorkspaceSettings({
      defaultAgentId,
      defaultModelId,
      enabledModelIds,
      payload: existing ?? {},
      reasoningEffort,
      teamId: selectedTeamId,
      threadAutoReply: booleanField(existing, "thread_auto_reply"),
      updatedAt: new Date(),
    });
    logInfo(logger, "Saved workspace model routing settings.", {
      defaultAgentId,
      defaultModelId,
      enabledModelCount: enabledModelIds.length,
      enterpriseId,
      teamId: selectedTeamId,
    });
    await updateModelRoutingModal(
      client,
      view,
      buildModelRoutingResultModal(
        userContext.translator.t("modelRouting.result.saved"),
        userContext.translator,
      ),
      logger,
    );
  } catch (error) {
    logger.error("Failed to save workspace model routing settings.", {
      error,
      enterpriseId,
      teamId: selectedTeamId,
    });
    await updateModelRoutingModal(
      client,
      view,
      buildModelRoutingResultModal(
        userContext.translator.t("modelRouting.error.saveFailed"),
        userContext.translator,
      ),
      logger,
    );
  }
}

async function canManageSelectedModelRoutingWorkspace(
  input: {
    enterpriseId?: string;
    installedWorkspaceDirectory?: SlackInstalledWorkspaceDirectory;
    selectedTeamId: string;
    sourceTeamId?: string;
  },
  logger: unknown,
): Promise<boolean> {
  if (input.selectedTeamId === input.sourceTeamId) {
    return true;
  }
  if (input.enterpriseId === undefined) {
    return false;
  }
  if (input.installedWorkspaceDirectory === undefined) {
    return false;
  }
  try {
    const installedWorkspaces = await input.installedWorkspaceDirectory.listInstalledWorkspaces({
      enterpriseId: input.enterpriseId,
    });
    return installedWorkspaces.some((workspace) => workspace.teamId === input.selectedTeamId);
  } catch (error) {
    logWarn(logger, "Failed to verify selected workspace for model routing settings.", {
      enterpriseId: input.enterpriseId,
      error,
      selectedTeamId: input.selectedTeamId,
    });
    return false;
  }
}

async function handleChannelModelRoutingModalSubmission(input: {
  ack: SlackViewArgs["ack"];
  body: SlackViewArgs["body"];
  client: SlackViewArgs["client"];
  logger: SlackViewArgs["logger"];
  metadata: ModelRoutingActionValue;
  options: AgentSlackHandlerOptions;
  slackUserId?: string;
  translator: Translator;
  view: SlackViewArgs["view"];
}): Promise<void> {
  const selectedTeamId =
    input.metadata.teamId ?? input.metadata.selectedTeamId ?? readTeamId(input.body, {});
  const channelId = input.metadata.channelId;
  if (
    selectedTeamId === undefined ||
    channelId === undefined ||
    input.slackUserId === undefined ||
    input.options.routingRepository?.saveChannelSettings === undefined ||
    input.options.routingRepository.findChannelSettings === undefined ||
    input.options.routingRepository.findWorkspaceSettings === undefined
  ) {
    await input.ack({
      errors: {
        [MODEL_ROUTING_DEFAULT_MODEL_BLOCK_ID]: input.translator.t(
          "modelRouting.error.notConfigured",
        ),
      },
      response_action: "errors",
    });
    return;
  }

  const defaultModelId = readSelectedOptionValue(
    input.view,
    MODEL_ROUTING_DEFAULT_MODEL_BLOCK_ID,
    MODEL_ROUTING_DEFAULT_MODEL_ACTION_ID,
  );
  const reasoningEffort = readReasoningEffortValue(input.view, defaultModelId);
  const [channelSettings, workspaceSettings, credentialedProviders] = await Promise.all([
    input.options.routingRepository.findChannelSettings(selectedTeamId, channelId),
    input.options.routingRepository.findWorkspaceSettings(selectedTeamId),
    listWorkspaceCredentialedLlmProviders(selectedTeamId, input.options, input.logger),
  ]);
  const availableModelIds = new Set(
    channelModelOptions({
      credentialedProviders,
      workspaceSettings,
    }).map((option) => option.value),
  );
  if (defaultModelId === undefined || !availableModelIds.has(defaultModelId)) {
    await input.ack({
      errors: {
        [MODEL_ROUTING_DEFAULT_MODEL_BLOCK_ID]: input.translator.t(
          "modelRouting.error.channelModelRequired",
        ),
      },
      response_action: "errors",
    });
    return;
  }

  await input.ack({
    response_action: "update",
    view: buildModelRoutingResultModal(
      input.translator.t("modelRouting.result.saving"),
      input.translator,
      input.translator.t("modelRouting.title.channel"),
    ) as never,
  });
  const userContext = await resolveSlackUserContext(
    input.client,
    input.slackUserId,
    input.translator,
    input.logger,
  );
  if (!userContext.isWorkspaceAdmin) {
    await updateModelRoutingModal(
      input.client,
      input.view,
      buildModelRoutingResultModal(
        userContext.translator.t("modelRouting.error.unauthorized"),
        userContext.translator,
        userContext.translator.t("modelRouting.title.channel"),
      ),
      input.logger,
    );
    return;
  }

  try {
    const defaultAgentId =
      stringField(channelSettings, "default_agent_id") ??
      stringField(workspaceSettings, "default_agent_id") ??
      DEFAULT_AGENT_OPTION.id;
    if (defaultAgentId === DEFAULT_AGENT_OPTION.id) {
      await input.options.routingRepository.saveAgent?.({
        agentId: DEFAULT_AGENT_OPTION.id,
        enabled: true,
        payload: {
          agent_id: DEFAULT_AGENT_OPTION.id,
          description: DEFAULT_AGENT_OPTION.description,
          name: DEFAULT_AGENT_OPTION.displayName,
        },
        updatedAt: new Date(),
      });
    }
    await input.options.routingRepository.saveChannelSettings({
      channelId,
      defaultAgentId,
      defaultModelId: modelIdForScopedSave({
        inheritedSettings: [workspaceSettings],
        selectedModelId: defaultModelId,
      }),
      payload: channelSettings ?? {},
      reasoningEffort: reasoningEffortForScopedSave({
        currentSettings: channelSettings,
        inheritedSettings: [workspaceSettings],
        modelId: defaultModelId,
        selectedEffort: reasoningEffort,
      }),
      teamId: selectedTeamId,
      threadAutoReply: booleanField(channelSettings, "thread_auto_reply"),
      updatedAt: new Date(),
    });
    logInfo(input.logger, "Saved channel model routing settings.", {
      channelId,
      defaultAgentId,
      defaultModelId,
      enterpriseId: input.metadata.enterpriseId,
      teamId: selectedTeamId,
    });
    await updateModelRoutingModal(
      input.client,
      input.view,
      buildModelRoutingResultModal(
        userContext.translator.t("modelRouting.result.channelSaved"),
        userContext.translator,
        userContext.translator.t("modelRouting.title.channel"),
      ),
      input.logger,
    );
  } catch (error) {
    input.logger.error("Failed to save channel model routing settings.", {
      channelId,
      error,
      enterpriseId: input.metadata.enterpriseId,
      teamId: selectedTeamId,
    });
    await updateModelRoutingModal(
      input.client,
      input.view,
      buildModelRoutingResultModal(
        userContext.translator.t("modelRouting.error.saveFailed"),
        userContext.translator,
        userContext.translator.t("modelRouting.title.channel"),
      ),
      input.logger,
    );
  }
}

async function handleThreadModelRoutingModalSubmission(input: {
  ack: SlackViewArgs["ack"];
  body: SlackViewArgs["body"];
  client: SlackViewArgs["client"];
  logger: SlackViewArgs["logger"];
  metadata: ModelRoutingActionValue;
  options: AgentSlackHandlerOptions;
  slackUserId?: string;
  translator: Translator;
  view: SlackViewArgs["view"];
}): Promise<void> {
  const selectedTeamId =
    input.metadata.teamId ?? input.metadata.selectedTeamId ?? readTeamId(input.body, {});
  const channelId = input.metadata.channelId;
  const threadTs = input.metadata.threadTs;
  if (
    selectedTeamId === undefined ||
    channelId === undefined ||
    threadTs === undefined ||
    input.slackUserId === undefined ||
    input.options.routingRepository?.activateThreadAgent === undefined ||
    input.options.routingRepository.findSlackThread === undefined ||
    input.options.routingRepository.findWorkspaceSettings === undefined
  ) {
    await input.ack({
      errors: {
        [MODEL_ROUTING_DEFAULT_MODEL_BLOCK_ID]: input.translator.t(
          "modelRouting.error.notConfigured",
        ),
      },
      response_action: "errors",
    });
    return;
  }

  const defaultModelId = readSelectedOptionValue(
    input.view,
    MODEL_ROUTING_DEFAULT_MODEL_BLOCK_ID,
    MODEL_ROUTING_DEFAULT_MODEL_ACTION_ID,
  );
  const reasoningEffort = readReasoningEffortValue(input.view, defaultModelId);
  const [threadSettings, channelSettings, workspaceSettings, credentialedProviders] =
    await Promise.all([
      input.options.routingRepository.findSlackThread(selectedTeamId, channelId, threadTs),
      input.options.routingRepository.findChannelSettings?.(selectedTeamId, channelId) ??
        Promise.resolve(undefined),
      input.options.routingRepository.findWorkspaceSettings(selectedTeamId),
      listWorkspaceCredentialedLlmProviders(selectedTeamId, input.options, input.logger),
    ]);
  const availableModelIds = new Set(
    channelModelOptions({
      credentialedProviders,
      workspaceSettings,
    }).map((option) => option.value),
  );
  if (defaultModelId === undefined || !availableModelIds.has(defaultModelId)) {
    await input.ack({
      errors: {
        [MODEL_ROUTING_DEFAULT_MODEL_BLOCK_ID]: input.translator.t(
          "modelRouting.error.threadModelRequired",
        ),
      },
      response_action: "errors",
    });
    return;
  }

  await input.ack({
    response_action: "update",
    view: buildModelRoutingResultModal(
      input.translator.t("modelRouting.result.saving"),
      input.translator,
      input.translator.t("modelRouting.title.thread"),
    ) as never,
  });
  const userContext = await resolveSlackUserContext(
    input.client,
    input.slackUserId,
    input.translator,
    input.logger,
  );
  if (!userContext.isWorkspaceAdmin) {
    await updateModelRoutingModal(
      input.client,
      input.view,
      buildModelRoutingResultModal(
        userContext.translator.t("modelRouting.error.unauthorized"),
        userContext.translator,
        userContext.translator.t("modelRouting.title.thread"),
      ),
      input.logger,
    );
    return;
  }

  try {
    const defaultAgentId =
      stringField(threadSettings, "agent_id") ??
      stringField(channelSettings, "default_agent_id") ??
      stringField(workspaceSettings, "default_agent_id") ??
      DEFAULT_AGENT_OPTION.id;
    if (defaultAgentId === DEFAULT_AGENT_OPTION.id) {
      await input.options.routingRepository.saveAgent?.({
        agentId: DEFAULT_AGENT_OPTION.id,
        enabled: true,
        payload: {
          agent_id: DEFAULT_AGENT_OPTION.id,
          description: DEFAULT_AGENT_OPTION.description,
          name: DEFAULT_AGENT_OPTION.displayName,
        },
        updatedAt: new Date(),
      });
    }
    await input.options.routingRepository.activateThreadAgent({
      agentId: defaultAgentId,
      channelId,
      lastMessageTs: stringField(threadSettings, "last_message_ts") ?? threadTs,
      modelId: modelIdForScopedSave({
        inheritedSettings: [channelSettings, workspaceSettings],
        selectedModelId: defaultModelId,
      }),
      reasoningEffort: reasoningEffortForScopedSave({
        currentSettings: threadSettings,
        inheritedSettings: [channelSettings, workspaceSettings],
        modelId: defaultModelId,
        selectedEffort: reasoningEffort,
      }),
      rootMessageTs: stringField(threadSettings, "root_message_ts") ?? threadTs,
      teamId: selectedTeamId,
      threadTs,
    });
    logInfo(input.logger, "Saved thread model routing settings.", {
      channelId,
      defaultAgentId,
      defaultModelId,
      enterpriseId: input.metadata.enterpriseId,
      teamId: selectedTeamId,
      threadTs,
    });
    await updateModelRoutingModal(
      input.client,
      input.view,
      buildModelRoutingResultModal(
        userContext.translator.t("modelRouting.result.threadSaved"),
        userContext.translator,
        userContext.translator.t("modelRouting.title.thread"),
      ),
      input.logger,
    );
  } catch (error) {
    input.logger.error("Failed to save thread model routing settings.", {
      channelId,
      error,
      enterpriseId: input.metadata.enterpriseId,
      teamId: selectedTeamId,
      threadTs,
    });
    await updateModelRoutingModal(
      input.client,
      input.view,
      buildModelRoutingResultModal(
        userContext.translator.t("modelRouting.error.saveFailed"),
        userContext.translator,
        userContext.translator.t("modelRouting.title.thread"),
      ),
      input.logger,
    );
  }
}

async function handleModelRoutingDefaultModelSelectAction(
  { ack, body, client, logger }: SlackActionArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  await ack();
  const view = isRecord(body) ? body.view : undefined;
  if (!isRecord(view) || readString(view, "callback_id") !== MODEL_ROUTING_MODAL_CALLBACK_ID) {
    return;
  }
  const viewRecord = view;

  const metadata = parseModelRoutingActionValue(readString(viewRecord, "private_metadata"));
  const bodyTeamId = readTeamId(body, {});
  const selectedTeamId =
    readSelectedOptionValue(
      viewRecord,
      MODEL_ROUTING_WORKSPACE_SELECT_ACTION_ID,
      MODEL_ROUTING_WORKSPACE_SELECT_ACTION_ID,
    ) ??
    metadata?.selectedTeamId ??
    metadata?.teamId ??
    bodyTeamId;
  const translator = await resolveHandlerTranslator(
    {
      enterpriseId: metadata?.enterpriseId ?? readSlackEnterpriseId(body),
      teamId: selectedTeamId,
    },
    readSlackUserId(body),
    options,
    logger,
  );
  const defaultModelId = readSelectedOptionValue(
    viewRecord,
    MODEL_ROUTING_DEFAULT_MODEL_BLOCK_ID,
    MODEL_ROUTING_DEFAULT_MODEL_ACTION_ID,
  );
  const blocks = modelRoutingBlocksForSelectedDefaultModel({
    defaultModelId,
    translator,
    view: viewRecord,
  });
  await updateModelRoutingModal(
    client,
    viewRecord,
    modalWithUpdatedBlocks(viewRecord, blocks),
    logger,
    { useHash: true },
  );
}

async function listWorkspaceCredentialedLlmProviders(
  teamId: string,
  options: AgentSlackHandlerOptions,
  logger: unknown,
): Promise<LlmProvider[]> {
  if (options.workspaceCredentialSettings?.listActiveProviderKinds === undefined) {
    return [];
  }
  try {
    const providerKinds = await options.workspaceCredentialSettings.listActiveProviderKinds({
      teamId,
    });
    return providerKinds.filter((providerKind): providerKind is LlmProvider =>
      llmProviders.includes(providerKind as LlmProvider),
    );
  } catch (error) {
    logWarn(logger, "Failed to list active workspace credential providers.", {
      error,
      teamId,
    });
    return [];
  }
}

function channelModelOptions(input: {
  credentialedProviders: readonly LlmProvider[];
  workspaceSettings?: JsonObject;
}): SlackOption[] {
  const registry = createDefaultModelRegistry();
  const workspaceEnabledModelIds = stringArrayField(input.workspaceSettings, "enabled_model_ids");
  const workspaceEnabledModelIdSet = new Set(workspaceEnabledModelIds);
  return registry
    .list()
    .filter((model) => {
      if (!model.capabilities.includes("text")) {
        return false;
      }
      if (workspaceEnabledModelIdSet.size > 0) {
        return workspaceEnabledModelIdSet.has(model.id);
      }
      return input.credentialedProviders.includes(model.provider);
    })
    .map((model) => ({
      text: {
        text: model.displayName ?? model.id,
        type: "plain_text" as const,
      },
      value: model.id,
    }))
    .slice(0, 100);
}

function reasoningEffortOptions(input: {
  modelId?: string;
  translator: Translator;
}): SlackOption[] {
  const allOptions: SlackOption[] = [
    {
      text: {
        text: input.translator.t("modelRouting.reasoning.providerDefault"),
        type: "plain_text",
      },
      value: LlmReasoningEffortId.ProviderDefault,
    },
    {
      text: { text: input.translator.t("modelRouting.reasoning.none"), type: "plain_text" },
      value: LlmReasoningEffortId.None,
    },
    {
      text: { text: input.translator.t("modelRouting.reasoning.minimal"), type: "plain_text" },
      value: LlmReasoningEffortId.Minimal,
    },
    {
      text: { text: input.translator.t("modelRouting.reasoning.low"), type: "plain_text" },
      value: LlmReasoningEffortId.Low,
    },
    {
      text: { text: input.translator.t("modelRouting.reasoning.medium"), type: "plain_text" },
      value: LlmReasoningEffortId.Medium,
    },
    {
      text: { text: input.translator.t("modelRouting.reasoning.high"), type: "plain_text" },
      value: LlmReasoningEffortId.High,
    },
    {
      text: { text: input.translator.t("modelRouting.reasoning.xhigh"), type: "plain_text" },
      value: LlmReasoningEffortId.XHigh,
    },
  ];
  const supportedEfforts = supportedReasoningEfforts(input.modelId);
  return allOptions.filter((option) => {
    const effort = normalizeReasoningEffort(option.value);
    return (
      effort === LlmReasoningEffortId.ProviderDefault ||
      (effort !== undefined && supportedEfforts.has(effort))
    );
  });
}

function modelSupportsReasoningSettings(modelId: string | undefined): boolean {
  return supportedReasoningEfforts(modelId).size > 0;
}

function supportedReasoningEfforts(modelId: string | undefined): ReadonlySet<LlmReasoningEffort> {
  const registry = createDefaultModelRegistry();
  if (modelId === undefined || !registry.has(modelId)) {
    return new Set();
  }
  return new Set(supportedReasoningEffortsForModel(registry.get(modelId)));
}

function selectedReasoningEffort(
  settings: JsonObject | undefined,
  modelId: string | undefined,
): LlmReasoningEffort {
  return selectedReasoningEffortFromSettings([settings], modelId);
}

function selectedReasoningEffortFromSettings(
  settingsList: readonly (JsonObject | undefined)[],
  modelId: string | undefined,
): LlmReasoningEffort {
  const configured = settingsList
    .map((settings) => normalizeReasoningEffort(stringField(settings, REASONING_EFFORT_FIELD)))
    .find((effort): effort is LlmReasoningEffort => effort !== undefined);
  if (configured !== undefined) {
    return configured;
  }
  if (modelId !== undefined) {
    const registry = createDefaultModelRegistry();
    if (registry.has(modelId)) {
      return (
        modelDefaultReasoningEffort(registry.get(modelId)) ?? LlmReasoningEffortId.ProviderDefault
      );
    }
  }
  return LlmReasoningEffortId.ProviderDefault;
}

function reasoningEffortForScopedSave(input: {
  inheritedSettings: readonly (JsonObject | undefined)[];
  modelId: string;
  currentSettings?: JsonObject;
  selectedEffort?: LlmReasoningEffort;
}): LlmReasoningEffort | undefined {
  if (input.selectedEffort === undefined) {
    return undefined;
  }
  const currentEffort = normalizeReasoningEffort(
    stringField(input.currentSettings, REASONING_EFFORT_FIELD),
  );
  const inheritedEffort = selectedReasoningEffortFromSettings(
    input.inheritedSettings,
    input.modelId,
  );
  if (currentEffort !== undefined && input.selectedEffort !== inheritedEffort) {
    return input.selectedEffort;
  }
  return input.selectedEffort === inheritedEffort ? undefined : input.selectedEffort;
}

function modelIdForScopedSave(input: {
  inheritedSettings: readonly (JsonObject | undefined)[];
  selectedModelId: string;
}): string | undefined {
  const inheritedModelId = input.inheritedSettings
    .map((settings) => stringField(settings, "default_model_id"))
    .find((modelId) => modelId !== undefined);
  return input.selectedModelId === inheritedModelId ? undefined : input.selectedModelId;
}

function readReasoningEffortValue(
  view: unknown,
  modelId: string | undefined,
): LlmReasoningEffort | undefined {
  if (!modelSupportsReasoningSettings(modelId)) {
    return undefined;
  }
  const selectedEffort = normalizeReasoningEffort(
    readSelectedOptionValue(
      view,
      MODEL_ROUTING_REASONING_EFFORT_BLOCK_ID,
      MODEL_ROUTING_REASONING_EFFORT_ACTION_ID,
    ),
  );
  if (selectedEffort === undefined || selectedEffort === LlmReasoningEffortId.ProviderDefault) {
    return selectedEffort;
  }
  return supportedReasoningEfforts(modelId).has(selectedEffort) ? selectedEffort : undefined;
}

function buildReasoningEffortBlock(input: {
  initialEffort: LlmReasoningEffort;
  modelId?: string;
  translator: Translator;
}): Record<string, unknown> {
  const options = reasoningEffortOptions({
    modelId: input.modelId,
    translator: input.translator,
  });
  const providerDefaultOption = options[0] as SlackOption;
  return {
    block_id: MODEL_ROUTING_REASONING_EFFORT_BLOCK_ID,
    element: {
      action_id: MODEL_ROUTING_REASONING_EFFORT_ACTION_ID,
      initial_option:
        options.find((option) => option.value === input.initialEffort) ?? providerDefaultOption,
      options,
      placeholder: {
        text: input.translator.t("modelRouting.reasoning.placeholder"),
        type: "plain_text",
      },
      type: "static_select",
    },
    label: {
      text: input.translator.t("modelRouting.reasoning.label"),
      type: "plain_text",
    },
    optional: false,
    type: "input",
  };
}

function modelRoutingBlocksForSelectedDefaultModel(input: {
  defaultModelId?: string;
  translator: Translator;
  view: unknown;
}): Record<string, unknown>[] {
  const sourceBlocks =
    isRecord(input.view) && Array.isArray(input.view.blocks) ? input.view.blocks : [];
  const blocks = sourceBlocks.filter(
    (block): block is Record<string, unknown> =>
      isRecord(block) && readString(block, "block_id") !== MODEL_ROUTING_REASONING_EFFORT_BLOCK_ID,
  );
  if (!modelSupportsReasoningSettings(input.defaultModelId)) {
    return blocks;
  }
  const selectedEffort =
    readReasoningEffortValue(input.view, input.defaultModelId) ??
    LlmReasoningEffortId.ProviderDefault;
  const reasoningBlock = buildReasoningEffortBlock({
    initialEffort: selectedEffort,
    modelId: input.defaultModelId,
    translator: input.translator,
  });
  const defaultModelBlockIndex = blocks.findIndex(
    (block) => readString(block, "block_id") === MODEL_ROUTING_DEFAULT_MODEL_BLOCK_ID,
  );
  if (defaultModelBlockIndex < 0) {
    return [...blocks, reasoningBlock];
  }
  return [
    ...blocks.slice(0, defaultModelBlockIndex + 1),
    reasoningBlock,
    ...blocks.slice(defaultModelBlockIndex + 1),
  ];
}

function modalWithUpdatedBlocks(
  view: Record<string, unknown>,
  blocks: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    blocks,
    callback_id: readString(view, "callback_id") ?? MODEL_ROUTING_MODAL_CALLBACK_ID,
    close: isRecord(view.close) ? view.close : { text: "Close", type: "plain_text" },
    private_metadata: readString(view, "private_metadata") ?? "",
    submit: isRecord(view.submit) ? view.submit : { text: "Save", type: "plain_text" },
    title: isRecord(view.title) ? view.title : { text: "Model routing", type: "plain_text" },
    type: "modal",
  };
}

function buildModelRoutingOpeningModal(
  translator: Translator,
  title = translator.t("modelRouting.title"),
): Record<string, unknown> {
  return {
    blocks: [
      {
        elements: [
          {
            text: translator.t("modelRouting.result.loading"),
            type: "plain_text",
          },
        ],
        type: "context",
      },
    ],
    title: { text: title, type: "plain_text" },
    type: "modal",
  };
}

function buildModelRoutingResultModal(
  message: string,
  translator: Translator,
  title = translator.t("modelRouting.title"),
): Record<string, unknown> {
  return {
    blocks: [
      {
        text: {
          text: message,
          type: "mrkdwn",
        },
        type: "section",
      },
    ],
    close: { text: translator.t("common.close"), type: "plain_text" },
    title: { text: title, type: "plain_text" },
    type: "modal",
  };
}

async function updateModelRoutingModal(
  client: SlackClient,
  view: unknown,
  modal: Record<string, unknown>,
  logger: unknown,
  options: { useHash?: boolean } = {},
): Promise<void> {
  const viewId = isRecord(view) ? readString(view, "id") : undefined;
  if (viewId === undefined) {
    logWarn(logger, "Could not update model routing modal without Slack view id.", {});
    return;
  }
  const hash = options.useHash && isRecord(view) ? readString(view, "hash") : undefined;
  try {
    await client.views.update({
      ...(hash === undefined ? {} : { hash }),
      view: modal as never,
      view_id: viewId,
    });
  } catch (error) {
    logWarn(logger, "Failed to update model routing modal.", { error, viewId });
  }
}

function parseModelRoutingActionValue(
  value: string | undefined,
): ModelRoutingActionValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    return {
      channelId: readOptionalString(parsed.channelId),
      enterpriseId: readOptionalString(parsed.enterpriseId),
      selectedTeamId: readOptionalString(parsed.selectedTeamId),
      source: parseModelRoutingSource(parsed.source),
      teamId: readOptionalString(parsed.teamId),
      threadTs: readOptionalString(parsed.threadTs),
    };
  } catch {
    return undefined;
  }
}

function parseModelRoutingSource(value: unknown): ModelRoutingActionValue["source"] | undefined {
  return value === "app_home" || value === "channel" || value === "thread" ? value : undefined;
}

function buildSalesforcePdfWorkflowBlocks(
  salesforceOrgId: string,
  settings: readonly SalesforcePdfWorkflowSettings[],
  translator: Translator,
): Record<string, unknown>[] {
  return salesforcePdfWorkflowActions.map((action) => {
    const setting = settings.find(
      (item) => item.salesforce_org_id === salesforceOrgId && item.action === action,
    );
    const enabled = setting?.enabled === true;
    return {
      accessory: {
        action_id: SALESFORCE_PDF_WORKFLOW_CONFIGURE_ACTION_ID,
        text: { text: translator.t("appHome.configure"), type: "plain_text" },
        type: "button",
        value: JSON.stringify({ action, salesforceOrgId }),
      },
      text: {
        text: `*${salesforcePdfWorkflowActionLabel(action)}*\n${
          setting === undefined
            ? enabled
              ? translator.t("common.enabled")
              : translator.t("common.disabled")
            : translator.t("appHome.salesforce.workflowStatus", {
                status: enabled ? translator.t("common.enabled") : translator.t("common.disabled"),
                templateId: setting.template_id,
              })
        }`,
        type: "mrkdwn",
      },
      type: "section",
    };
  });
}

function salesforceStatusText(
  status: string,
  accountLabel: string | undefined,
  translator: Translator,
): string {
  if (status === "active") {
    return accountLabel === undefined
      ? translator.t("appHome.salesforce.connected")
      : translator.t("appHome.salesforce.connectedAs", { account: accountLabel });
  }
  if (status === "expired") {
    return translator.t("appHome.salesforce.reconnectRequired");
  }
  if (status === "revoked") {
    return translator.t("appHome.salesforce.disconnected");
  }
  if (status === "error") {
    return translator.t("appHome.salesforce.connectionNeedsAttention");
  }
  return translator.t("appHome.salesforce.notConnected");
}

async function handleWorkspaceCredentialConfigureAction(
  { ack, body, client, logger }: SlackActionArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  await ack();
  const teamId = readTeamId(body, {});
  const enterpriseId = readSlackEnterpriseId(body);
  const slackUserId = readSlackUserId(body);
  const triggerId = isRecord(body) ? readString(body, "trigger_id") : undefined;
  if (teamId === undefined || slackUserId === undefined || triggerId === undefined) {
    logger.warn("Ignoring API key configuration action with missing Slack context.");
    return;
  }
  const translator = createTranslator(options.defaultLocale ?? FALLBACK_LOCALE);
  if (options.workspaceCredentialSettings === undefined) {
    const response = await client.views.open({
      trigger_id: triggerId,
      view: buildWorkspaceCredentialUnavailableModal(translator) as never,
    });
    await updateOpenedWorkspaceCredentialModalLocale({
      client,
      logger,
      response,
      slackUserId,
      enterpriseId,
      teamId,
      translator,
      userSettingsRepository: options.userSettingsRepository,
      view: buildWorkspaceCredentialUnavailableModal,
    });
    return;
  }
  const response = await client.views.open({
    trigger_id: triggerId,
    view: buildWorkspaceCredentialModal({ enterpriseId, teamId }, "openai", translator) as never,
  });
  await updateOpenedWorkspaceCredentialModalLocale({
    client,
    logger,
    response,
    slackUserId,
    enterpriseId,
    teamId,
    translator,
    userSettingsRepository: options.userSettingsRepository,
    view: (localizedTranslator) =>
      buildWorkspaceCredentialModal({ enterpriseId, teamId }, "openai", localizedTranslator),
  });
}

async function updateOpenedWorkspaceCredentialModalLocale(input: {
  client: SlackClient;
  logger: unknown;
  response: unknown;
  enterpriseId: string | undefined;
  slackUserId: string;
  teamId: string;
  translator: Translator;
  userSettingsRepository: UserSettingsRepository | undefined;
  view(translator: Translator): Record<string, unknown>;
}): Promise<void> {
  const translator = await resolveHandlerTranslator(
    { enterpriseId: input.enterpriseId, teamId: input.teamId },
    input.slackUserId,
    {
      defaultLocale: input.translator.locale,
      userSettingsRepository: input.userSettingsRepository,
    },
    input.logger,
  );
  if (translator.locale === input.translator.locale) {
    return;
  }
  const openedView = isRecord(input.response) ? input.response.view : undefined;
  await updateWorkspaceCredentialModal(
    input.client,
    openedView,
    input.view(translator),
    input.logger,
  );
}

async function handleWorkspaceCredentialProviderSelectAction(
  { ack, body, client, logger }: SlackActionArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  await ack();
  const view = isRecord(body) ? body.view : undefined;
  const metadata = parseWorkspaceCredentialModalMetadata(
    isRecord(view) ? readString(view, "private_metadata") : undefined,
  );
  const slackUserId = readSlackUserId(body);
  const enterpriseId = metadata?.enterpriseId ?? readSlackEnterpriseId(body);
  const teamId = metadata?.teamId ?? readTeamId(body, {});
  const translator = await resolveHandlerTranslator(
    { enterpriseId, teamId },
    slackUserId,
    {
      defaultLocale: metadata?.locale ?? options.defaultLocale,
      userSettingsRepository: options.userSettingsRepository,
    },
    logger,
  );
  const providerValue = readSelectedOptionValue(
    view,
    WORKSPACE_CREDENTIAL_PROVIDER_BLOCK_ID,
    WORKSPACE_CREDENTIAL_PROVIDER_ACTION_ID,
  );
  const providerSelection = parseWorkspaceCredentialProviderSelection(providerValue) ?? "openai";
  logInfo(logger, "Updating workspace credential modal for selected provider.", {
    providerSelection,
    teamId,
  });
  await updateWorkspaceCredentialModal(
    client,
    view,
    buildWorkspaceCredentialModal(
      { enterpriseId, teamId: teamId ?? "" },
      providerSelection,
      translator,
    ),
    logger,
  );
}

async function handleWorkspaceCredentialModalSubmission(
  { ack, body, client, logger, view }: SlackViewArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  const metadata = parseWorkspaceCredentialModalMetadata(
    readString(view as unknown as StringIndexed, "private_metadata"),
  );
  const metadataTeamId = metadata?.teamId;
  const bodyTeamId = readTeamId(body, {});
  const teamId = bodyTeamId ?? metadataTeamId;
  const slackUserId = readSlackUserId(body);
  const ackTranslator = createTranslator(
    metadata?.locale ?? options.defaultLocale ?? FALLBACK_LOCALE,
  );
  if (options.workspaceCredentialSettings === undefined) {
    await ack({
      errors: {
        [WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID]: ackTranslator.t("credential.error.notConfigured"),
      },
      response_action: "errors",
    });
    return;
  }
  if (metadataTeamId !== undefined && bodyTeamId !== undefined && metadataTeamId !== bodyTeamId) {
    await ack({
      errors: {
        [WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID]: ackTranslator.t("credential.error.contextMismatch"),
      },
      response_action: "errors",
    });
    return;
  }
  if (teamId === undefined || slackUserId === undefined) {
    await ack({
      errors: {
        [WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID]: ackTranslator.t("credential.error.contextMissing"),
      },
      response_action: "errors",
    });
    return;
  }
  const parsed = parseWorkspaceCredentialModal(view, ackTranslator);
  if ("errors" in parsed) {
    await ack({
      errors: parsed.errors,
      response_action: "errors",
    });
    return;
  }

  await ack({
    response_action: "update",
    view: buildWorkspaceCredentialSavingModal(ackTranslator) as never,
  });

  let resultTranslator = ackTranslator;
  try {
    const userContext = await resolveSlackUserContext(client, slackUserId, ackTranslator, logger);
    const { translator } = userContext;
    resultTranslator = translator;
    if (!userContext.isWorkspaceAdmin) {
      await updateWorkspaceCredentialModal(
        client,
        view,
        buildWorkspaceCredentialResultModal(
          translator.t("credential.title.apiKey"),
          translator.t("credential.error.unauthorized"),
          translator,
        ),
        logger,
      );
      return;
    }
    await options.workspaceCredentialSettings.saveProviderApiKey({
      createdByUserId: slackUserId,
      ...(parsed.credentialName === undefined ? {} : { credentialName: parsed.credentialName }),
      payload: parsed.payload,
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
      buildWorkspaceCredentialResultModal(
        translator.t("credential.title.saved"),
        translator.t("credential.result.saved"),
        translator,
      ),
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
        resultTranslator.t("credential.title.apiKey"),
        resultTranslator.t("credential.error.saveFailed"),
        resultTranslator,
      ),
      logger,
    );
  }
}

async function handleSalesforcePdfWorkflowConfigureAction(
  { ack, body, client, logger }: SlackActionArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  await ack();
  const teamId = readTeamId(body, {});
  const enterpriseId = readSlackEnterpriseId(body);
  const slackUserId = readSlackUserId(body);
  const triggerId = isRecord(body) ? readString(body, "trigger_id") : undefined;
  const actionValue = parseSalesforcePdfWorkflowActionValue(readActionValue(body));
  if (
    teamId === undefined ||
    slackUserId === undefined ||
    triggerId === undefined ||
    actionValue === undefined
  ) {
    logger.warn("Ignoring Salesforce PDF workflow configuration action with missing context.");
    return;
  }
  const translator = createTranslator(options.defaultLocale ?? FALLBACK_LOCALE);
  const response = await client.views.open({
    trigger_id: triggerId,
    view: buildSalesforcePdfWorkflowResultModal(
      translator.t("salesforcePdf.title"),
      translator.t("salesforcePdf.result.loading"),
      translator,
    ) as never,
  });
  const localizedTranslator = await resolveHandlerTranslator(
    { enterpriseId, teamId },
    slackUserId,
    {
      defaultLocale: translator.locale,
      userSettingsRepository: options.userSettingsRepository,
    },
    logger,
  );
  const openedView = isRecord(response) ? response.view : undefined;
  if (options.salesforcePdfWorkflowHome === undefined) {
    await updateSalesforcePdfWorkflowModal(
      client,
      openedView,
      buildSalesforcePdfWorkflowResultModal(
        localizedTranslator.t("salesforcePdf.title"),
        localizedTranslator.t("salesforcePdf.error.processNotConfigured"),
        localizedTranslator,
      ),
      logger,
    );
    return;
  }
  const userContext = await resolveSlackUserContext(
    client,
    slackUserId,
    localizedTranslator,
    logger,
  );
  if (!userContext.isWorkspaceAdmin) {
    await updateSalesforcePdfWorkflowModal(
      client,
      openedView,
      buildSalesforcePdfWorkflowResultModal(
        localizedTranslator.t("salesforcePdf.title"),
        localizedTranslator.t("salesforcePdf.error.unauthorized"),
        localizedTranslator,
      ),
      logger,
    );
    return;
  }

  const current =
    await options.salesforcePdfWorkflowHome.repository.findSalesforcePdfWorkflowSetting(
      teamId,
      actionValue.salesforceOrgId,
      actionValue.action,
    );
  const parsedCurrent =
    current === undefined ? undefined : salesforcePdfWorkflowSettingsSchema.safeParse(current);
  await updateSalesforcePdfWorkflowModal(
    client,
    openedView,
    buildSalesforcePdfWorkflowModal({
      action: actionValue.action,
      salesforceOrgId: actionValue.salesforceOrgId,
      settings: parsedCurrent?.success === true ? parsedCurrent.data : undefined,
      enterpriseId,
      teamId,
      translator: localizedTranslator,
    }),
    logger,
  );
}

async function handleSalesforcePdfWorkflowModalSubmission(
  { ack, body, client, logger, view }: SlackViewArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  const metadata = parseSalesforcePdfWorkflowModalMetadata(
    readString(view as unknown as StringIndexed, "private_metadata"),
  );
  const bodyTeamId = readTeamId(body, {});
  const slackUserId = readSlackUserId(body);
  const ackTranslator = createTranslator(
    metadata?.locale ?? options.defaultLocale ?? FALLBACK_LOCALE,
  );
  if (options.salesforcePdfWorkflowHome === undefined) {
    await ack({
      errors: {
        [SALESFORCE_PDF_WORKFLOW_ENABLED_BLOCK_ID]: ackTranslator.t(
          "salesforcePdf.error.notConfigured",
        ),
      },
      response_action: "errors",
    });
    return;
  }
  if (
    metadata === undefined ||
    slackUserId === undefined ||
    (bodyTeamId !== undefined && metadata.teamId !== bodyTeamId)
  ) {
    await ack({
      errors: {
        [SALESFORCE_PDF_WORKFLOW_ENABLED_BLOCK_ID]: ackTranslator.t(
          "salesforcePdf.error.contextMissing",
        ),
      },
      response_action: "errors",
    });
    return;
  }
  const parsed = parseSalesforcePdfWorkflowModal(view, ackTranslator);
  if ("errors" in parsed) {
    await ack({
      errors: parsed.errors,
      response_action: "errors",
    });
    return;
  }

  await ack({
    response_action: "update",
    view: buildSalesforcePdfWorkflowResultModal(
      ackTranslator.t("salesforcePdf.title"),
      ackTranslator.t("salesforcePdf.result.saving"),
      ackTranslator,
    ) as never,
  });

  let resultTranslator = ackTranslator;
  try {
    const userContext = await resolveSlackUserContext(client, slackUserId, ackTranslator, logger);
    const { translator } = userContext;
    resultTranslator = translator;
    if (!userContext.isWorkspaceAdmin) {
      await updateSalesforcePdfWorkflowModal(
        client,
        view,
        buildSalesforcePdfWorkflowResultModal(
          translator.t("salesforcePdf.title"),
          translator.t("salesforcePdf.error.unauthorized"),
          translator,
        ),
        logger,
      );
      return;
    }
    const now = new Date();
    const existingPayload =
      await options.salesforcePdfWorkflowHome.repository.findSalesforcePdfWorkflowSetting(
        metadata.teamId,
        metadata.salesforceOrgId,
        metadata.action,
      );
    const existing = parseExistingSalesforcePdfWorkflowSetting(existingPayload);
    const payload = salesforcePdfWorkflowSettingsSchema.parse({
      action: metadata.action,
      allowed_approval_statuses: parsed.allowedApprovalStatuses,
      allowed_record_type_ids: parsed.allowedRecordTypeIds,
      allowed_record_type_names: parsed.allowedRecordTypeNames,
      allowed_stages: parsed.allowedStages,
      allowed_statuses: parsed.allowedStatuses,
      approval_status_field: parsed.approvalStatusField,
      attach_to: parsed.attachTo,
      created_at: existing?.created_at ?? now,
      enabled: parsed.enabled,
      enabled_at:
        parsed.enabled === false
          ? null
          : existing?.enabled === true
            ? (existing.enabled_at ?? now)
            : now,
      enabled_by_slack_user_id:
        parsed.enabled === false
          ? null
          : existing?.enabled === true
            ? (existing.enabled_by_slack_user_id ?? slackUserId)
            : slackUserId,
      field_mapping: parsed.fieldMapping,
      include_ai_summary: parsed.includeAiSummary,
      required_fields: parsed.requiredFields,
      require_confirmation_before_attach: parsed.requireConfirmationBeforeAttach,
      salesforce_org_id: metadata.salesforceOrgId,
      team_id: metadata.teamId,
      template_id: parsed.templateId,
      updated_at: now,
      updated_by_slack_user_id: slackUserId,
    });
    await options.salesforcePdfWorkflowHome.repository.saveSalesforcePdfWorkflowSetting({
      action: payload.action,
      enabled: payload.enabled,
      payload: salesforcePdfWorkflowPayload(payload),
      salesforceOrgId: payload.salesforce_org_id,
      teamId: payload.team_id,
      templateId: payload.template_id,
      updatedAt: payload.updated_at,
    });
    logInfo(logger, "Saved Salesforce PDF workflow settings from Slack modal.", {
      action: payload.action,
      enabled: payload.enabled,
      salesforceOrgId: payload.salesforce_org_id,
      teamId: payload.team_id,
    });
    await updateSalesforcePdfWorkflowModal(
      client,
      view,
      buildSalesforcePdfWorkflowResultModal(
        translator.t("salesforcePdf.title"),
        translator.t("salesforcePdf.result.saved", {
          action: salesforcePdfWorkflowActionLabel(payload.action),
          status: payload.enabled
            ? translator.t("common.enabledStatus")
            : translator.t("common.disabledStatus"),
        }),
        translator,
      ),
      logger,
    );
  } catch (error) {
    logger.error("Failed to save Salesforce PDF workflow settings from Slack modal.", {
      error,
      metadata,
    });
    await updateSalesforcePdfWorkflowModal(
      client,
      view,
      buildSalesforcePdfWorkflowResultModal(
        resultTranslator.t("salesforcePdf.title"),
        resultTranslator.t("salesforcePdf.error.saveFailed"),
        resultTranslator,
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

  const enterpriseId = readSlackEnterpriseId(body);
  const translator = await resolveHandlerTranslator(
    { enterpriseId, teamId },
    event.user,
    options,
    logger,
  );
  const threadTs = readString(event, "thread_ts") ?? event.ts;
  const mentionText = stripBotMention(readString(event, "text") ?? "", context.botUserId);
  if (options.agentJobQueue !== undefined) {
    if (
      options.routingRepository !== undefined &&
      !(await options.routingRepository.isChannelEnabled(teamId, event.channel))
    ) {
      return;
    }
    if (mentionText.length === 0) {
      await postMentionMenuMessage({
        channelId: event.channel,
        client,
        enterpriseId,
        teamId,
        threadTs,
        translator,
      });
      await activateMentionMenuThread({
        channelId: event.channel,
        logger,
        messageTs: event.ts,
        routingRepository: options.routingRepository,
        teamId,
        threadTs,
      });
      return;
    }
    await enqueueSlackAgentJob({
      body,
      client,
      eventType: "app_mention",
      job: {
        apiAppId: readSlackApiAppId(body),
        botUserId: context.botUserId,
        channelId: event.channel,
        enterpriseId: readSlackEnterpriseId(body),
        eventId: readSlackEventId(body),
        eventType: "app_mention",
        isEnterpriseInstall: readSlackEnterpriseInstall(body),
        messageTs: event.ts,
        retryNum: readOptionalContextValue(context.retryNum),
        retryReason: readOptionalContextValue(context.retryReason),
        teamId,
        text: mentionText,
        threadTs,
        userId: event.user,
      },
      logger,
      queue: options.agentJobQueue,
      translator,
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
    if (mentionText.length === 0) {
      await postMentionMenuMessage({
        channelId: event.channel,
        client,
        enterpriseId,
        teamId,
        threadTs,
        translator,
      });
      await activateMentionMenuThread({
        channelId: event.channel,
        logger,
        messageTs: event.ts,
        routingRepository: options.routingRepository,
        teamId,
        threadTs,
      });
      return;
    }
    const route = await resolveSlackAgentRoute(options.routingRepository, {
      channelId: event.channel,
      teamId,
      threadTs,
    });
    if (options.routingRepository?.resolveAgent !== undefined && route === undefined) {
      text = translator.t("slack.error.noAgent");
      await postNoAgentConfiguredMessage({
        channelId: event.channel,
        enterpriseId,
        teamId,
        text,
        threadTs,
        translator,
        client,
      });
      return;
    }
    await notifyModelFallback({
      channelId: event.channel,
      client,
      logger,
      route,
      threadTs,
      translator,
      userId: event.user,
    });
    const threadMessages = await readThreadMessages(client, event.channel, threadTs);
    const result = await runner.run({
      channelId: event.channel,
      messageTs: event.ts,
      modelId: route?.modelId,
      reasoningEffort: route?.reasoningEffort,
      teamId,
      text: mentionText,
      threadHistory: readThreadHistoryMessages(threadMessages, {
        apiAppId: readSlackApiAppId(body),
        botUserId: context?.botUserId,
        currentMessageTs: event.ts,
        teamId,
      }),
      threadTs,
      transientAttachments: await resolveTransientAudioAttachmentsForInvocation({
        client,
        event,
        messages: threadMessages,
        options,
        teamId,
      }),
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
          agentId: route?.agentId ?? "assistant",
          channelId: event.channel,
          lastMessageTs: event.ts,
          modelId: threadScopedModelId(route),
          reasoningEffort: threadScopedReasoningEffort(route),
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
    text = runnerUserFacingErrorMessage(error, translator);
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

  const enterpriseId = readSlackEnterpriseId(body);
  const translator = await resolveHandlerTranslator(
    { enterpriseId, teamId },
    event.user,
    options,
    logger,
  );
  const messageText = readString(event, "text") ?? "";
  if (isMentionOnlyText(messageText, context?.botUserId)) {
    await postMentionMenuMessage({
      channelId: event.channel,
      client,
      enterpriseId,
      teamId,
      threadTs,
      translator,
    });
    await activateMentionMenuThread({
      channelId: event.channel,
      logger,
      messageTs: event.ts,
      routingRepository: options.routingRepository,
      teamId,
      threadTs,
    });
    return;
  }
  if (options.agentJobQueue !== undefined) {
    await enqueueSlackAgentJob({
      body,
      client,
      eventType: "message_follow_up",
      job: {
        apiAppId: readSlackApiAppId(body),
        botUserId: context.botUserId,
        channelId: event.channel,
        enterpriseId: readSlackEnterpriseId(body),
        eventId: readSlackEventId(body),
        eventType: "message_follow_up",
        isEnterpriseInstall: readSlackEnterpriseInstall(body),
        messageTs: event.ts,
        retryNum: readOptionalContextValue(context.retryNum),
        retryReason: readOptionalContextValue(context.retryReason),
        teamId,
        text: messageText,
        threadTs,
        userId: event.user,
      },
      logger,
      queue: options.agentJobQueue,
      translator,
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
    await notifyModelFallback({
      channelId: event.channel,
      client,
      logger,
      route,
      threadTs,
      translator,
      userId: event.user,
    });
    const modelId = route === undefined ? stringField(thread, "model_id") : route.modelId;
    const reasoningEffort =
      route === undefined ? stringField(thread, REASONING_EFFORT_FIELD) : route.reasoningEffort;
    const threadMessages = await readThreadMessages(client, event.channel, threadTs);
    const result = await runner.run({
      channelId: event.channel,
      messageTs: event.ts,
      modelId,
      reasoningEffort,
      teamId,
      text: messageText,
      threadHistory: readThreadHistoryMessages(threadMessages, {
        apiAppId: readSlackApiAppId(body),
        botUserId: context?.botUserId,
        currentMessageTs: event.ts,
        teamId,
      }),
      threadTs,
      transientAttachments: await resolveTransientAudioAttachmentsForInvocation({
        client,
        event,
        messages: threadMessages,
        options,
        teamId,
      }),
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
        agentId: route?.agentId ?? stringField(thread, "agent_id") ?? "assistant",
        channelId: event.channel,
        lastMessageTs: event.ts,
        modelId: route === undefined ? stringField(thread, "model_id") : threadScopedModelId(route),
        reasoningEffort:
          route === undefined
            ? stringField(thread, REASONING_EFFORT_FIELD)
            : threadScopedReasoningEffort(route),
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
    text = runnerUserFacingErrorMessage(error, translator);
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
    audioFetchFn?: typeof fetch;
    audioTranscriptionGateway?: TranscriptionGateway;
    client: SlackAgentClient;
    defaultLocale?: Locale;
    logger: unknown;
    retryContext?: SlackAgentJobRetryContext;
    routingRepository?: SlackAgentRoutingRepository;
    runner: AgentRunner;
    userSettingsRepository?: UserSettingsRepository;
  },
): Promise<void> {
  if (job.eventType === "app_mention") {
    await processAppMentionJob(job, input);
    return;
  }
  if (job.eventType === "reaction_added") {
    await processReactionAddedJob(job, input);
    return;
  }
  await processFollowUpMessageJob(job, input);
}

async function processAppMentionJob(
  job: SlackAgentJob,
  input: {
    audioFetchFn?: typeof fetch;
    audioTranscriptionGateway?: TranscriptionGateway;
    client: SlackAgentClient;
    defaultLocale?: Locale;
    logger: unknown;
    retryContext?: SlackAgentJobRetryContext;
    routingRepository?: SlackAgentRoutingRepository;
    runner: AgentRunner;
    userSettingsRepository?: UserSettingsRepository;
  },
): Promise<void> {
  if (
    input.routingRepository !== undefined &&
    !(await input.routingRepository.isChannelEnabled(job.teamId, job.channelId))
  ) {
    return;
  }
  const translator = await resolveHandlerTranslator(
    { enterpriseId: job.enterpriseId, teamId: job.teamId },
    job.userId,
    input,
    input.logger,
  );
  await setSlackAssistantThreadStatus({
    channelId: job.channelId,
    client: input.client,
    logger: input.logger,
    translator,
    threadTs: job.threadTs,
  });
  if (job.text.trim().length === 0) {
    await postMentionMenuMessage({
      channelId: job.channelId,
      client: input.client,
      enterpriseId: job.enterpriseId,
      teamId: job.teamId,
      threadTs: job.threadTs,
      translator,
    });
    await activateMentionMenuThread({
      channelId: job.channelId,
      logger: input.logger,
      messageTs: job.messageTs,
      routingRepository: input.routingRepository,
      teamId: job.teamId,
      threadTs: job.threadTs,
    });
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
      await postNoAgentConfiguredMessage({
        channelId: job.channelId,
        enterpriseId: job.enterpriseId,
        teamId: job.teamId,
        text: translator.t("slack.error.noAgent"),
        threadTs: job.threadTs,
        translator,
        client: input.client,
      });
      return;
    }
    await notifyModelFallback({
      channelId: job.channelId,
      client: input.client,
      logger: input.logger,
      route,
      threadTs: job.threadTs,
      translator,
      userId: job.userId,
    });
    const threadMessages = await readThreadMessages(input.client, job.channelId, job.threadTs);
    const result = await input.runner.run({
      channelId: job.channelId,
      messageTs: job.messageTs,
      modelId: route?.modelId,
      reasoningEffort: route?.reasoningEffort,
      teamId: job.teamId,
      text: job.text,
      threadHistory: readThreadHistoryMessages(threadMessages, {
        apiAppId: job.apiAppId,
        botUserId: job.botUserId,
        currentMessageTs: job.messageTs,
        teamId: job.teamId,
      }),
      threadTs: job.threadTs,
      transientAttachments: await resolveTransientAudioAttachmentsForInvocation({
        client: input.client,
        messages: threadMessages,
        options: input,
        teamId: job.teamId,
      }),
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
          agentId: route?.agentId ?? "assistant",
          channelId: job.channelId,
          lastMessageTs: job.messageTs,
          modelId: threadScopedModelId(route),
          reasoningEffort: threadScopedReasoningEffort(route),
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
    if (shouldRetryJobFailure(input.retryContext)) {
      throw error;
    }
    text = runnerUserFacingErrorMessage(error, translator);
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
    audioFetchFn?: typeof fetch;
    audioTranscriptionGateway?: TranscriptionGateway;
    client: SlackAgentClient;
    defaultLocale?: Locale;
    logger: unknown;
    retryContext?: SlackAgentJobRetryContext;
    routingRepository?: SlackAgentRoutingRepository;
    runner: AgentRunner;
    userSettingsRepository?: UserSettingsRepository;
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

  const translator = await resolveHandlerTranslator(
    { enterpriseId: job.enterpriseId, teamId: job.teamId },
    job.userId,
    input,
    input.logger,
  );
  if (isMentionOnlyText(job.text, job.botUserId)) {
    await postMentionMenuMessage({
      channelId: job.channelId,
      client: input.client,
      enterpriseId: job.enterpriseId,
      teamId: job.teamId,
      threadTs: job.threadTs,
      translator,
    });
    await activateMentionMenuThread({
      channelId: job.channelId,
      logger: input.logger,
      messageTs: job.messageTs,
      routingRepository: input.routingRepository,
      teamId: job.teamId,
      threadTs: job.threadTs,
    });
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
    await notifyModelFallback({
      channelId: job.channelId,
      client: input.client,
      logger: input.logger,
      route,
      threadTs: job.threadTs,
      translator,
      userId: job.userId,
    });
    await setSlackAssistantThreadStatus({
      channelId: job.channelId,
      client: input.client,
      logger: input.logger,
      translator,
      threadTs: job.threadTs,
    });
    const modelId = route === undefined ? stringField(thread, "model_id") : route.modelId;
    const reasoningEffort =
      route === undefined ? stringField(thread, REASONING_EFFORT_FIELD) : route.reasoningEffort;
    const threadMessages = await readThreadMessages(input.client, job.channelId, job.threadTs);
    const result = await input.runner.run({
      channelId: job.channelId,
      messageTs: job.messageTs,
      modelId,
      reasoningEffort,
      teamId: job.teamId,
      text: job.text,
      threadHistory: readThreadHistoryMessages(threadMessages, {
        apiAppId: job.apiAppId,
        botUserId: job.botUserId,
        currentMessageTs: job.messageTs,
        teamId: job.teamId,
      }),
      threadTs: job.threadTs,
      transientAttachments: await resolveTransientAudioAttachmentsForInvocation({
        client: input.client,
        messages: threadMessages,
        options: input,
        teamId: job.teamId,
      }),
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
        agentId: route?.agentId ?? stringField(thread, "agent_id") ?? "assistant",
        channelId: job.channelId,
        lastMessageTs: job.messageTs,
        modelId: route === undefined ? stringField(thread, "model_id") : threadScopedModelId(route),
        reasoningEffort:
          route === undefined
            ? stringField(thread, REASONING_EFFORT_FIELD)
            : threadScopedReasoningEffort(route),
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
    if (shouldRetryJobFailure(input.retryContext)) {
      throw error;
    }
    text = runnerUserFacingErrorMessage(error, translator);
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

async function processReactionAddedJob(
  job: SlackAgentJob,
  input: {
    client: SlackAgentClient;
    defaultLocale?: Locale;
    logger: unknown;
    retryContext?: SlackAgentJobRetryContext;
    routingRepository?: SlackAgentRoutingRepository;
    runner: AgentRunner;
    userSettingsRepository?: UserSettingsRepository;
  },
): Promise<void> {
  if (input.routingRepository === undefined || job.targetLanguage === undefined) {
    return;
  }
  if (!(await input.routingRepository.isChannelEnabled(job.teamId, job.channelId))) {
    return;
  }
  const translator = await resolveHandlerTranslator(
    { enterpriseId: job.enterpriseId, teamId: job.teamId },
    job.userId,
    input,
    input.logger,
  );

  let sourceText: string | undefined;
  let threadTs = job.threadTs;
  try {
    const sourceMessage = await fetchSingleMessage(input.client, job.channelId, job.messageTs);
    sourceText = readSlackMessageText(sourceMessage);
    threadTs = readString(sourceMessage, "thread_ts") ?? job.threadTs;
  } catch (error) {
    logWarn(input.logger, "Could not fetch source message for translation reaction.", {
      error,
      teamId: job.teamId,
      threadTs,
    });
  }
  let text: string;
  try {
    const route = await resolveSlackAgentRoute(input.routingRepository, {
      channelId: job.channelId,
      teamId: job.teamId,
      threadTs,
    });
    if (input.routingRepository.resolveAgent !== undefined && route === undefined) {
      return;
    }
    await notifyModelFallback({
      channelId: job.channelId,
      client: input.client,
      logger: input.logger,
      route,
      threadTs,
      translator,
      userId: job.userId,
    });
    if (sourceText === undefined || sourceText.trim() === "") {
      await input.client.chat.postMessage({
        channel: job.channelId,
        text: translator.t("slack.error.unreadableReaction"),
        thread_ts: threadTs,
      });
      return;
    }
    await setSlackAssistantThreadStatus({
      channelId: job.channelId,
      client: input.client,
      logger: input.logger,
      translator,
      threadTs,
    });
    const result = await input.runner.runStructured(
      {
        channelId: job.channelId,
        messageTs: job.messageTs,
        modelId: route?.modelId,
        reasoningEffort: route?.reasoningEffort,
        teamId: job.teamId,
        text:
          `Translate the following Slack message to ${job.targetLanguage}.\n` +
          "Return only the structured translation result. Preserve Slack mentions, URLs, emoji, and code blocks where possible.\n\n" +
          sourceText,
        threadTs,
        userId: job.userId,
        viewerContextChannelIds: [job.channelId],
      },
      TRANSLATION_RESULT_RESPONSE_FORMAT,
    );
    const translationResult = translationResultSchema.parse(result.structuredOutput);
    text = translationResult.translatedText;
    logStructuredAgentRunnerSuccess(input.logger, {
      channelId: job.channelId,
      eventType: "reaction_added",
      messageTs: job.messageTs,
      result,
      teamId: job.teamId,
      threadTs,
    });
  } catch (error) {
    logError(input.logger, "TypeScript AgentRunner failed while handling translation reaction.", {
      error,
      ...runnerFailureLogFields(error),
      teamId: job.teamId,
      threadTs,
    });
    if (shouldRetryJobFailure(input.retryContext)) {
      throw error;
    }
    text = translator.t("slack.error.translation");
  }

  await input.client.chat.postMessage({
    channel: job.channelId,
    text,
    thread_ts: threadTs,
  });
}

async function activateMentionMenuThread(input: {
  channelId: string;
  logger: unknown;
  messageTs: string;
  routingRepository?: SlackAgentRoutingRepository;
  teamId: string;
  threadTs: string;
}): Promise<void> {
  const route = await resolveSlackAgentRoute(input.routingRepository, {
    channelId: input.channelId,
    teamId: input.teamId,
    threadTs: input.threadTs,
  });
  if (input.routingRepository === undefined || route === undefined) {
    return;
  }
  try {
    await input.routingRepository.activateThreadAgent({
      agentId: route.agentId,
      channelId: input.channelId,
      lastMessageTs: input.messageTs,
      modelId: threadScopedModelId(route),
      reasoningEffort: threadScopedReasoningEffort(route),
      rootMessageTs: input.threadTs,
      teamId: input.teamId,
      threadTs: input.threadTs,
    });
  } catch (error) {
    logWarn(input.logger, "Failed to persist Slack thread routing state after mention menu.", {
      channelId: input.channelId,
      error,
      teamId: input.teamId,
      threadTs: input.threadTs,
    });
  }
}

async function postNoAgentConfiguredMessage(input: {
  channelId: string;
  client: SlackAgentClient;
  enterpriseId?: string;
  teamId: string;
  text: string;
  threadTs: string;
  translator: Translator;
}): Promise<void> {
  await input.client.chat.postMessage({
    blocks: [
      {
        text: {
          text: input.text,
          type: "mrkdwn",
        },
        type: "section",
      },
      {
        elements: [
          {
            action_id: MODEL_ROUTING_CONFIGURE_ACTION_ID,
            text: {
              text: input.translator.t("channelSettings.configure"),
              type: "plain_text",
            },
            type: "button",
            value: JSON.stringify({
              channelId: input.channelId,
              enterpriseId: input.enterpriseId,
              source: "channel",
              teamId: input.teamId,
            }),
          },
        ],
        type: "actions",
      },
    ],
    channel: input.channelId,
    metadata: modelRoutingControlMessageMetadata("no_agent_configured"),
    text: input.text,
    thread_ts: input.threadTs,
  });
}

async function postMentionMenuMessage(input: {
  channelId: string;
  client: SlackAgentClient;
  enterpriseId?: string;
  teamId: string;
  threadTs: string;
  translator: Translator;
}): Promise<void> {
  await input.client.chat.postMessage({
    blocks: [
      {
        elements: [
          {
            action_id: MODEL_ROUTING_THREAD_CONFIGURE_ACTION_ID,
            text: {
              text: input.translator.t("threadSettings.configure"),
              type: "plain_text",
            },
            type: "button",
            value: JSON.stringify({
              channelId: input.channelId,
              enterpriseId: input.enterpriseId,
              source: "thread",
              teamId: input.teamId,
              threadTs: input.threadTs,
            }),
          },
          {
            action_id: MODEL_ROUTING_CHANNEL_CONFIGURE_ACTION_ID,
            text: {
              text: input.translator.t("channelSettings.configure"),
              type: "plain_text",
            },
            type: "button",
            value: JSON.stringify({
              channelId: input.channelId,
              enterpriseId: input.enterpriseId,
              source: "channel",
              teamId: input.teamId,
            }),
          },
        ],
        type: "actions",
      },
    ],
    channel: input.channelId,
    metadata: modelRoutingControlMessageMetadata("mention_menu"),
    text: input.translator.t("modelRouting.title"),
    thread_ts: input.threadTs,
  });
}

function modelRoutingControlMessageMetadata(kind: string) {
  return {
    event_payload: {
      kind,
    },
    event_type: AGENTS_PARTY_CONTROL_EVENT_TYPE,
  };
}

async function setSlackAssistantThreadStatus(input: {
  channelId: string;
  client: SlackAgentClient;
  logger: unknown;
  translator: Translator;
  threadTs: string;
}): Promise<void> {
  const setStatus = input.client.assistant?.threads?.setStatus;
  if (setStatus === undefined) {
    return;
  }
  try {
    await setStatus({
      channel_id: input.channelId,
      status: input.translator.t("slack.status.working"),
      thread_ts: input.threadTs,
    });
  } catch (error) {
    logWarn(input.logger, "Failed to set Slack assistant thread status.", {
      channelId: input.channelId,
      error,
      threadTs: input.threadTs,
    });
  }
}

async function notifyModelFallback(input: {
  channelId: string;
  client: SlackAgentClient;
  logger: unknown;
  route: SlackResolvedAgentRoute | undefined;
  threadTs: string;
  translator: Translator;
  userId: string;
}): Promise<void> {
  const fallback = input.route?.modelFallback;
  const postEphemeral = input.client.chat.postEphemeral;
  if (
    fallback?.toModelId === undefined ||
    fallback.toScope === undefined ||
    postEphemeral === undefined
  ) {
    return;
  }
  try {
    await postEphemeral({
      channel: input.channelId,
      text: input.translator.t("modelRouting.fallback.notice", {
        fromModelId: fallback.fromModelId,
        fromScope: fallback.fromScope,
        toModelId: fallback.toModelId,
        toScope: fallback.toScope,
      }),
      thread_ts: input.threadTs,
      user: input.userId,
    });
  } catch (error) {
    logWarn(input.logger, "Failed to post model routing fallback notice.", {
      channelId: input.channelId,
      error,
      threadTs: input.threadTs,
      userId: input.userId,
    });
  }
}

async function enqueueSlackAgentJob(input: {
  body: unknown;
  client: SlackAgentClient;
  eventType: SlackAgentJob["eventType"];
  job: SlackAgentJob;
  logger: unknown;
  queue: SlackAgentJobQueue;
  translator: Translator;
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
      text: input.translator.t("slack.error.queue"),
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
  const translator = await resolveHandlerTranslator(
    { enterpriseId: readSlackEnterpriseId(body), teamId },
    readString(event, "user"),
    options,
    logger,
  );
  if (options.agentJobQueue !== undefined) {
    await enqueueSlackAgentJob({
      body,
      client,
      eventType: "reaction_added",
      job: {
        channelId,
        enterpriseId: readSlackEnterpriseId(body),
        eventId: readSlackEventId(body),
        eventType: "reaction_added",
        isEnterpriseInstall: readSlackEnterpriseInstall(body),
        messageTs,
        teamId,
        targetLanguage,
        text: "",
        threadTs: messageTs,
        userId: readString(event, "user") ?? "unknown",
      },
      logger,
      queue: options.agentJobQueue,
      translator,
      threadTs: messageTs,
    });
    return;
  }

  let sourceText: string | undefined;
  let threadTs = messageTs;
  try {
    const sourceMessage = await fetchSingleMessage(client, channelId, messageTs);
    sourceText = readSlackMessageText(sourceMessage);
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
    await notifyModelFallback({
      channelId,
      client,
      logger,
      route,
      threadTs,
      translator,
      userId: readString(event, "user") ?? "unknown",
    });
    if (sourceText === undefined || sourceText.trim() === "") {
      await client.chat.postMessage({
        channel: channelId,
        text: translator.t("slack.error.unreadableReaction"),
        thread_ts: threadTs,
      });
      return;
    }
    await setSlackAssistantThreadStatus({
      channelId,
      client,
      logger,
      translator,
      threadTs,
    });
    const result = await runner.runStructured(
      {
        channelId,
        messageTs,
        modelId: route?.modelId,
        reasoningEffort: route?.reasoningEffort,
        teamId,
        text:
          `Translate the following Slack message to ${targetLanguage}.\n` +
          "Return only the structured translation result. Preserve Slack mentions, URLs, emoji, and code blocks where possible.\n\n" +
          sourceText,
        threadTs,
        userId: readString(event, "user") ?? "unknown",
        viewerContextChannelIds: [channelId],
      },
      TRANSLATION_RESULT_RESPONSE_FORMAT,
    );
    const translationResult = translationResultSchema.parse(result.structuredOutput);
    text = translationResult.translatedText;
    logStructuredAgentRunnerSuccess(logger, {
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
    text = translator.t("slack.error.translation");
  }

  await client.chat.postMessage({
    channel: channelId,
    text,
    thread_ts: threadTs,
  });
}

function isSupportedFollowUpMessage(event: StringIndexed, threadTs: string | undefined): boolean {
  if (typeof event.bot_id === "string") {
    return false;
  }
  if (isRecord(event.bot_profile)) {
    return false;
  }
  const subtype = readString(event, "subtype");
  if (!isThreadHistoryConversationSubtype(subtype)) {
    return false;
  }
  if (threadTs === undefined || threadTs === event.ts) {
    return false;
  }
  return (readString(event, "text") ?? "").trim() !== "" || hasSlackAudioFiles(event);
}

async function readThreadMessages(
  client: SlackAgentClient,
  channelId: string,
  threadTs: string,
): Promise<StringIndexed[]> {
  try {
    const response = await client.conversations.replies({
      channel: channelId,
      include_all_metadata: true,
      limit: 20,
      ts: threadTs,
    });
    const messages = Array.isArray(response.messages) ? response.messages : [];
    return messages.filter((message): message is StringIndexed => isRecord(message));
  } catch {
    return [];
  }
}

function readThreadHistoryMessages(
  messages: readonly StringIndexed[],
  input: {
    apiAppId?: string;
    botUserId?: string;
    currentMessageTs?: string;
    teamId: string;
  },
): SlackThreadHistoryMessage[] {
  return messages.flatMap((message): SlackThreadHistoryMessage[] => {
    if (shouldExcludeThreadHistoryMessage(message, input)) {
      return [];
    }
    const text = readString(message, "text");
    if (text === undefined || text.trim().length === 0) {
      return [];
    }
    const messageTs = readString(message, "ts");
    const messageTeamId = readSlackMessageTeamId(message) ?? input.teamId;
    const userId = readString(message, "user");
    const botId = readString(message, "bot_id");
    if (
      isAssistantThreadHistoryMessage(message, {
        apiAppId: input.apiAppId,
        botUserId: input.botUserId,
        messageTeamId,
        teamId: input.teamId,
        userId,
      })
    ) {
      return [
        {
          botId,
          messageTs,
          role: "assistant",
          teamId: messageTeamId,
          text,
          userId,
        },
      ];
    }
    if (userId === undefined) {
      return [];
    }
    return [
      {
        messageTs,
        role: "user",
        teamId: messageTeamId,
        text,
        userId,
      },
    ];
  });
}

function shouldExcludeThreadHistoryMessage(
  message: StringIndexed,
  input: {
    botUserId?: string;
    currentMessageTs?: string;
  },
): boolean {
  const messageTs = readString(message, "ts");
  if (messageTs !== undefined && messageTs === input.currentMessageTs) {
    return true;
  }
  const messageType = readString(message, "type");
  if (messageType !== undefined && messageType !== "message") {
    return true;
  }
  if (readSlackMessageMetadataEventType(message) === AGENTS_PARTY_CONTROL_EVENT_TYPE) {
    return true;
  }
  if (containsModelRoutingAction(message)) {
    return true;
  }
  const subtype = readString(message, "subtype");
  return !isThreadHistoryConversationSubtype(subtype);
}

function isThreadHistoryConversationSubtype(subtype: string | undefined): boolean {
  return subtype === undefined || THREAD_HISTORY_CONVERSATION_SUBTYPES.has(subtype);
}

function isAssistantThreadHistoryMessage(
  message: StringIndexed,
  input: {
    apiAppId?: string;
    botUserId?: string;
    messageTeamId: string;
    teamId: string;
    userId?: string;
  },
): boolean {
  if (
    input.botUserId !== undefined &&
    input.userId === input.botUserId &&
    input.messageTeamId === input.teamId
  ) {
    return true;
  }
  if (input.apiAppId === undefined) {
    return false;
  }
  const botProfile = isRecord(message.bot_profile) ? message.bot_profile : undefined;
  return (
    isSlackMessageFromTeam(message, input.teamId) &&
    (readString(message, "app_id") === input.apiAppId ||
      (botProfile !== undefined &&
        readString(botProfile as StringIndexed, "app_id") === input.apiAppId))
  );
}

function isSlackMessageFromTeam(message: StringIndexed, teamId: string): boolean {
  const messageTeamId = readSlackMessageTeamId(message);
  return messageTeamId === undefined || messageTeamId === teamId;
}

function readSlackMessageTeamId(message: StringIndexed): string | undefined {
  const botProfile = isRecord(message.bot_profile) ? message.bot_profile : undefined;
  return (
    readString(message, "team") ??
    (botProfile === undefined ? undefined : readString(botProfile as StringIndexed, "team_id"))
  );
}

function readSlackMessageMetadataEventType(message: StringIndexed): string | undefined {
  const metadata = message.metadata;
  if (!isRecord(metadata)) {
    return undefined;
  }
  return readString(metadata as StringIndexed, "event_type");
}

function containsModelRoutingAction(message: StringIndexed): boolean {
  const blocks = message.blocks;
  if (!Array.isArray(blocks)) {
    return false;
  }
  return blocks.some((block) => blockContainsModelRoutingAction(block));
}

function blockContainsModelRoutingAction(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const actionId = readString(value, "action_id");
  if (
    actionId === MODEL_ROUTING_CONFIGURE_ACTION_ID ||
    actionId === MODEL_ROUTING_CHANNEL_CONFIGURE_ACTION_ID ||
    actionId === MODEL_ROUTING_THREAD_CONFIGURE_ACTION_ID
  ) {
    return true;
  }
  const elements = value.elements;
  if (
    Array.isArray(elements) &&
    elements.some((element) => blockContainsModelRoutingAction(element))
  ) {
    return true;
  }
  const accessory = value.accessory;
  return accessory !== undefined && blockContainsModelRoutingAction(accessory);
}

async function resolveTransientAudioAttachmentsForInvocation(input: {
  client: SlackAgentClient;
  event?: StringIndexed;
  messages: readonly StringIndexed[];
  options: {
    audioFetchFn?: typeof fetch;
    audioTranscriptionGateway?: TranscriptionGateway;
  };
  teamId: string;
}) {
  const messages = mergeSlackMessages(input.messages, input.event);
  return resolveSlackAudioAttachments({
    clientToken: input.client.token,
    fetchFn: input.options.audioFetchFn,
    messages,
    teamId: input.teamId,
    transcriptionGateway: input.options.audioTranscriptionGateway,
  });
}

function mergeSlackMessages(
  messages: readonly StringIndexed[],
  event: StringIndexed | undefined,
): StringIndexed[] {
  const merged = [...messages];
  const fallbackTs = event === undefined ? undefined : readString(event, "ts");
  const hasFallback =
    fallbackTs !== undefined && merged.some((message) => readString(message, "ts") === fallbackTs);
  if (event !== undefined && (!hasFallback || hasSlackAudioFiles(event))) {
    merged.push(event);
  }
  return merged;
}

function runnerUserFacingErrorMessage(error: unknown, translator: Translator): string {
  if (error instanceof SlackAudioProcessingError) {
    return error.message;
  }
  return translator.t("slack.error.genericRequest");
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
  await postFormattedAgentMessage({
    channel: input.channel,
    client: input.client,
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

async function postFormattedAgentMessage(input: {
  channel: string;
  client: SlackAgentClient;
  text: string;
  thread_ts: string;
}): Promise<void> {
  const mrkdwn = markdownToSlackMrkdwn(input.text);
  if (mrkdwn.length > 0 && mrkdwn.length <= SLACK_SECTION_TEXT_LIMIT) {
    await input.client.chat.postMessage({
      blocks: [
        {
          text: {
            text: mrkdwn,
            type: "mrkdwn",
            verbatim: true,
          },
          type: "section",
        },
      ],
      channel: input.channel,
      text: input.text,
      thread_ts: input.thread_ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    return;
  }

  await input.client.chat.postMessage({
    channel: input.channel,
    text: input.text,
    thread_ts: input.thread_ts,
    unfurl_links: false,
    unfurl_media: false,
  });
}

function markdownToSlackMrkdwn(markdown: string): string {
  const tokens = splitCodeFences(markdown);
  return tokens
    .map((token) => (token.kind === "code" ? token.text : markdownTextToSlackMrkdwn(token.text)))
    .join("");
}

function splitCodeFences(markdown: string): { kind: "code" | "text"; text: string }[] {
  const tokens: { kind: "code" | "text"; text: string }[] = [];
  let cursor = 0;
  const fencePattern = /```[\s\S]*?```/g;
  for (const match of markdown.matchAll(fencePattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      tokens.push({ kind: "text", text: markdown.slice(cursor, index) });
    }
    tokens.push({ kind: "code", text: match[0] });
    cursor = index + match[0].length;
  }
  if (cursor < markdown.length) {
    tokens.push({ kind: "text", text: markdown.slice(cursor) });
  }
  return tokens;
}

function markdownTextToSlackMrkdwn(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label: string, url: string) => {
      return `<${escapeSlackMrkdwnUrl(url)}|${escapeSlackMrkdwnLinkLabel(label)}>`;
    })
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/__([^_\n]+)__/g, "_$1_");
}

function escapeSlackMrkdwnUrl(url: string): string {
  return url.replaceAll("&", "&amp;").replaceAll("<", "%3C").replaceAll(">", "%3E");
}

function escapeSlackMrkdwnLinkLabel(label: string): string {
  return label.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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
    teamId: input.teamId,
    threadTs: input.threadTs,
    toolResultCount: input.result.toolResults.length,
  });
}

function logStructuredAgentRunnerSuccess(
  logger: unknown,
  input: {
    channelId: string;
    eventType: "reaction_added";
    messageTs: string;
    result: AgentRunnerStructuredResult;
    teamId: string;
    threadTs: string;
  },
): void {
  logInfo(logger, "TypeScript AgentRunner completed structured Slack event.", {
    channelId: input.channelId,
    eventType: input.eventType,
    hasStructuredResult: true,
    messageTs: input.messageTs,
    modelId: input.result.model?.id,
    provider: input.result.model?.provider,
    teamId: input.teamId,
    threadTs: input.threadTs,
  });
}

function logInfo(logger: unknown, message: string, metadata: Record<string, unknown>): void {
  if (isRecord(logger) && typeof logger.info === "function") {
    logger.info(message, metadata);
  }
}

function logDebug(logger: unknown, message: string, metadata: Record<string, unknown>): void {
  if (isRecord(logger) && typeof logger.debug === "function") {
    logger.debug(message, metadata);
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

async function resolveHandlerTranslator(
  scope: SlackUserSettingsScope,
  userId: string | undefined,
  options: { defaultLocale?: Locale; userSettingsRepository?: UserSettingsRepository },
  logger: unknown,
): Promise<Translator> {
  return resolveUserSettingsTranslator({
    defaultLocale: options.defaultLocale ?? FALLBACK_LOCALE,
    enterpriseId: scope.enterpriseId,
    logger,
    repository: options.userSettingsRepository,
    teamId: scope.teamId,
    userId,
  });
}

async function resolveSlackUserContext(
  client: SlackAgentClient,
  userId: string | undefined,
  translator: Translator,
  logger: unknown,
): Promise<{ isWorkspaceAdmin: boolean; translator: Translator }> {
  const info = client.users?.info;
  if (info === undefined || userId === undefined) {
    return { isWorkspaceAdmin: false, translator };
  }
  try {
    const response = await info({ user: userId });
    const user = isRecord(response) && isRecord(response.user) ? response.user : undefined;
    const isAdmin =
      user !== undefined &&
      (readBoolean(user, "is_admin") === true ||
        readBoolean(user, "is_owner") === true ||
        readBoolean(user, "is_primary_owner") === true);
    return { isWorkspaceAdmin: isAdmin, translator };
  } catch (error) {
    logWarn(logger, "Failed to resolve Slack user context.", {
      error,
      slackUserId: userId,
    });
    return { isWorkspaceAdmin: false, translator };
  }
}

function runnerFailureLogFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof AgentRunnerExecutionError)) {
    return {};
  }
  return {
    modelId: error.model?.id,
    provider: error.model?.provider,
  };
}

function shouldRetryJobFailure(context: SlackAgentJobRetryContext | undefined): boolean {
  if (context === undefined) {
    return false;
  }
  return context.attemptsMade + 1 < context.attempts;
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
  client: SlackAgentClient,
  channelId: string,
  messageTs: string,
): Promise<StringIndexed> {
  const historyResponse = await client.conversations.history({
    channel: channelId,
    inclusive: true,
    latest: messageTs,
    limit: 1,
    oldest: messageTs,
  });
  const historyMessages = Array.isArray(historyResponse.messages) ? historyResponse.messages : [];
  const historyMessage = historyMessages[0];
  if (isRecord(historyMessage)) {
    return historyMessage;
  }
  const repliesResponse = await client.conversations.replies({
    channel: channelId,
    inclusive: true,
    latest: messageTs,
    limit: 1,
    oldest: messageTs,
    ts: messageTs,
  });
  const replyMessages = Array.isArray(repliesResponse.messages) ? repliesResponse.messages : [];
  const replyMessage = replyMessages[0];
  if (!isRecord(replyMessage)) {
    throw new Error("Slack history and replies responses did not contain a message.");
  }
  return replyMessage;
}

function buildWorkspaceCredentialModal(
  scope: SlackUserSettingsScope & { teamId: string },
  providerSelection: WorkspaceCredentialProviderSelection,
  translator: Translator = defaultTranslator,
): Record<string, unknown> {
  const providerKind = providerKindForCredentialSelection(providerSelection);
  return {
    callback_id: WORKSPACE_CREDENTIAL_MODAL_CALLBACK_ID,
    private_metadata: workspaceCredentialPrivateMetadata(scope, translator),
    submit: { text: translator.t("common.save"), type: "plain_text" },
    title: { text: translator.t("credential.title"), type: "plain_text" },
    type: "modal",
    blocks: [
      {
        block_id: WORKSPACE_CREDENTIAL_PROVIDER_BLOCK_ID,
        dispatch_action: true,
        element: {
          action_id: WORKSPACE_CREDENTIAL_PROVIDER_ACTION_ID,
          initial_option: workspaceCredentialProviderOption(providerSelection, translator),
          options: workspaceCredentialProviderOptionsFor(translator),
          type: "static_select",
        },
        label: { text: translator.t("credential.label.provider"), type: "plain_text" },
        type: "input",
      },
      {
        block_id: WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID,
        element: {
          action_id: WORKSPACE_CREDENTIAL_SECRET_ACTION_ID,
          ...(providerSelection === "google_service_account_json" ? { multiline: true } : {}),
          type: "plain_text_input",
        },
        label: {
          text:
            providerSelection === "google_service_account_json"
              ? translator.t("credential.label.serviceAccountJson")
              : providerKind === "soracom"
                ? translator.t("credential.label.authKeySecret")
                : translator.t("credential.label.secret"),
          type: "plain_text",
        },
        type: "input",
      },
      ...workspaceCredentialProviderDetailBlocks(providerSelection, translator),
    ],
  };
}

function workspaceCredentialProviderDetailBlocks(
  providerSelection: WorkspaceCredentialProviderSelection,
  translator: Translator,
): Record<string, unknown>[] {
  const providerKind = providerKindForCredentialSelection(providerSelection);
  if (providerSelection === "google_service_account_json") {
    return [];
  }
  if (providerKind !== "soracom") {
    return [
      {
        block_id: WORKSPACE_CREDENTIAL_BASE_URL_BLOCK_ID,
        element: {
          action_id: WORKSPACE_CREDENTIAL_BASE_URL_ACTION_ID,
          placeholder: { text: "https://proxy.example/v1", type: "plain_text" },
          type: "plain_text_input",
        },
        label: { text: translator.t("credential.label.baseUrl"), type: "plain_text" },
        optional: true,
        type: "input",
      },
    ];
  }
  return [
    {
      block_id: WORKSPACE_CREDENTIAL_SORACOM_AUTH_KEY_ID_BLOCK_ID,
      element: {
        action_id: WORKSPACE_CREDENTIAL_SORACOM_AUTH_KEY_ID_ACTION_ID,
        placeholder: { text: "keyId-xxxxxxxxxx", type: "plain_text" },
        type: "plain_text_input",
      },
      label: { text: translator.t("credential.label.authKeyId"), type: "plain_text" },
      type: "input",
    },
    {
      block_id: WORKSPACE_CREDENTIAL_SORACOM_COVERAGE_BLOCK_ID,
      element: {
        action_id: WORKSPACE_CREDENTIAL_SORACOM_COVERAGE_ACTION_ID,
        initial_option: {
          text: { text: translator.t("credential.option.coverageGlobal"), type: "plain_text" },
          value: "global",
        },
        options: [
          {
            text: { text: translator.t("credential.option.coverageGlobal"), type: "plain_text" },
            value: "global",
          },
          {
            text: { text: translator.t("credential.option.coverageJapan"), type: "plain_text" },
            value: "japan",
          },
        ],
        type: "static_select",
      },
      label: { text: translator.t("credential.label.coverage"), type: "plain_text" },
      type: "input",
    },
    {
      block_id: WORKSPACE_CREDENTIAL_SORACOM_OPERATOR_BLOCK_ID,
      element: {
        action_id: WORKSPACE_CREDENTIAL_SORACOM_OPERATOR_ACTION_ID,
        placeholder: { text: "OP0012345678", type: "plain_text" },
        type: "plain_text_input",
      },
      label: { text: translator.t("credential.label.operatorId"), type: "plain_text" },
      optional: true,
      type: "input",
    },
  ];
}

function workspaceCredentialProviderOption(
  providerSelection: WorkspaceCredentialProviderSelection,
  translator: Translator,
): {
  text: { text: string; type: "plain_text" };
  value: WorkspaceCredentialProviderSelection;
} {
  const options = workspaceCredentialProviderOptionsFor(translator);
  return options.find((option) => option.value === providerSelection) ?? options[0];
}

function workspaceCredentialProviderOptionsFor(translator: Translator): {
  text: { text: string; type: "plain_text" };
  value: WorkspaceCredentialProviderSelection;
}[] {
  return workspaceCredentialProviderOptions.map((option) => ({
    text: {
      text:
        option.value === "google_service_account_json"
          ? translator.t("credential.provider.googleServiceAccount")
          : option.label,
      type: "plain_text",
    },
    value: option.value,
  }));
}

function providerKindForCredentialSelection(
  providerSelection: WorkspaceCredentialProviderSelection,
): CredentialProviderKind {
  return providerSelection === "google_service_account_json" ? "google" : providerSelection;
}

function workspaceCredentialPrivateMetadata(
  scope: SlackUserSettingsScope & { teamId: string },
  translator: Translator,
): string {
  return JSON.stringify({
    enterpriseId: scope.enterpriseId,
    locale: translator.locale,
    teamId: scope.teamId,
  });
}

function buildWorkspaceCredentialSavingModal(
  translator: Translator = defaultTranslator,
): Record<string, unknown> {
  return buildWorkspaceCredentialResultModal(
    translator.t("credential.title.apiKey"),
    translator.t("credential.result.saving"),
    translator,
  );
}

function buildWorkspaceCredentialResultModal(
  title: string,
  text: string,
  translator: Translator = defaultTranslator,
): Record<string, unknown> {
  return {
    close: { text: translator.t("common.close"), type: "plain_text" },
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

function buildWorkspaceCredentialUnavailableModal(
  translator: Translator = defaultTranslator,
): Record<string, unknown> {
  return {
    close: { text: translator.t("common.close"), type: "plain_text" },
    title: { text: translator.t("credential.title.apiKey"), type: "plain_text" },
    type: "modal",
    blocks: [
      {
        text: {
          text: translator.t("credential.unavailable"),
          type: "mrkdwn",
        },
        type: "section",
      },
    ],
  };
}

function salesforcePdfWorkflowEnabledOptionsFor(translator: Translator): {
  text: { text: string; type: "plain_text" };
  value: "false" | "true";
}[] {
  return [
    { text: { text: translator.t("common.disabled"), type: "plain_text" }, value: "false" },
    { text: { text: translator.t("common.enabled"), type: "plain_text" }, value: "true" },
  ];
}

function salesforcePdfWorkflowAttachTargetOptionsFor(translator: Translator): {
  text: { text: string; type: "plain_text" };
  value: SalesforcePdfAttachTarget;
}[] {
  return [
    {
      text: { text: translator.t("salesforcePdf.attachTarget.sourceRecord"), type: "plain_text" },
      value: "source_record",
    },
    {
      text: { text: translator.t("salesforcePdf.attachTarget.quote"), type: "plain_text" },
      value: "quote",
    },
    {
      text: { text: translator.t("salesforcePdf.attachTarget.opportunity"), type: "plain_text" },
      value: "opportunity",
    },
    {
      text: { text: translator.t("salesforcePdf.attachTarget.both"), type: "plain_text" },
      value: "both",
    },
  ];
}

function salesforcePdfWorkflowConfirmationOptionsFor(translator: Translator): {
  text: { text: string; type: "plain_text" };
  value: "false" | "true";
}[] {
  return [
    {
      text: { text: translator.t("salesforcePdf.option.requireConfirmation"), type: "plain_text" },
      value: "true",
    },
    {
      text: {
        text: translator.t("salesforcePdf.option.doNotRequireConfirmation"),
        type: "plain_text",
      },
      value: "false",
    },
  ];
}

function salesforcePdfWorkflowAiSummaryOptionsFor(translator: Translator): {
  text: { text: string; type: "plain_text" };
  value: "false" | "true";
}[] {
  return [
    {
      text: { text: translator.t("salesforcePdf.option.aiSummaryOff"), type: "plain_text" },
      value: "false",
    },
    {
      text: { text: translator.t("salesforcePdf.option.aiSummaryOn"), type: "plain_text" },
      value: "true",
    },
  ];
}

function buildSalesforcePdfWorkflowModal(input: {
  action: SalesforcePdfWorkflowAction;
  enterpriseId?: string;
  salesforceOrgId: string;
  settings?: SalesforcePdfWorkflowSettings;
  teamId: string;
  translator?: Translator;
}): Record<string, unknown> {
  const translator = input.translator ?? defaultTranslator;
  const enabledOptions = salesforcePdfWorkflowEnabledOptionsFor(translator);
  const attachTargetOptions = salesforcePdfWorkflowAttachTargetOptionsFor(translator);
  const confirmationOptions = salesforcePdfWorkflowConfirmationOptionsFor(translator);
  const aiSummaryOptions = salesforcePdfWorkflowAiSummaryOptionsFor(translator);
  const settings = input.settings;
  const enabledOption = enabledOptions.find(
    (option) => option.value === String(settings?.enabled === true),
  );
  const attachTo = settings?.attach_to ?? "source_record";
  const attachOption = attachTargetOptions.find((option) => option.value === attachTo);
  const confirmationOption = confirmationOptions.find(
    (option) => option.value === String(settings?.require_confirmation_before_attach !== false),
  );
  const aiSummaryOption = aiSummaryOptions.find(
    (option) => option.value === String(settings?.include_ai_summary === true),
  );
  return {
    callback_id: SALESFORCE_PDF_WORKFLOW_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify({
      action: input.action,
      enterpriseId: input.enterpriseId,
      locale: translator.locale,
      salesforceOrgId: input.salesforceOrgId,
      teamId: input.teamId,
    }),
    submit: { text: translator.t("common.save"), type: "plain_text" },
    title: { text: translator.t("salesforcePdf.title"), type: "plain_text" },
    type: "modal",
    blocks: [
      {
        block_id: SALESFORCE_PDF_WORKFLOW_ENABLED_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_ENABLED_ACTION_ID,
          initial_option: enabledOption ?? enabledOptions[0],
          options: enabledOptions,
          type: "static_select",
        },
        label: { text: salesforcePdfWorkflowActionLabel(input.action), type: "plain_text" },
        type: "input",
      },
      {
        block_id: SALESFORCE_PDF_WORKFLOW_TEMPLATE_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_TEMPLATE_ACTION_ID,
          initial_value: settings?.template_id,
          placeholder: { text: `${input.action}_v1`, type: "plain_text" },
          type: "plain_text_input",
        },
        label: { text: translator.t("salesforcePdf.label.templateId"), type: "plain_text" },
        type: "input",
      },
      {
        block_id: SALESFORCE_PDF_WORKFLOW_ALLOWED_STAGES_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_ALLOWED_STAGES_ACTION_ID,
          initial_value: settings?.allowed_stages.join(", "),
          placeholder: { text: "Proposal, Negotiation", type: "plain_text" },
          type: "plain_text_input",
        },
        label: { text: translator.t("salesforcePdf.label.allowedStages"), type: "plain_text" },
        optional: true,
        type: "input",
      },
      {
        block_id: SALESFORCE_PDF_WORKFLOW_ALLOWED_STATUSES_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_ALLOWED_STATUSES_ACTION_ID,
          initial_value: settings?.allowed_statuses.join(", "),
          placeholder: { text: "Approved, Presented", type: "plain_text" },
          type: "plain_text_input",
        },
        label: { text: translator.t("salesforcePdf.label.allowedStatuses"), type: "plain_text" },
        optional: true,
        type: "input",
      },
      ...(input.action === "deal_review_pack"
        ? [
            {
              block_id: SALESFORCE_PDF_WORKFLOW_APPROVAL_FIELD_BLOCK_ID,
              element: {
                action_id: SALESFORCE_PDF_WORKFLOW_APPROVAL_FIELD_ACTION_ID,
                initial_value: settings?.approval_status_field ?? undefined,
                placeholder: { text: "Approval_Status__c", type: "plain_text" },
                type: "plain_text_input",
              },
              label: {
                text: translator.t("salesforcePdf.label.approvalStatusField"),
                type: "plain_text",
              },
              optional: true,
              type: "input",
            },
            {
              block_id: SALESFORCE_PDF_WORKFLOW_APPROVAL_STATUSES_BLOCK_ID,
              element: {
                action_id: SALESFORCE_PDF_WORKFLOW_APPROVAL_STATUSES_ACTION_ID,
                initial_value: settings?.allowed_approval_statuses.join(", "),
                placeholder: { text: "Approved, Accepted", type: "plain_text" },
                type: "plain_text_input",
              },
              label: {
                text: translator.t("salesforcePdf.label.allowedApprovalStatuses"),
                type: "plain_text",
              },
              optional: true,
              type: "input",
            },
            {
              block_id: SALESFORCE_PDF_WORKFLOW_AI_SUMMARY_BLOCK_ID,
              element: {
                action_id: SALESFORCE_PDF_WORKFLOW_AI_SUMMARY_ACTION_ID,
                initial_option: aiSummaryOption ?? aiSummaryOptions[0],
                options: aiSummaryOptions,
                type: "static_select",
              },
              label: { text: translator.t("salesforcePdf.label.aiSummary"), type: "plain_text" },
              type: "input",
            },
          ]
        : []),
      {
        block_id: SALESFORCE_PDF_WORKFLOW_REQUIRED_FIELDS_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_REQUIRED_FIELDS_ACTION_ID,
          initial_value: settings?.required_fields.join(", "),
          placeholder: { text: "AccountId, Amount, CloseDate", type: "plain_text" },
          type: "plain_text_input",
        },
        label: { text: translator.t("salesforcePdf.label.requiredFields"), type: "plain_text" },
        optional: true,
        type: "input",
      },
      {
        block_id: SALESFORCE_PDF_WORKFLOW_RECORD_TYPES_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_RECORD_TYPES_ACTION_ID,
          initial_value:
            settings === undefined
              ? undefined
              : [...settings.allowed_record_type_names, ...settings.allowed_record_type_ids].join(
                  ", ",
                ),
          placeholder: { text: "New Business, Renewal", type: "plain_text" },
          type: "plain_text_input",
        },
        label: {
          text: translator.t("salesforcePdf.label.allowedRecordTypes"),
          type: "plain_text",
        },
        optional: true,
        type: "input",
      },
      {
        block_id: SALESFORCE_PDF_WORKFLOW_ATTACH_TO_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_ATTACH_TO_ACTION_ID,
          initial_option: attachOption ?? attachTargetOptions[0],
          options: attachTargetOptions,
          type: "static_select",
        },
        label: { text: translator.t("salesforcePdf.label.attachTo"), type: "plain_text" },
        type: "input",
      },
      {
        block_id: SALESFORCE_PDF_WORKFLOW_CONFIRMATION_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_CONFIRMATION_ACTION_ID,
          initial_option: confirmationOption ?? confirmationOptions[0],
          options: confirmationOptions,
          type: "static_select",
        },
        label: { text: translator.t("salesforcePdf.label.confirmation"), type: "plain_text" },
        type: "input",
      },
      {
        block_id: SALESFORCE_PDF_WORKFLOW_FIELD_MAPPING_BLOCK_ID,
        element: {
          action_id: SALESFORCE_PDF_WORKFLOW_FIELD_MAPPING_ACTION_ID,
          initial_value:
            settings === undefined || Object.keys(settings.field_mapping).length === 0
              ? undefined
              : JSON.stringify(settings.field_mapping, null, 2),
          multiline: true,
          placeholder: { text: '{"customerName":"Account.Name"}', type: "plain_text" },
          type: "plain_text_input",
        },
        label: { text: translator.t("salesforcePdf.label.fieldMapping"), type: "plain_text" },
        optional: true,
        type: "input",
      },
    ],
  };
}

function buildSalesforcePdfWorkflowResultModal(
  title: string,
  text: string,
  translator: Translator = defaultTranslator,
): Record<string, unknown> {
  return {
    close: { text: translator.t("common.close"), type: "plain_text" },
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

async function updateSalesforcePdfWorkflowModal(
  client: SlackClient,
  view: unknown,
  modal: Record<string, unknown>,
  logger: unknown,
): Promise<void> {
  const viewId = isRecord(view) ? readString(view, "id") : undefined;
  if (viewId === undefined) {
    logWarn(logger, "Could not update Salesforce PDF workflow modal without Slack view id.", {});
    return;
  }
  try {
    await client.views.update({
      view: modal as never,
      view_id: viewId,
    });
  } catch (error) {
    logWarn(logger, "Failed to update Salesforce PDF workflow modal.", { error, viewId });
  }
}

async function updateWorkspaceCredentialModal(
  client: SlackClient,
  view: unknown,
  modal: Record<string, unknown>,
  logger: unknown,
): Promise<void> {
  const viewId = isRecord(view) ? readString(view, "id") : undefined;
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

function parseWorkspaceCredentialModal(
  view: unknown,
  translator: Translator = defaultTranslator,
):
  | {
      apiKey: string;
      baseURL?: string;
      credentialName?: string;
      payload: JsonObject;
      providerKind: CredentialProviderKind;
    }
  | { errors: Record<string, string> } {
  const providerValue = readSelectedOptionValue(
    view,
    WORKSPACE_CREDENTIAL_PROVIDER_BLOCK_ID,
    WORKSPACE_CREDENTIAL_PROVIDER_ACTION_ID,
  );
  const providerSelection = parseWorkspaceCredentialProviderSelection(providerValue);
  const providerKind =
    providerSelection === undefined
      ? undefined
      : providerKindForCredentialSelection(providerSelection);
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
  const soracomAuthKeyId = readModalInputValue(
    view,
    WORKSPACE_CREDENTIAL_SORACOM_AUTH_KEY_ID_BLOCK_ID,
    WORKSPACE_CREDENTIAL_SORACOM_AUTH_KEY_ID_ACTION_ID,
  )?.trim();
  const soracomCoverage = readSelectedOptionValue(
    view,
    WORKSPACE_CREDENTIAL_SORACOM_COVERAGE_BLOCK_ID,
    WORKSPACE_CREDENTIAL_SORACOM_COVERAGE_ACTION_ID,
  );
  const soracomOperatorId = readModalInputValue(
    view,
    WORKSPACE_CREDENTIAL_SORACOM_OPERATOR_BLOCK_ID,
    WORKSPACE_CREDENTIAL_SORACOM_OPERATOR_ACTION_ID,
  )?.trim();
  const errors: Record<string, string> = {};
  if (providerKind === undefined) {
    errors[WORKSPACE_CREDENTIAL_PROVIDER_BLOCK_ID] = translator.t(
      "credential.error.chooseProvider",
    );
  }
  if (apiKey === undefined || apiKey === "") {
    errors[WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID] =
      providerSelection === "google_service_account_json"
        ? translator.t("credential.error.serviceAccountJsonRequired")
        : providerKind === "soracom"
          ? translator.t("credential.error.authKeySecretRequired")
          : translator.t("credential.error.apiKeyRequired");
  }
  const googleServiceAccount =
    providerSelection === "google_service_account_json"
      ? parseGoogleServiceAccountCredentialJson(apiKey)
      : undefined;
  if (
    providerSelection === "google_service_account_json" &&
    apiKey !== undefined &&
    apiKey !== "" &&
    googleServiceAccount === undefined
  ) {
    errors[WORKSPACE_CREDENTIAL_SECRET_BLOCK_ID] = translator.t(
      "credential.error.invalidServiceAccountJson",
    );
  }
  if (providerKind === "soracom") {
    if (soracomAuthKeyId === undefined || soracomAuthKeyId === "") {
      errors[WORKSPACE_CREDENTIAL_SORACOM_AUTH_KEY_ID_BLOCK_ID] = translator.t(
        "credential.error.authKeyIdRequired",
      );
    }
    if (soracomCoverage !== "global" && soracomCoverage !== "japan") {
      errors[WORKSPACE_CREDENTIAL_SORACOM_COVERAGE_BLOCK_ID] = translator.t(
        "credential.error.chooseCoverage",
      );
    }
  }
  if (
    providerKind !== "soracom" &&
    baseURL !== undefined &&
    baseURL !== "" &&
    !isHttpUrl(baseURL)
  ) {
    errors[WORKSPACE_CREDENTIAL_BASE_URL_BLOCK_ID] = translator.t(
      "credential.error.invalidBaseUrl",
    );
  }
  if (Object.keys(errors).length > 0) {
    return { errors };
  }
  if (providerKind === "soracom") {
    return {
      apiKey: apiKey as string,
      credentialName: "auth_key",
      payload: {
        auth_key_id: soracomAuthKeyId as string,
        coverage_type: soracomCoverage as "global" | "japan",
        ...(soracomOperatorId === undefined || soracomOperatorId === ""
          ? {}
          : { operator_id: soracomOperatorId }),
        source: "slack_app_home",
      },
      providerKind,
    };
  }
  if (providerSelection === "google_service_account_json") {
    return {
      apiKey: apiKey as string,
      credentialName: "service_account_json",
      payload: {
        ...(googleServiceAccount?.project_id === undefined
          ? {}
          : { project_id: googleServiceAccount.project_id }),
        source: "slack_app_home",
      },
      providerKind: "google",
    };
  }
  return {
    apiKey: apiKey as string,
    baseURL: baseURL === undefined || baseURL === "" ? undefined : baseURL,
    payload: {
      ...(baseURL === undefined || baseURL === "" ? {} : { base_url: baseURL }),
      source: "slack_app_home",
    },
    providerKind: providerKind as CredentialProviderKind,
  };
}

function parseSalesforcePdfWorkflowModal(
  view: unknown,
  translator: Translator = defaultTranslator,
):
  | {
      allowedRecordTypeIds: string[];
      allowedRecordTypeNames: string[];
      allowedApprovalStatuses: string[];
      allowedStages: string[];
      allowedStatuses: string[];
      approvalStatusField: string | null;
      attachTo: SalesforcePdfAttachTarget;
      enabled: boolean;
      fieldMapping: Record<string, string>;
      includeAiSummary: boolean;
      requiredFields: string[];
      requireConfirmationBeforeAttach: boolean;
      templateId: string;
    }
  | { errors: Record<string, string> } {
  const enabled = parseBooleanOption(
    readSelectedOptionValue(
      view,
      SALESFORCE_PDF_WORKFLOW_ENABLED_BLOCK_ID,
      SALESFORCE_PDF_WORKFLOW_ENABLED_ACTION_ID,
    ),
  );
  const templateId = readModalInputValue(
    view,
    SALESFORCE_PDF_WORKFLOW_TEMPLATE_BLOCK_ID,
    SALESFORCE_PDF_WORKFLOW_TEMPLATE_ACTION_ID,
  )?.trim();
  const attachToValue = readSelectedOptionValue(
    view,
    SALESFORCE_PDF_WORKFLOW_ATTACH_TO_BLOCK_ID,
    SALESFORCE_PDF_WORKFLOW_ATTACH_TO_ACTION_ID,
  );
  const attachTo = salesforcePdfAttachTargetSchema.safeParse(attachToValue);
  const requireConfirmationBeforeAttach = parseBooleanOption(
    readSelectedOptionValue(
      view,
      SALESFORCE_PDF_WORKFLOW_CONFIRMATION_BLOCK_ID,
      SALESFORCE_PDF_WORKFLOW_CONFIRMATION_ACTION_ID,
    ),
  );
  const includeAiSummary = parseBooleanOption(
    readSelectedOptionValue(
      view,
      SALESFORCE_PDF_WORKFLOW_AI_SUMMARY_BLOCK_ID,
      SALESFORCE_PDF_WORKFLOW_AI_SUMMARY_ACTION_ID,
    ) ?? "false",
  );
  const fieldMapping = parseFieldMapping(
    readModalInputValue(
      view,
      SALESFORCE_PDF_WORKFLOW_FIELD_MAPPING_BLOCK_ID,
      SALESFORCE_PDF_WORKFLOW_FIELD_MAPPING_ACTION_ID,
    ),
    translator,
  );
  const errors: Record<string, string> = {};
  if (enabled === undefined) {
    errors[SALESFORCE_PDF_WORKFLOW_ENABLED_BLOCK_ID] = translator.t(
      "salesforcePdf.error.enabledRequired",
    );
  }
  if (templateId === undefined || templateId === "") {
    errors[SALESFORCE_PDF_WORKFLOW_TEMPLATE_BLOCK_ID] = translator.t(
      "salesforcePdf.error.templateRequired",
    );
  }
  if (!attachTo.success) {
    errors[SALESFORCE_PDF_WORKFLOW_ATTACH_TO_BLOCK_ID] = translator.t(
      "salesforcePdf.error.attachTargetRequired",
    );
  }
  if (requireConfirmationBeforeAttach === undefined) {
    errors[SALESFORCE_PDF_WORKFLOW_CONFIRMATION_BLOCK_ID] = translator.t(
      "salesforcePdf.error.confirmationRequired",
    );
  }
  if (includeAiSummary === undefined) {
    errors[SALESFORCE_PDF_WORKFLOW_AI_SUMMARY_BLOCK_ID] = translator.t(
      "salesforcePdf.error.summaryRequired",
    );
  }
  if ("error" in fieldMapping) {
    errors[SALESFORCE_PDF_WORKFLOW_FIELD_MAPPING_BLOCK_ID] = fieldMapping.error;
  }
  if (Object.keys(errors).length > 0) {
    return { errors };
  }
  const recordTypes = parseCsvList(
    readModalInputValue(
      view,
      SALESFORCE_PDF_WORKFLOW_RECORD_TYPES_BLOCK_ID,
      SALESFORCE_PDF_WORKFLOW_RECORD_TYPES_ACTION_ID,
    ),
  );
  return {
    allowedRecordTypeIds: recordTypes.filter((value) => /^012[A-Za-z0-9]{12,15}$/u.test(value)),
    allowedRecordTypeNames: recordTypes.filter((value) => !/^012[A-Za-z0-9]{12,15}$/u.test(value)),
    allowedApprovalStatuses: parseCsvList(
      readModalInputValue(
        view,
        SALESFORCE_PDF_WORKFLOW_APPROVAL_STATUSES_BLOCK_ID,
        SALESFORCE_PDF_WORKFLOW_APPROVAL_STATUSES_ACTION_ID,
      ),
    ),
    allowedStages: parseCsvList(
      readModalInputValue(
        view,
        SALESFORCE_PDF_WORKFLOW_ALLOWED_STAGES_BLOCK_ID,
        SALESFORCE_PDF_WORKFLOW_ALLOWED_STAGES_ACTION_ID,
      ),
    ),
    allowedStatuses: parseCsvList(
      readModalInputValue(
        view,
        SALESFORCE_PDF_WORKFLOW_ALLOWED_STATUSES_BLOCK_ID,
        SALESFORCE_PDF_WORKFLOW_ALLOWED_STATUSES_ACTION_ID,
      ),
    ),
    approvalStatusField:
      readModalInputValue(
        view,
        SALESFORCE_PDF_WORKFLOW_APPROVAL_FIELD_BLOCK_ID,
        SALESFORCE_PDF_WORKFLOW_APPROVAL_FIELD_ACTION_ID,
      )?.trim() || null,
    attachTo: attachTo.data as SalesforcePdfAttachTarget,
    enabled: enabled as boolean,
    fieldMapping: "value" in fieldMapping ? fieldMapping.value : {},
    includeAiSummary: includeAiSummary as boolean,
    requiredFields: parseCsvList(
      readModalInputValue(
        view,
        SALESFORCE_PDF_WORKFLOW_REQUIRED_FIELDS_BLOCK_ID,
        SALESFORCE_PDF_WORKFLOW_REQUIRED_FIELDS_ACTION_ID,
      ),
    ),
    requireConfirmationBeforeAttach: requireConfirmationBeforeAttach as boolean,
    templateId: templateId as string,
  };
}

function parseExistingSalesforcePdfWorkflowSetting(
  payload: JsonObject | undefined,
): SalesforcePdfWorkflowSettings | undefined {
  if (payload === undefined) {
    return undefined;
  }
  const parsed = salesforcePdfWorkflowSettingsSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

function parseFieldMapping(
  raw: string | undefined,
  translator: Translator = defaultTranslator,
): { value: Record<string, string> } | { error: string } {
  const text = raw?.trim();
  if (text === undefined || text === "") {
    return { value: {} };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return { error: translator.t("salesforcePdf.error.fieldMappingObject") };
    }
    const mapping: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string" || key.trim() === "" || value.trim() === "") {
        return { error: translator.t("salesforcePdf.error.fieldMappingStringValues") };
      }
      mapping[key.trim()] = value.trim();
    }
    return { value: mapping };
  } catch {
    return { error: translator.t("salesforcePdf.error.fieldMappingJson") };
  }
}

function parseCsvList(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function parseBooleanOption(value: string | undefined): boolean | undefined {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
}

function parseWorkspaceCredentialProviderSelection(
  value: string | undefined,
): WorkspaceCredentialProviderSelection | undefined {
  return workspaceCredentialProviderOptions.find((option) => option.value === value)?.value;
}

function parseWorkspaceCredentialModalMetadata(
  value: string | undefined,
): { enterpriseId?: string; locale?: Locale; teamId: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return value.trim() === "" ? undefined : { teamId: value };
    }
    const teamId = readOptionalString(parsed.teamId);
    const enterpriseId = readOptionalString(parsed.enterpriseId);
    return teamId === undefined
      ? undefined
      : {
          enterpriseId,
          locale: normalizeLocale(readOptionalString(parsed.locale)),
          teamId,
        };
  } catch {
    return value.trim() === "" ? undefined : { teamId: value };
  }
}

function parseGoogleServiceAccountCredentialJson(
  value: string | undefined,
): { project_id?: string } | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const clientEmail = readString(parsed, "client_email");
  const privateKey = readString(parsed, "private_key");
  if (clientEmail === undefined || privateKey === undefined) {
    return undefined;
  }
  return { project_id: readString(parsed, "project_id") };
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

function readSlackApiAppId(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  return readString(body as StringIndexed, "api_app_id");
}

function readActionValue(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.actions)) {
    return undefined;
  }
  const [action] = body.actions;
  return isRecord(action) && typeof action.value === "string" ? action.value : undefined;
}

function parseSalesforcePdfWorkflowActionValue(
  value: string | undefined,
): { action: SalesforcePdfWorkflowAction; salesforceOrgId: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    const action = parseSalesforcePdfWorkflowAction(readOptionalString(parsed.action));
    const salesforceOrgId = readOptionalString(parsed.salesforceOrgId);
    return action === undefined || salesforceOrgId === undefined
      ? undefined
      : { action, salesforceOrgId };
  } catch {
    return undefined;
  }
}

function parseSalesforcePdfWorkflowModalMetadata(value: string | undefined):
  | {
      action: SalesforcePdfWorkflowAction;
      enterpriseId?: string;
      locale?: Locale;
      salesforceOrgId: string;
      teamId: string;
    }
  | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    const action = parseSalesforcePdfWorkflowAction(readOptionalString(parsed.action));
    const enterpriseId = readOptionalString(parsed.enterpriseId);
    const locale = normalizeLocale(readOptionalString(parsed.locale));
    const salesforceOrgId = readOptionalString(parsed.salesforceOrgId);
    const teamId = readOptionalString(parsed.teamId);
    return action === undefined || salesforceOrgId === undefined || teamId === undefined
      ? undefined
      : { action, enterpriseId, locale, salesforceOrgId, teamId };
  } catch {
    return undefined;
  }
}

function parseSalesforcePdfWorkflowAction(
  value: string | undefined,
): SalesforcePdfWorkflowAction | undefined {
  return salesforcePdfWorkflowActions.find((action) => action === value);
}

function salesforcePdfWorkflowPayload(settings: SalesforcePdfWorkflowSettings): JsonObject {
  return {
    action: settings.action,
    allowed_approval_statuses: settings.allowed_approval_statuses,
    allowed_record_type_ids: settings.allowed_record_type_ids,
    allowed_record_type_names: settings.allowed_record_type_names,
    allowed_stages: settings.allowed_stages,
    allowed_statuses: settings.allowed_statuses,
    approval_status_field: settings.approval_status_field ?? null,
    attach_to: settings.attach_to,
    created_at: settings.created_at.toISOString(),
    enabled: settings.enabled,
    enabled_at: settings.enabled_at?.toISOString() ?? null,
    enabled_by_slack_user_id: settings.enabled_by_slack_user_id ?? null,
    field_mapping: settings.field_mapping,
    include_ai_summary: settings.include_ai_summary,
    record_type_field: settings.record_type_field ?? null,
    required_fields: settings.required_fields,
    require_confirmation_before_attach: settings.require_confirmation_before_attach,
    salesforce_org_id: settings.salesforce_org_id,
    slack_channel_allowlist: settings.slack_channel_allowlist,
    slack_user_group_allowlist: settings.slack_user_group_allowlist,
    status_field: settings.status_field ?? null,
    stage_field: settings.stage_field ?? null,
    team_id: settings.team_id,
    template_id: settings.template_id,
    updated_at: settings.updated_at.toISOString(),
    updated_by_slack_user_id: settings.updated_by_slack_user_id ?? null,
  };
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

function readSelectedOptionValues(view: unknown, blockId: string, actionId: string): string[] {
  const element = readModalElement(view, blockId, actionId);
  const options =
    isRecord(element) && Array.isArray(element.selected_options) ? element.selected_options : [];
  return options
    .map((option) => (isRecord(option) && typeof option.value === "string" ? option.value : ""))
    .filter((value) => value.length > 0);
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

function threadScopedModelId(route: SlackResolvedAgentRoute | undefined): string | undefined {
  return route?.modelScope === "thread" ? route.modelId : undefined;
}

function threadScopedReasoningEffort(
  route: SlackResolvedAgentRoute | undefined,
): string | undefined {
  return route?.modelScope === "thread" ? route.reasoningEffort : undefined;
}

function stringField(value: JsonObject | undefined, field: string): string | undefined {
  const fieldValue = value?.[field];
  return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : undefined;
}

function booleanField(value: JsonObject | undefined, field: string): boolean | undefined {
  const fieldValue = value?.[field];
  return typeof fieldValue === "boolean" ? fieldValue : undefined;
}

function stringArrayField(value: JsonObject | undefined, field: string): string[] {
  const fieldValue = value?.[field];
  return Array.isArray(fieldValue)
    ? fieldValue.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
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
    return stripMentionOnlyText(text);
  }
  return stripMentionOnlyText(
    text.replace(new RegExp(`<@${escapeRegExp(botUserId)}>\\s*`, "gu"), "").trim(),
  );
}

function isMentionOnlyText(text: string, botUserId: string | undefined): boolean {
  return text.trim().length > 0 && stripBotMention(text, botUserId).length === 0;
}

function stripMentionOnlyText(text: string): string {
  const trimmed = text.trim();
  return trimmed.replace(/<@[A-Z0-9]+>\s*/gu, "").trim().length === 0 ? "" : trimmed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function readString(value: StringIndexed, field: string): string | undefined {
  const fieldValue = value[field];
  return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : undefined;
}

function readSlackMessageText(message: StringIndexed): string | undefined {
  return firstNonEmptyText([
    readString(message, "text"),
    readSlackBlocksText(message.blocks),
    readSlackAttachmentsText(message.attachments),
  ]);
}

function readSlackBlocksText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return joinNonEmptyLines(value.flatMap((block) => readSlackBlockTextParts(block)));
}

function readSlackBlockTextParts(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  return [
    readSlackTextObjectText(value.text),
    ...(Array.isArray(value.fields)
      ? value.fields.map((field) => readSlackTextObjectText(field))
      : []),
    ...(Array.isArray(value.elements)
      ? value.elements.map((element) => readSlackBlockElementText(element))
      : []),
  ].filter((text): text is string => text !== undefined);
}

function readSlackBlockElementText(value: unknown): string | undefined {
  return readSlackTextObjectText(value) ?? readSlackRichTextElementText(value);
}

function readSlackRichTextElementText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const type = readOptionalString(value.type);
  const text = readOptionalString(value.text);
  if (type === "text" && text !== undefined) {
    return text;
  }
  if (type === "link") {
    const url = readOptionalString(value.url);
    if (url === undefined) {
      return text;
    }
    return text === undefined ? url : `<${url}|${text}>`;
  }
  if (type === "emoji") {
    const name = readOptionalString(value.name);
    return name === undefined ? undefined : `:${name}:`;
  }
  if (type === "user") {
    const userId = readOptionalString(value.user_id);
    return userId === undefined ? undefined : `<@${userId}>`;
  }
  if (type === "channel") {
    const channelId = readOptionalString(value.channel_id);
    return channelId === undefined ? undefined : `<#${channelId}>`;
  }
  if (type === "usergroup") {
    const usergroupId = readOptionalString(value.usergroup_id);
    return usergroupId === undefined ? undefined : `<!subteam^${usergroupId}>`;
  }
  if (type === "broadcast") {
    const range = readOptionalString(value.range);
    return range === undefined ? undefined : `<!${range}>`;
  }
  if (type === "date") {
    const timestamp = readOptionalString(value.timestamp);
    const format = readOptionalString(value.format);
    const fallback = readOptionalString(value.fallback);
    if (timestamp === undefined || format === undefined) {
      return fallback;
    }
    return fallback === undefined
      ? `<!date^${timestamp}^${format}>`
      : `<!date^${timestamp}^${format}|${fallback}>`;
  }
  if (Array.isArray(value.elements)) {
    const separator = type === "rich_text_section" ? "" : "\n";
    const joined = value.elements
      .map((element) => readSlackBlockElementText(element))
      .filter((part): part is string => part !== undefined && part !== "")
      .join(separator);
    return joined === "" ? undefined : joined;
  }
  return undefined;
}

function readSlackAttachmentsText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return joinNonEmptyLines(
    value.flatMap((attachment) => {
      if (!isRecord(attachment)) {
        return [];
      }
      return [
        readSlackTextObjectText(attachment.text) ?? readOptionalString(attachment.text),
        readSlackTextObjectText(attachment.pretext) ?? readOptionalString(attachment.pretext),
        ...(Array.isArray(attachment.blocks)
          ? attachment.blocks.flatMap((block) => readSlackBlockTextParts(block))
          : []),
      ].filter((text): text is string => text !== undefined);
    }),
  );
}

function readSlackTextObjectText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return readOptionalString(value.text);
}

function firstNonEmptyText(values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "");
}

function joinNonEmptyLines(values: readonly (string | undefined)[]): string | undefined {
  const text = values
    .map((value) => value?.trim())
    .filter((value): value is string => value !== undefined && value !== "")
    .join("\n");
  return text === "" ? undefined : text;
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
