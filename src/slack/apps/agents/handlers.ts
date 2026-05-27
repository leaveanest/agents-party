import type {
  AllMiddlewareArgs,
  SayStreamFn,
  SlackActionMiddlewareArgs,
  SlackEventMiddlewareArgs,
  SlackViewMiddlewareArgs,
  StringIndexed,
} from "@slack/bolt";
import { ErrorCode } from "@slack/web-api";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  AgentRunnerExecutionError,
  type AgentRunner,
  type AgentRunnerResult,
  type AgentRunnerRuntimeOptions,
  type AgentRunnerStreamEvent,
  type AgentRunnerStructuredResult,
} from "../../../agents/runner.js";
import type { JsonValue } from "../../../domain/messageHistory.js";
import { normalizeRssFeedUrl, type RssFeedSubscription } from "../../../domain/rssFeeds.js";
import {
  FALLBACK_LOCALE,
  createTranslator,
  defaultTranslator,
  normalizeLocale,
  type Locale,
  type Translator,
} from "../../../i18n/index.js";
import type { CredentialProviderKind } from "../../../providers/credentials.js";
import {
  LlmReasoningEffortId,
  llmProviders,
  type ModelInfo,
  type LlmResponseFormat,
  type LlmProvider,
  type LlmReasoningEffort,
} from "../../../providers/contracts.js";
import {
  modelDefaultReasoningEffort,
  normalizeReasoningEffort,
  supportedReasoningEffortsForModel,
} from "../../../providers/reasoningOptions.js";
import {
  salesforceAuthConfigSchema,
  salesforceConnectionSchema,
} from "../../../integrations/oauth/domain.js";
import {
  salesforcePdfAttachTargetSchema,
  salesforcePdfWorkflowActionLabel,
  salesforcePdfWorkflowActions,
  salesforcePdfWorkflowSettingsSchema,
  type SalesforcePdfAttachTarget,
  type SalesforcePdfWorkflowAction,
  type SalesforcePdfWorkflowSettings,
} from "../../../domain/salesforcePdfWorkflows.js";
import type { JsonObject } from "../../../infrastructure/postgres/jsonDocumentRepository.js";
import { validateRssFeedUrl } from "../../../infrastructure/rss/rssFeedValidator.js";
import type { RssUrlHostnameResolver } from "../../../infrastructure/rss/rssUrlSafety.js";
import { createDefaultModelRegistry } from "../../../providers/modelRegistry.js";
import type { TranscriptionGateway } from "../../../providers/transcriptionGateway.js";
import type { SlackAgentJob, SlackAgentJobQueue } from "../../../queues/slackAgentJobs.js";
import type { RssFeedRepository } from "../../../repositories/rssFeeds.js";
import type { UserSettingsRepository } from "../../../repositories/userSettings.js";
import type { WorkspaceFeatureSettingsRepository } from "../../../repositories/workspaceFeatureSettings.js";
import {
  SlackAudioProcessingError,
  hasSlackAudioFiles,
  resolveSlackAudioAttachments,
} from "../../audioTranscription.js";
import {
  SlackImageProcessingError,
  hasSlackImageFiles,
  resolveSlackImageAttachments,
  validateSlackImageAttachments,
} from "../../imageInput.js";
import {
  readSlackEnterpriseId,
  readSlackEnterpriseInstall,
  readTeamId,
  resolveSlackAppHomeContext,
  type SlackAppHomeContext,
} from "../../appHomeContext.js";
import type { SlackEventFeatureHandlers } from "./events.js";
import { readSlackEventId } from "../../idempotency.js";
import {
  FEATURE_SETTINGS_CONFIGURE_ACTION_ID,
  FEATURE_SETTINGS_IMAGE_CHANNELS_ACTION_ID,
  FEATURE_SETTINGS_IMAGE_CHANNELS_BLOCK_ID,
  FEATURE_SETTINGS_IMAGE_DIRECT_MESSAGES_ACTION_ID,
  FEATURE_SETTINGS_IMAGE_DIRECT_MESSAGES_BLOCK_ID,
  FEATURE_SETTINGS_IMAGE_ENABLED_ACTION_ID,
  FEATURE_SETTINGS_IMAGE_ENABLED_BLOCK_ID,
  FEATURE_SETTINGS_IMAGE_MODEL_ACTION_ID,
  FEATURE_SETTINGS_IMAGE_MODEL_BLOCK_ID,
  FEATURE_SETTINGS_MODAL_CALLBACK_ID,
  FEATURE_SETTINGS_TTS_CHANNELS_ACTION_ID,
  FEATURE_SETTINGS_TTS_CHANNELS_BLOCK_ID,
  FEATURE_SETTINGS_TTS_ENABLED_ACTION_ID,
  FEATURE_SETTINGS_TTS_ENABLED_BLOCK_ID,
  FEATURE_SETTINGS_TTS_MODEL_ACTION_ID,
  FEATURE_SETTINGS_TTS_MODEL_BLOCK_ID,
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
  RSS_FEED_CHANNEL_ACTION_ID,
  RSS_FEED_CHANNEL_BLOCK_ID,
  RSS_FEED_DELETE_ACTION_ID,
  RSS_FEED_LIST_ACTION_ID,
  RSS_FEED_LIST_MODAL_CALLBACK_ID,
  RSS_FEED_LIST_NEXT_PAGE_ACTION_ID,
  RSS_FEED_LIST_PREVIOUS_PAGE_ACTION_ID,
  RSS_FEED_LIST_WORKSPACE_SELECT_ACTION_ID,
  RSS_FEED_MODAL_CALLBACK_ID,
  RSS_FEED_PROMPT_ACTION_ID,
  RSS_FEED_PROMPT_BLOCK_ID,
  RSS_FEED_URL_ACTION_ID,
  RSS_FEED_URL_BLOCK_ID,
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
import type { SlackInstalledWorkspace } from "../../installationStore.js";
import { resolveUserSettingsTranslator } from "../../userLocale.js";

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
type FeatureSettingsActionValue = {
  enterpriseId?: string;
  selectedTeamId?: string;
  source?: "app_home";
  teamId?: string;
};
type ValidatedSlackAgentRoute =
  | { reason?: undefined; route: SlackResolvedAgentRoute | undefined; valid: true }
  | {
      reason: "no_enabled_model";
      route?: undefined;
      skippedModelIds: string[];
      valid: false;
    };
type RssFeedActionValue = {
  enterpriseId?: string;
  page?: number;
  selectedTeamId?: string;
  source?: "app_home" | "rss_list";
  subscriptionId?: string;
  teamId?: string;
};

const DEFAULT_AGENT_OPTION = {
  description: "General Slack assistant.",
  displayName: "Assistant",
  id: "assistant",
} as const;
const REASONING_EFFORT_FIELD = "reasoning_effort";
const AGENTS_PARTY_CONTROL_EVENT_TYPE = "agents_party_control";
const AGENTS_SLACK_APP_KEY = "agents";
const SLACK_SECTION_TEXT_LIMIT = 3000;
const RSS_FEED_LIST_PAGE_SIZE = 5;
const RSS_FEED_APP_HOME_FEED_URL_TEXT_LIMIT = 240;
const RSS_FEED_LIST_PROMPT_TEXT_LIMIT = 500;
const SLACK_AGENT_STREAM_BUFFER_SIZE = 128;
const SLACK_THREAD_ATTACHMENT_PAGE_LIMIT = 200;
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
> &
  Partial<Pick<SlackClient, "chatStream">> & {
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
type SlackAgentMessageStream = {
  append(input: { markdown_text: string }): Promise<unknown>;
  stop(input?: unknown): Promise<unknown>;
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

type SlackThreadSaveDocument = {
  agentId?: string;
  channelId: string;
  createdAt: Date;
  lastMessageTs?: string;
  modelId?: string;
  payload: JsonObject;
  reasoningEffort?: string;
  rootMessageTs: string;
  status: string;
  teamId: string;
  threadTs: string;
  updatedAt: Date;
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
  clearChannelModelOverride?(input: {
    channelId: string;
    teamId: string;
    updatedAt: Date;
  }): Promise<void>;
  clearThreadModelOverride?(input: {
    channelId: string;
    teamId: string;
    threadTs: string;
    updatedAt: Date;
  }): Promise<void>;
  resolveAgent?(input: {
    channelId: string;
    teamId: string;
    threadChannelId?: string;
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
  saveSlackThread?(document: SlackThreadSaveDocument): Promise<void>;
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
  resolveProviderCredential?(input: {
    credentialName?: string;
    provider: CredentialProviderKind;
    workspaceId: string;
  }): Promise<unknown>;
  saveProviderApiKey(input: {
    createdByUserId?: string;
    credentialName?: string;
    payload?: JsonObject;
    providerKind: CredentialProviderKind;
    secret: string;
    teamId: string;
  }): Promise<void>;
};

export type RssFeedHome = {
  repository: Pick<
    RssFeedRepository,
    "disableSubscription" | "listEnabledSubscriptions" | "saveSubscription"
  >;
};

export type SlackInstalledWorkspaceDirectory = {
  listInstalledWorkspaces(input: { enterpriseId?: string }): Promise<SlackInstalledWorkspace[]>;
};

export type SlackTeamClientProviderForHandlers = {
  forTeam(input: {
    enterpriseId?: string;
    isEnterpriseInstall?: boolean;
    teamId: string;
  }): Promise<SlackAgentClient>;
};

export type AgentSlackHandlerOptions = {
  agentJobQueue?: SlackAgentJobQueue;
  audioFetchFn?: typeof fetch;
  audioTranscriptionGateway?: TranscriptionGateway;
  defaultLocale?: Locale;
  imageFetchFn?: typeof fetch;
  installedWorkspaceDirectory?: SlackInstalledWorkspaceDirectory;
  featureSettingsHome?: WorkspaceFeatureSettingsHome;
  routingRepository?: SlackAgentRoutingRepository;
  rssFeedFetchFn?: typeof fetch;
  rssFeedResolveHostname?: RssUrlHostnameResolver;
  rssFeedHome?: RssFeedHome;
  salesforceConnectionHome?: SalesforceConnectionHome;
  salesforcePdfWorkflowHome?: SalesforcePdfWorkflowHome;
  slackTeamClients?: SlackTeamClientProviderForHandlers;
  userSettingsRepository?: UserSettingsRepository;
  workspaceCredentialSettings?: WorkspaceCredentialSettingsHome;
};

export type WorkspaceFeatureSettingsHome = {
  imageGenerationModelId: string;
  repository: WorkspaceFeatureSettingsRepository;
  textToSpeechModelId?: string;
};

type SlackAgentJobRetryContext = {
  attempts: number;
  attemptsMade: number;
};

type SlackUserSettingsScope = {
  enterpriseId?: string;
  teamId?: string;
};

const imageGenerationCredentialProviderKinds = ["google", "openai"] as const;
const textToSpeechCredentialProviderKinds = ["openai"] as const;

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
    async handleAssistantThreadContextChanged(args) {
      await handleAssistantThreadEvent(args, options);
    },
    async handleAssistantThreadStarted(args) {
      await handleAssistantThreadEvent(args, options);
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
    async handleFeatureSettingsConfigureAction(args) {
      await handleFeatureSettingsConfigureAction(args, options);
    },
    async handleFeatureSettingsModalSubmission(args) {
      await handleFeatureSettingsModalSubmission(args, options);
    },
    async handleRssFeedConfigureAction(args) {
      await handleRssFeedConfigureAction(args, options);
    },
    async handleRssFeedDeleteAction(args) {
      await handleRssFeedDeleteAction(args, options);
    },
    async handleRssFeedListAction(args) {
      await handleRssFeedListAction(args, options);
    },
    async handleRssFeedListModalSubmission(args) {
      await handleRssFeedListModalSubmission(args, options);
    },
    async handleRssFeedModalSubmission(args) {
      await handleRssFeedModalSubmission(args, options);
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
  blocks.push(...(await buildFeatureSettingsAppHomeBlocks(input)));
  blocks.push(...(await buildRssFeedAppHomeBlocks(input)));
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

async function buildFeatureSettingsAppHomeBlocks(input: {
  appHomeContext: SlackAppHomeContext;
  logger: SlackEventArgs<"app_home_opened">["logger"];
  options: AgentSlackHandlerOptions;
  teamId: string | undefined;
  translator: Translator;
}): Promise<Record<string, unknown>[]> {
  if (input.options.featureSettingsHome === undefined || input.teamId === undefined) {
    return [];
  }
  const installedWorkspaces = await listAppHomeInstalledWorkspaces(input);
  const selectedTeamId =
    input.appHomeContext.mode === "enterprise_grid" ? installedWorkspaces[0]?.teamId : input.teamId;
  if (selectedTeamId === undefined) {
    return [];
  }
  const [imageWorkspaceSetting, textToSpeechWorkspaceSetting] = await Promise.all([
    input.options.featureSettingsHome.repository.findWorkspaceFeatureSetting({
      featureKey: "image_generation",
      teamId: selectedTeamId,
    }),
    input.options.featureSettingsHome.repository.findWorkspaceFeatureSetting({
      featureKey: "text_to_speech",
      teamId: selectedTeamId,
    }),
  ]);
  const imageModel = resolveImageGenerationModel(
    input.options.featureSettingsHome.imageGenerationModelId,
    input.logger,
  );
  const selectedTextToSpeechModelId =
    stringField(textToSpeechWorkspaceSetting?.payload, "text_to_speech_model_id") ??
    input.options.featureSettingsHome.textToSpeechModelId;
  const textToSpeechModel =
    selectedTextToSpeechModelId === undefined
      ? undefined
      : resolveTextToSpeechModel(selectedTextToSpeechModelId, input.logger);
  const availableTextToSpeechModelOptions =
    textToSpeechModel === undefined
      ? await textToSpeechModelOptions({
          logger: input.logger,
          options: input.options,
          teamId: selectedTeamId,
        })
      : [];
  if (
    imageModel === undefined &&
    textToSpeechModel === undefined &&
    availableTextToSpeechModelOptions.length === 0
  ) {
    return [];
  }
  const [hasImageCredential, hasTextToSpeechCredential] = await Promise.all([
    imageModel === undefined
      ? Promise.resolve(false)
      : hasAnyWorkspaceProviderApiKey(
          selectedTeamId,
          imageGenerationCredentialProviderKinds,
          input.options,
          input.logger,
        ),
    textToSpeechModel === undefined
      ? Promise.resolve(availableTextToSpeechModelOptions.length > 0)
      : hasAnyWorkspaceProviderApiKey(
          selectedTeamId,
          textToSpeechCredentialProviderKinds,
          input.options,
          input.logger,
        ),
  ]);
  if (
    !hasImageCredential &&
    imageWorkspaceSetting?.enabled !== true &&
    !hasTextToSpeechCredential &&
    textToSpeechWorkspaceSetting?.enabled !== true
  ) {
    return [];
  }
  return [
    { type: "divider" },
    {
      text: { text: input.translator.t("appHome.featureSettings.title"), type: "plain_text" },
      type: "header",
    },
    {
      accessory: {
        action_id: FEATURE_SETTINGS_CONFIGURE_ACTION_ID,
        text: { text: input.translator.t("appHome.configure"), type: "plain_text" },
        type: "button",
        value: JSON.stringify({
          enterpriseId: input.appHomeContext.enterpriseId,
          selectedTeamId,
          source: "app_home",
        }),
      },
      text: {
        text: input.translator.t("appHome.featureSettings.body"),
        type: "mrkdwn",
      },
      type: "section",
    },
  ];
}

async function buildModelRoutingAppHomeBlocks(input: {
  appHomeContext: SlackAppHomeContext;
  logger: SlackEventArgs<"app_home_opened">["logger"];
  options: AgentSlackHandlerOptions;
  translator: Translator;
}): Promise<Record<string, unknown>[]> {
  const { appHomeContext, translator } = input;
  const installedWorkspaces = await listAppHomeInstalledWorkspaces(input);
  const selectedTeamId = appHomeContext.sourceTeamId;
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

async function buildRssFeedAppHomeBlocks(input: {
  appHomeContext: SlackAppHomeContext;
  logger: SlackEventArgs<"app_home_opened">["logger"];
  options: AgentSlackHandlerOptions;
  teamId: string | undefined;
  translator: Translator;
}): Promise<Record<string, unknown>[]> {
  if (input.options.rssFeedHome === undefined || input.teamId === undefined) {
    return [];
  }
  const teamId = input.teamId;
  return [
    { type: "divider" },
    {
      text: { text: input.translator.t("appHome.rssFeeds.title"), type: "plain_text" },
      type: "header",
    },
    {
      accessory: {
        action_id: RSS_FEED_LIST_ACTION_ID,
        text: { text: input.translator.t("appHome.rssFeeds.open"), type: "plain_text" },
        type: "button",
        value: JSON.stringify({
          enterpriseId: input.appHomeContext.enterpriseId,
          selectedTeamId: teamId,
          source: "app_home",
          teamId,
        }),
      },
      text: {
        text: input.translator.t("appHome.rssFeeds.body"),
        type: "mrkdwn",
      },
      type: "section",
    },
  ];
}

async function listAppHomeRssFeedSubscriptions(input: {
  logger: unknown;
  options: AgentSlackHandlerOptions;
  page: number;
  teamId: string;
}): Promise<RssFeedSubscription[]> {
  try {
    return (
      (await input.options.rssFeedHome?.repository.listEnabledSubscriptions({
        limit: RSS_FEED_LIST_PAGE_SIZE + 1,
        offset: input.page * RSS_FEED_LIST_PAGE_SIZE,
        teamId: input.teamId,
      })) ?? []
    );
  } catch (error) {
    logWarn(input.logger, "Failed to load RSS subscriptions for App Home.", {
      error,
      teamId: input.teamId,
    });
    return [];
  }
}

function buildRssFeedListModal(input: {
  enterpriseId?: string;
  hasNextPage: boolean;
  page: number;
  selectedTeamId: string;
  subscriptions: readonly RssFeedSubscription[];
  teamId: string;
  translator: Translator;
  workspaces: readonly SlackInstalledWorkspace[];
}): Record<string, unknown> {
  const workspaceOptions = input.workspaces.map((workspace) => ({
    text: {
      text: workspace.teamName ?? workspace.teamId,
      type: "plain_text",
    },
    value: workspace.teamId,
  }));
  const selectedWorkspaceOption = workspaceOptions.find(
    (option) => option.value === input.selectedTeamId,
  );
  const visibleWorkspaceOptions = prioritizedSlackOptions(workspaceOptions, input.selectedTeamId);
  const paginationActions = buildRssFeedListPaginationActionElements(input);
  return {
    blocks: [
      ...(workspaceOptions.length > 0
        ? [
            {
              block_id: RSS_FEED_LIST_WORKSPACE_SELECT_ACTION_ID,
              dispatch_action: true,
              element: {
                action_id: RSS_FEED_LIST_WORKSPACE_SELECT_ACTION_ID,
                initial_option: selectedWorkspaceOption,
                options: visibleWorkspaceOptions,
                placeholder: {
                  text: input.translator.t("rssFeeds.workspace.placeholder"),
                  type: "plain_text",
                },
                type: "static_select",
              },
              label: {
                text: input.translator.t("rssFeeds.label.workspace"),
                type: "plain_text",
              },
              optional: false,
              type: "input",
            },
          ]
        : []),
      ...buildRssFeedSubscriptionListBlocks(input),
      ...(input.page > 0 || input.hasNextPage
        ? [
            {
              elements: [
                {
                  text: input.translator.t("rssFeeds.pagination.page", {
                    page: String(input.page + 1),
                  }),
                  type: "mrkdwn",
                },
              ],
              type: "context",
            },
          ]
        : []),
      ...(paginationActions.length === 0
        ? []
        : [
            {
              block_id: "rss_feed_list_actions",
              elements: paginationActions,
              type: "actions",
            },
          ]),
    ],
    callback_id: RSS_FEED_LIST_MODAL_CALLBACK_ID,
    close: { text: input.translator.t("common.close"), type: "plain_text" },
    private_metadata: JSON.stringify({
      enterpriseId: input.enterpriseId,
      page: input.page,
      source: "rss_list",
      teamId: input.teamId,
    }),
    submit: { text: input.translator.t("appHome.rssFeeds.add"), type: "plain_text" },
    title: { text: input.translator.t("rssFeeds.title"), type: "plain_text" },
    type: "modal",
  };
}

function buildRssFeedListPaginationActionElements(input: {
  enterpriseId?: string;
  hasNextPage: boolean;
  page: number;
  teamId: string;
  translator: Translator;
}): Record<string, unknown>[] {
  const actionValue = (page: number) =>
    JSON.stringify({
      enterpriseId: input.enterpriseId,
      page,
      selectedTeamId: input.teamId,
      source: "rss_list",
      teamId: input.teamId,
    });
  return [
    ...(input.page > 0
      ? [
          {
            action_id: RSS_FEED_LIST_PREVIOUS_PAGE_ACTION_ID,
            text: { text: input.translator.t("rssFeeds.pagination.previous"), type: "plain_text" },
            type: "button",
            value: actionValue(input.page - 1),
          },
        ]
      : []),
    ...(input.hasNextPage
      ? [
          {
            action_id: RSS_FEED_LIST_NEXT_PAGE_ACTION_ID,
            text: { text: input.translator.t("rssFeeds.pagination.next"), type: "plain_text" },
            type: "button",
            value: actionValue(input.page + 1),
          },
        ]
      : []),
  ];
}

function buildRssFeedSubscriptionListBlocks(input: {
  enterpriseId?: string;
  page: number;
  subscriptions: readonly RssFeedSubscription[];
  teamId: string;
  translator: Translator;
}): Record<string, unknown>[] {
  if (input.subscriptions.length === 0) {
    return [
      {
        text: {
          text: input.translator.t("appHome.rssFeeds.empty"),
          type: "mrkdwn",
        },
        type: "section",
      },
    ];
  }
  return [
    {
      text: {
        text: input.translator.t("appHome.rssFeeds.listHeader"),
        type: "mrkdwn",
      },
      type: "section",
    },
    ...input.subscriptions.map((subscription) => ({
      accessory: {
        action_id: RSS_FEED_DELETE_ACTION_ID,
        confirm: {
          confirm: {
            text: input.translator.t("rssFeeds.delete.text"),
            type: "plain_text",
          },
          deny: {
            text: input.translator.t("common.cancel"),
            type: "plain_text",
          },
          text: {
            text: input.translator.t("rssFeeds.delete.confirmText"),
            type: "mrkdwn",
          },
          title: {
            text: input.translator.t("rssFeeds.delete.confirmTitle"),
            type: "plain_text",
          },
        },
        style: "danger",
        text: {
          text: input.translator.t("rssFeeds.delete.text"),
          type: "plain_text",
        },
        type: "button",
        value: JSON.stringify({
          enterpriseId: input.enterpriseId,
          page: input.page,
          selectedTeamId: input.teamId,
          source: "rss_list",
          subscriptionId: subscription.id,
          teamId: input.teamId,
        }),
      },
      text: {
        text: formatRssFeedSubscriptionListItem(subscription, input.translator),
        type: "mrkdwn",
      },
      type: "section",
    })),
  ];
}

function formatRssFeedSubscriptionListItem(
  subscription: RssFeedSubscription,
  translator: Translator,
): string {
  const prompt = formatRssFeedPromptForList(stringField(subscription.payload, "prompt"));
  return [
    `<#${subscription.channelId}> - ${formatRssFeedUrlForAppHomeList(subscription.feedUrl)}`,
    ...(prompt === undefined ? [] : [`*${translator.t("rssFeeds.label.prompt")}:* ${prompt}`]),
  ].join("\n");
}

function formatRssFeedPromptForList(prompt: string | undefined): string | undefined {
  const normalized = prompt?.replace(/\s+/gu, " ").trim();
  if (normalized === undefined || normalized.length === 0) {
    return undefined;
  }
  const suffix = normalized.length > RSS_FEED_LIST_PROMPT_TEXT_LIMIT ? "..." : "";
  const truncatedPrompt = normalized.slice(
    0,
    Math.max(0, RSS_FEED_LIST_PROMPT_TEXT_LIMIT - suffix.length),
  );
  return escapeSlackMrkdwnLinkLabel(`${truncatedPrompt}${suffix}`);
}

function prioritizedSlackOptions<TOption extends { value: string }>(
  options: readonly TOption[],
  selectedValue: string,
): TOption[] {
  const selectedOption = options.find((option) => option.value === selectedValue);
  const orderedOptions =
    selectedOption === undefined
      ? options
      : [selectedOption, ...options.filter((option) => option.value !== selectedValue)];
  return orderedOptions.slice(0, 100);
}

function formatRssFeedUrlForAppHomeList(feedUrl: string): string {
  const suffix = feedUrl.length > RSS_FEED_APP_HOME_FEED_URL_TEXT_LIMIT ? "..." : "";
  const truncatedUrl = feedUrl.slice(
    0,
    Math.max(0, RSS_FEED_APP_HOME_FEED_URL_TEXT_LIMIT - suffix.length),
  );
  return escapeSlackMrkdwnLinkLabel(`${truncatedUrl}${suffix}`);
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

async function listInstalledWorkspacesForModelRouting(input: {
  enterpriseId?: string;
  logger: unknown;
  options: AgentSlackHandlerOptions;
}): Promise<SlackInstalledWorkspace[]> {
  if (input.enterpriseId === undefined || input.options.installedWorkspaceDirectory === undefined) {
    return [];
  }
  try {
    return await input.options.installedWorkspaceDirectory.listInstalledWorkspaces({
      enterpriseId: input.enterpriseId,
    });
  } catch (error) {
    logWarn(input.logger, "Failed to list installed Slack workspaces for model routing.", {
      enterpriseId: input.enterpriseId,
      error,
    });
    return [];
  }
}

async function listInstalledWorkspacesForRssFeeds(input: {
  enterpriseId?: string;
  logger: unknown;
  options: AgentSlackHandlerOptions;
}): Promise<SlackInstalledWorkspace[]> {
  if (input.enterpriseId === undefined || input.options.installedWorkspaceDirectory === undefined) {
    return [];
  }
  try {
    return await input.options.installedWorkspaceDirectory.listInstalledWorkspaces({
      enterpriseId: input.enterpriseId,
    });
  } catch (error) {
    logWarn(input.logger, "Failed to list installed Slack workspaces for RSS feeds.", {
      enterpriseId: input.enterpriseId,
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
  const isEnterpriseInstall = readSlackEnterpriseInstall(body);
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
    { enterpriseId, teamId: bodyTeamId },
    slackUserId,
    options,
    logger,
  );
  if (isChannelSettings) {
    await updateChannelModelRoutingModal({
      actionValue,
      bodyTeamId,
      client,
      enterpriseId,
      isEnterpriseInstall,
      logger,
      openedView,
      options,
      slackUserId,
      translator,
    });
    return;
  }

  if (isThreadSettings) {
    await updateThreadModelRoutingModal({
      actionValue,
      bodyTeamId,
      client,
      enterpriseId,
      isEnterpriseInstall,
      logger,
      openedView,
      options,
      slackUserId,
      translator,
    });
    return;
  }

  const effectiveTeamId = enterpriseId === undefined ? bodyTeamId : (selectedTeamId ?? bodyTeamId);
  if (effectiveTeamId === undefined || bodyTeamId === undefined) {
    await updateModelRoutingModal(
      client,
      openedView,
      buildModelRoutingResultModal(translator.t("modelRouting.error.unauthorized"), translator),
      logger,
    );
    return;
  }
  const workspaceValidation = await validateSelectedModelRoutingWorkspace({
    actorUserId: slackUserId,
    client,
    enterpriseId,
    isEnterpriseInstall,
    logger,
    options,
    selectedTeamId: effectiveTeamId,
    sourceTeamId: bodyTeamId,
    translator,
  });
  if (!workspaceValidation.userContext.isWorkspaceAdmin) {
    await updateModelRoutingModal(
      client,
      openedView,
      buildModelRoutingResultModal(
        workspaceValidation.userContext.translator.t("modelRouting.error.unauthorized"),
        workspaceValidation.userContext.translator,
      ),
      logger,
    );
    return;
  }
  const installedWorkspaces =
    enterpriseId === undefined || options.installedWorkspaceDirectory === undefined
      ? []
      : await listInstalledWorkspacesForModelRouting({ enterpriseId, logger, options });
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
          workspaceValidation.userContext.translator.t("modelRouting.error.noCredentialedModels"),
          workspaceValidation.userContext.translator,
        )
      : buildModelRoutingModal({
          credentialedProviders,
          enterpriseId,
          selectedTeamId: effectiveTeamId,
          translator: workspaceValidation.userContext.translator,
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
  enterpriseId?: string;
  isEnterpriseInstall?: boolean;
  logger: unknown;
  openedView: unknown;
  options: AgentSlackHandlerOptions;
  slackUserId?: string;
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
  const participantValidation = await validateChannelModelRoutingParticipant({
    actorUserId: input.slackUserId,
    channelId,
    client: input.client,
    enterpriseId: input.enterpriseId ?? input.actionValue?.enterpriseId,
    isEnterpriseInstall: input.isEnterpriseInstall,
    logger: input.logger,
    options: input.options,
    selectedTeamId,
    sourceTeamId: input.bodyTeamId,
  });
  if (!participantValidation.authorized) {
    await updateModelRoutingModal(
      input.client,
      input.openedView,
      buildModelRoutingResultModal(
        input.translator.t("modelRouting.error.unauthorized"),
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
  enterpriseId?: string;
  isEnterpriseInstall?: boolean;
  logger: unknown;
  openedView: unknown;
  options: AgentSlackHandlerOptions;
  slackUserId?: string;
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
  const participantValidation = await validateChannelModelRoutingParticipant({
    actorUserId: input.slackUserId,
    channelId,
    client: input.client,
    enterpriseId: input.enterpriseId ?? input.actionValue?.enterpriseId,
    isEnterpriseInstall: input.isEnterpriseInstall,
    logger: input.logger,
    options: input.options,
    selectedTeamId,
    sourceTeamId: input.bodyTeamId,
  });
  if (!participantValidation.authorized) {
    await updateModelRoutingModal(
      input.client,
      input.openedView,
      buildModelRoutingResultModal(
        input.translator.t("modelRouting.error.unauthorized"),
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
  const isEnterpriseInstall = readSlackEnterpriseInstall(body);
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
  const workspaceValidation = await validateSelectedModelRoutingWorkspace({
    actorUserId: slackUserId,
    client,
    enterpriseId,
    isEnterpriseInstall,
    logger,
    options,
    selectedTeamId,
    sourceTeamId: bodyTeamId,
    translator,
  });
  if (!workspaceValidation.userContext.isWorkspaceAdmin) {
    await ack({
      response_action: "update",
      view: buildModelRoutingResultModal(
        workspaceValidation.userContext.translator.t("modelRouting.error.unauthorized"),
        workspaceValidation.userContext.translator,
      ) as never,
    });
    return;
  }
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
        workspaceValidation.userContext.translator.t("modelRouting.result.saved"),
        workspaceValidation.userContext.translator,
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
        workspaceValidation.userContext.translator.t("modelRouting.error.saveFailed"),
        workspaceValidation.userContext.translator,
      ),
      logger,
    );
  }
}

type SelectedModelRoutingWorkspaceValidation =
  | { client: SlackAgentClient; userContext: { isWorkspaceAdmin: true; translator: Translator } }
  | { client?: undefined; userContext: { isWorkspaceAdmin: false; translator: Translator } };

async function validateSelectedModelRoutingWorkspace(input: {
  actorUserId?: string;
  client: SlackAgentClient;
  enterpriseId?: string;
  isEnterpriseInstall?: boolean;
  logger: unknown;
  options: AgentSlackHandlerOptions;
  selectedTeamId: string;
  sourceTeamId?: string;
  translator: Translator;
}): Promise<SelectedModelRoutingWorkspaceValidation> {
  const unauthorized = (): SelectedModelRoutingWorkspaceValidation => ({
    userContext: { isWorkspaceAdmin: false, translator: input.translator },
  });
  if (input.actorUserId === undefined || input.sourceTeamId === undefined) {
    return unauthorized();
  }
  const isCrossWorkspaceSelection = input.selectedTeamId !== input.sourceTeamId;
  if (input.enterpriseId === undefined && isCrossWorkspaceSelection) {
    return unauthorized();
  }
  if (input.enterpriseId !== undefined) {
    const installed = await isInstalledModelRoutingWorkspace({
      enterpriseId: input.enterpriseId,
      logger: input.logger,
      options: input.options,
      selectedTeamId: input.selectedTeamId,
    });
    if (!installed) {
      return unauthorized();
    }
  }
  const selectedTeamClient = await resolveSelectedTeamClient({
    client: input.client,
    enterpriseId: input.enterpriseId,
    isEnterpriseInstall: input.isEnterpriseInstall,
    logger: input.logger,
    options: input.options,
    selectedTeamId: input.selectedTeamId,
    sourceTeamId: input.sourceTeamId,
  });
  if (selectedTeamClient === undefined) {
    return unauthorized();
  }
  const userContext = await resolveSlackUserContext(
    selectedTeamClient,
    input.actorUserId,
    input.translator,
    input.logger,
    input.selectedTeamId,
  );
  if (!userContext.isWorkspaceAdmin) {
    return { userContext: { ...userContext, isWorkspaceAdmin: false } };
  }
  return { client: selectedTeamClient, userContext: { ...userContext, isWorkspaceAdmin: true } };
}

async function isInstalledModelRoutingWorkspace(input: {
  enterpriseId?: string;
  logger: unknown;
  options: AgentSlackHandlerOptions;
  selectedTeamId: string;
}): Promise<boolean> {
  if (input.enterpriseId === undefined || input.options.installedWorkspaceDirectory === undefined) {
    return false;
  }
  try {
    const workspaces = await input.options.installedWorkspaceDirectory.listInstalledWorkspaces({
      enterpriseId: input.enterpriseId,
    });
    return workspaces.some(
      (workspace) =>
        workspace.teamId === input.selectedTeamId &&
        (workspace.enterpriseId === undefined || workspace.enterpriseId === input.enterpriseId),
    );
  } catch (error) {
    logWarn(input.logger, "Failed to validate selected Slack workspace for model routing.", {
      enterpriseId: input.enterpriseId,
      error,
      targetTeamId: input.selectedTeamId,
    });
    return false;
  }
}

async function resolveSelectedTeamClient(input: {
  client: SlackAgentClient;
  enterpriseId?: string;
  isEnterpriseInstall?: boolean;
  logger: unknown;
  options: AgentSlackHandlerOptions;
  selectedTeamId: string;
  sourceTeamId?: string;
}): Promise<SlackAgentClient | undefined> {
  if (input.selectedTeamId === input.sourceTeamId) {
    return input.client;
  }
  if (input.options.slackTeamClients === undefined) {
    logWarn(input.logger, "Cannot resolve selected Slack workspace client for model routing.", {
      enterpriseId: input.enterpriseId,
      sourceTeamId: input.sourceTeamId,
      targetTeamId: input.selectedTeamId,
    });
    return undefined;
  }
  try {
    return await input.options.slackTeamClients.forTeam({
      enterpriseId: input.enterpriseId,
      isEnterpriseInstall: input.isEnterpriseInstall,
      teamId: input.selectedTeamId,
    });
  } catch (error) {
    logWarn(input.logger, "Failed to resolve selected Slack workspace client for model routing.", {
      enterpriseId: input.enterpriseId,
      error,
      sourceTeamId: input.sourceTeamId,
      targetTeamId: input.selectedTeamId,
    });
    return undefined;
  }
}

async function validateChannelModelRoutingParticipant(input: {
  actorUserId?: string;
  channelId: string;
  client: SlackAgentClient;
  enterpriseId?: string;
  isEnterpriseInstall?: boolean;
  logger: unknown;
  options: AgentSlackHandlerOptions;
  selectedTeamId: string;
  sourceTeamId?: string;
}): Promise<{ authorized: boolean; client?: SlackAgentClient }> {
  if (input.actorUserId === undefined || input.sourceTeamId === undefined) {
    return { authorized: false };
  }
  if (input.enterpriseId === undefined && input.selectedTeamId !== input.sourceTeamId) {
    return { authorized: false };
  }
  if (input.enterpriseId !== undefined) {
    const installed = await isInstalledModelRoutingWorkspace({
      enterpriseId: input.enterpriseId,
      logger: input.logger,
      options: input.options,
      selectedTeamId: input.selectedTeamId,
    });
    if (!installed) {
      return { authorized: false };
    }
  }
  const selectedTeamClient = await resolveSelectedTeamClient({
    client: input.client,
    enterpriseId: input.enterpriseId,
    isEnterpriseInstall: input.isEnterpriseInstall,
    logger: input.logger,
    options: input.options,
    selectedTeamId: input.selectedTeamId,
    sourceTeamId: input.sourceTeamId,
  });
  if (selectedTeamClient === undefined) {
    return { authorized: false };
  }
  const isMember = await isSlackChannelMember({
    channelId: input.channelId,
    client: selectedTeamClient,
    logger: input.logger,
    teamId: input.selectedTeamId,
    userId: input.actorUserId,
  });
  if (isMember !== undefined) {
    return { authorized: isMember, client: selectedTeamClient };
  }
  const userContext = await resolveSlackUserContext(
    selectedTeamClient,
    input.actorUserId,
    createTranslator(FALLBACK_LOCALE),
    input.logger,
    input.selectedTeamId,
  );
  return { authorized: userContext.isWorkspaceAdmin, client: selectedTeamClient };
}

async function isSlackChannelMember(input: {
  channelId: string;
  client: SlackAgentClient;
  logger: unknown;
  teamId: string;
  userId: string;
}): Promise<boolean | undefined> {
  const members = input.client.conversations?.members;
  if (members === undefined) {
    return undefined;
  }
  let cursor: string | undefined;
  try {
    do {
      const response = await members({
        channel: input.channelId,
        cursor,
        limit: 1000,
        team_id: input.teamId,
      } as never);
      const responseMembers = isRecord(response) ? response.members : undefined;
      if (Array.isArray(responseMembers) && responseMembers.includes(input.userId)) {
        return true;
      }
      const metadata =
        isRecord(response) && isRecord(response.response_metadata)
          ? response.response_metadata
          : undefined;
      cursor = metadata === undefined ? undefined : readString(metadata, "next_cursor");
    } while (cursor !== undefined && cursor.length > 0);
  } catch (error) {
    logWarn(input.logger, "Failed to verify Slack channel membership for model routing.", {
      channelId: input.channelId,
      error,
      teamId: input.teamId,
      userId: input.userId,
    });
    return false;
  }
  return false;
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
  const participantValidation = await validateChannelModelRoutingParticipant({
    actorUserId: input.slackUserId,
    channelId,
    client: input.client,
    enterpriseId: input.metadata.enterpriseId ?? readSlackEnterpriseId(input.body),
    isEnterpriseInstall: readSlackEnterpriseInstall(input.body),
    logger: input.logger,
    options: input.options,
    selectedTeamId,
    sourceTeamId: readTeamId(input.body, {}),
  });
  if (!participantValidation.authorized) {
    await input.ack({
      response_action: "update",
      view: buildModelRoutingResultModal(
        input.translator.t("modelRouting.error.unauthorized"),
        input.translator,
        input.translator.t("modelRouting.title.channel"),
      ) as never,
    });
    return;
  }
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
        input.translator.t("modelRouting.result.channelSaved"),
        input.translator,
        input.translator.t("modelRouting.title.channel"),
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
        input.translator.t("modelRouting.error.saveFailed"),
        input.translator,
        input.translator.t("modelRouting.title.channel"),
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
  const participantValidation = await validateChannelModelRoutingParticipant({
    actorUserId: input.slackUserId,
    channelId,
    client: input.client,
    enterpriseId: input.metadata.enterpriseId ?? readSlackEnterpriseId(input.body),
    isEnterpriseInstall: readSlackEnterpriseInstall(input.body),
    logger: input.logger,
    options: input.options,
    selectedTeamId,
    sourceTeamId: readTeamId(input.body, {}),
  });
  if (!participantValidation.authorized) {
    await input.ack({
      response_action: "update",
      view: buildModelRoutingResultModal(
        input.translator.t("modelRouting.error.unauthorized"),
        input.translator,
        input.translator.t("modelRouting.title.thread"),
      ) as never,
    });
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
        input.translator.t("modelRouting.result.threadSaved"),
        input.translator,
        input.translator.t("modelRouting.title.thread"),
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
        input.translator.t("modelRouting.error.saveFailed"),
        input.translator,
        input.translator.t("modelRouting.title.thread"),
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

function parseFeatureSettingsActionValue(
  value: string | undefined,
): FeatureSettingsActionValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    return {
      enterpriseId: stringRecordField(parsed, "enterpriseId"),
      selectedTeamId: stringRecordField(parsed, "selectedTeamId"),
      source: parsed.source === "app_home" ? "app_home" : undefined,
      teamId: stringRecordField(parsed, "teamId"),
    };
  } catch {
    return undefined;
  }
}

function parseRssFeedListPage(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

function parseRssFeedActionValue(value: string | undefined): RssFeedActionValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    return {
      enterpriseId: stringRecordField(parsed, "enterpriseId"),
      page: parseRssFeedListPage(parsed.page),
      selectedTeamId: stringRecordField(parsed, "selectedTeamId"),
      source:
        parsed.source === "app_home" || parsed.source === "rss_list" ? parsed.source : undefined,
      subscriptionId: stringRecordField(parsed, "subscriptionId"),
      teamId: stringRecordField(parsed, "teamId"),
    };
  } catch {
    return undefined;
  }
}

function stringRecordField(value: Record<string, unknown>, field: string): string | undefined {
  const fieldValue = value[field];
  return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : undefined;
}

function resolveImageGenerationModel(
  imageGenerationModelId: string,
  logger: unknown,
): ModelInfo | undefined {
  try {
    const model = createDefaultModelRegistry().get(imageGenerationModelId);
    if (model.provider !== "openai" && model.provider !== "google") {
      logWarn(logger, "Image generation model provider is not supported.", {
        imageGenerationModelId,
        provider: model.provider,
      });
      return undefined;
    }
    if (!model.capabilities.includes("image_generation")) {
      logWarn(logger, "Image generation model is missing image_generation capability.", {
        imageGenerationModelId,
      });
      return undefined;
    }
    return model;
  } catch (error) {
    logWarn(logger, "Failed to resolve image generation model.", {
      error,
      imageGenerationModelId,
    });
    return undefined;
  }
}

function resolveTextToSpeechModel(
  textToSpeechModelId: string,
  logger: unknown,
): ModelInfo | undefined {
  try {
    const model = createDefaultModelRegistry().get(textToSpeechModelId);
    if (model.provider !== "openai") {
      logWarn(logger, "Text-to-speech model provider is not supported.", {
        provider: model.provider,
        textToSpeechModelId,
      });
      return undefined;
    }
    if (!model.capabilities.includes("text_to_speech")) {
      logWarn(logger, "Text-to-speech model is missing text_to_speech capability.", {
        textToSpeechModelId,
      });
      return undefined;
    }
    return model;
  } catch (error) {
    logWarn(logger, "Failed to resolve text-to-speech model.", {
      error,
      textToSpeechModelId,
    });
    return undefined;
  }
}

async function hasWorkspaceProviderApiKey(
  teamId: string,
  providerKind: CredentialProviderKind,
  options: AgentSlackHandlerOptions,
  logger: unknown,
): Promise<boolean> {
  if (options.workspaceCredentialSettings?.resolveProviderCredential !== undefined) {
    try {
      return (
        (await options.workspaceCredentialSettings.resolveProviderCredential({
          credentialName: "api_key",
          provider: providerKind,
          workspaceId: teamId,
        })) !== undefined
      );
    } catch (error) {
      logWarn(logger, "Failed to resolve workspace provider API key status.", {
        error,
        providerKind,
        teamId,
      });
      return false;
    }
  }
  if (options.workspaceCredentialSettings?.listActiveProviderKinds === undefined) {
    return false;
  }
  try {
    const providerKinds = await options.workspaceCredentialSettings.listActiveProviderKinds({
      teamId,
    });
    return providerKinds.includes(providerKind);
  } catch (error) {
    logWarn(logger, "Failed to list workspace provider API key status.", {
      error,
      providerKind,
      teamId,
    });
    return false;
  }
}

async function hasAnyWorkspaceProviderApiKey(
  teamId: string,
  providerKinds: readonly CredentialProviderKind[],
  options: AgentSlackHandlerOptions,
  logger: unknown,
): Promise<boolean> {
  for (const providerKind of providerKinds) {
    if (await hasWorkspaceProviderApiKey(teamId, providerKind, options, logger)) {
      return true;
    }
  }
  return false;
}

async function imageGenerationModelOptions(input: {
  logger: unknown;
  options: AgentSlackHandlerOptions;
  teamId: string;
}): Promise<SlackOption[]> {
  const registry = createDefaultModelRegistry();
  const credentialedProviders = await Promise.all(
    imageGenerationCredentialProviderKinds.map(async (providerKind) => ({
      hasCredential: await hasWorkspaceProviderApiKey(
        input.teamId,
        providerKind,
        input.options,
        input.logger,
      ),
      providerKind,
    })),
  );
  const allowedProviders = new Set(
    credentialedProviders.filter((item) => item.hasCredential).map((item) => item.providerKind),
  );
  return registry
    .list()
    .filter(
      (model) =>
        model.capabilities.includes("image_generation") &&
        allowedProviders.has(
          model.provider as (typeof imageGenerationCredentialProviderKinds)[number],
        ),
    )
    .map((model) => ({
      text: {
        text: model.displayName ?? model.id,
        type: "plain_text" as const,
      },
      value: model.id,
    }))
    .slice(0, 100);
}

async function textToSpeechModelOptions(input: {
  logger: unknown;
  options: AgentSlackHandlerOptions;
  teamId: string;
}): Promise<SlackOption[]> {
  const registry = createDefaultModelRegistry();
  const credentialedProviders = await Promise.all(
    textToSpeechCredentialProviderKinds.map(async (providerKind) => ({
      hasCredential: await hasWorkspaceProviderApiKey(
        input.teamId,
        providerKind,
        input.options,
        input.logger,
      ),
      providerKind,
    })),
  );
  const allowedProviders = new Set(
    credentialedProviders.filter((item) => item.hasCredential).map((item) => item.providerKind),
  );
  return registry
    .list()
    .filter(
      (model) =>
        model.capabilities.includes("text_to_speech") &&
        allowedProviders.has(
          model.provider as (typeof textToSpeechCredentialProviderKinds)[number],
        ),
    )
    .map((model) => ({
      text: {
        text: model.displayName ?? model.id,
        type: "plain_text" as const,
      },
      value: model.id,
    }))
    .slice(0, 100);
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

async function handleRssFeedConfigureAction(
  { ack, body, client, logger }: SlackActionArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  await ack();
  const actionValue = parseRssFeedActionValue(readActionValue(body));
  const enterpriseId = actionValue?.enterpriseId ?? readSlackEnterpriseId(body);
  const bodyTeamId = readTeamId(body, {});
  const selectedTeamId = actionValue?.selectedTeamId ?? actionValue?.teamId ?? bodyTeamId;
  const slackUserId = readSlackUserId(body);
  const triggerId = isRecord(body) ? readString(body, "trigger_id") : undefined;
  const translator = await resolveHandlerTranslator(
    { enterpriseId, teamId: selectedTeamId ?? bodyTeamId },
    slackUserId,
    options,
    logger,
  );
  if (slackUserId === undefined || triggerId === undefined || selectedTeamId === undefined) {
    logWarn(logger, "Ignoring RSS feed configuration action with missing Slack context.", {});
    return;
  }
  const userContext = await resolveSlackUserContext(
    client,
    slackUserId,
    translator,
    logger,
    selectedTeamId,
  );
  if (!userContext.isWorkspaceAdmin) {
    await openOrPushRssFeedModal(client, body, triggerId, {
      logger,
      view: buildRssFeedResultModal(
        userContext.translator.t("rssFeeds.error.unauthorized"),
        userContext.translator,
      ),
    });
    return;
  }
  if (options.rssFeedHome === undefined) {
    await openOrPushRssFeedModal(client, body, triggerId, {
      logger,
      view: buildRssFeedResultModal(
        userContext.translator.t("rssFeeds.error.notConfigured"),
        userContext.translator,
      ),
    });
    return;
  }
  await openOrPushRssFeedModal(client, body, triggerId, {
    logger,
    view: buildRssFeedModal({
      enterpriseId,
      teamId: selectedTeamId,
      translator: userContext.translator,
    }),
  });
}

async function handleRssFeedListAction(
  { ack, body, client, logger }: SlackActionArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  await ack();
  const actionValue = parseRssFeedActionValue(readActionValue(body));
  const modalMetadata = parseRssFeedActionValue(readModalPrivateMetadata(body));
  const selectedWorkspaceTeamId = readActionSelectedOptionValue(body);
  const enterpriseId =
    actionValue?.enterpriseId ?? modalMetadata?.enterpriseId ?? readSlackEnterpriseId(body);
  const bodyTeamId = readTeamId(body, {});
  const selectedTeamId =
    selectedWorkspaceTeamId ??
    actionValue?.selectedTeamId ??
    actionValue?.teamId ??
    modalMetadata?.selectedTeamId ??
    modalMetadata?.teamId ??
    bodyTeamId;
  const slackUserId = readSlackUserId(body);
  const triggerId = isRecord(body) ? readString(body, "trigger_id") : undefined;
  const translator = await resolveHandlerTranslator(
    { enterpriseId, teamId: selectedTeamId ?? bodyTeamId },
    slackUserId,
    options,
    logger,
  );
  if (triggerId === undefined || selectedTeamId === undefined) {
    logWarn(logger, "Ignoring RSS feed list action with missing Slack context.", {});
    return;
  }
  if (enterpriseId === undefined && hasTeamContextMismatch(selectedTeamId, bodyTeamId)) {
    await openOrUpdateRssFeedModal(client, body, triggerId, {
      logger,
      view: buildRssFeedResultModal(translator.t("rssFeeds.error.contextMismatch"), translator),
    });
    return;
  }
  if (options.rssFeedHome === undefined) {
    await openOrUpdateRssFeedModal(client, body, triggerId, {
      logger,
      view: buildRssFeedResultModal(translator.t("rssFeeds.error.notConfigured"), translator),
    });
    return;
  }
  const workspaces = await listInstalledWorkspacesForRssFeeds({ enterpriseId, logger, options });
  if (
    enterpriseId !== undefined &&
    options.installedWorkspaceDirectory !== undefined &&
    !workspaces.some((workspace) => workspace.teamId === selectedTeamId)
  ) {
    await openOrUpdateRssFeedModal(client, body, triggerId, {
      logger,
      view: buildRssFeedResultModal(translator.t("rssFeeds.error.contextMismatch"), translator),
    });
    return;
  }
  const page = selectedWorkspaceTeamId === undefined ? (actionValue?.page ?? 0) : 0;
  await openOrUpdateRssFeedModal(client, body, triggerId, {
    logger,
    view: await buildRssFeedListModalForPage({
      enterpriseId,
      logger,
      options,
      page,
      selectedTeamId,
      teamId: selectedTeamId,
      translator,
      workspaces,
    }),
  });
}

async function buildRssFeedListModalForPage(input: {
  enterpriseId?: string;
  logger: unknown;
  options: AgentSlackHandlerOptions;
  page: number;
  selectedTeamId: string;
  teamId: string;
  translator: Translator;
  workspaces?: readonly SlackInstalledWorkspace[];
}): Promise<Record<string, unknown>> {
  let page = input.page;
  let subscriptions = await listAppHomeRssFeedSubscriptions({
    logger: input.logger,
    options: input.options,
    page,
    teamId: input.teamId,
  });
  if (page > 0 && subscriptions.length === 0) {
    page -= 1;
    subscriptions = await listAppHomeRssFeedSubscriptions({
      logger: input.logger,
      options: input.options,
      page,
      teamId: input.teamId,
    });
  }
  const workspaces =
    input.workspaces ??
    (await listInstalledWorkspacesForRssFeeds({
      enterpriseId: input.enterpriseId,
      logger: input.logger,
      options: input.options,
    }));
  return buildRssFeedListModal({
    enterpriseId: input.enterpriseId,
    hasNextPage: subscriptions.length > RSS_FEED_LIST_PAGE_SIZE,
    page,
    selectedTeamId: input.selectedTeamId,
    subscriptions: subscriptions.slice(0, RSS_FEED_LIST_PAGE_SIZE),
    teamId: input.teamId,
    translator: input.translator,
    workspaces,
  });
}

async function handleRssFeedDeleteAction(
  { ack, body, client, logger }: SlackActionArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  await ack();
  const actionValue = parseRssFeedActionValue(readActionValue(body));
  const enterpriseId = actionValue?.enterpriseId ?? readSlackEnterpriseId(body);
  const bodyTeamId = readTeamId(body, {});
  const teamId = actionValue?.selectedTeamId ?? actionValue?.teamId ?? bodyTeamId;
  const page = actionValue?.page ?? 0;
  const slackUserId = readSlackUserId(body);
  const subscriptionId = actionValue?.subscriptionId;
  const translator = await resolveHandlerTranslator(
    { enterpriseId, teamId: teamId ?? bodyTeamId },
    slackUserId,
    options,
    logger,
  );
  if (teamId === undefined || slackUserId === undefined || subscriptionId === undefined) {
    logWarn(logger, "Ignoring RSS feed delete action with missing Slack context.", {});
    return;
  }
  if (enterpriseId === undefined && hasTeamContextMismatch(teamId, bodyTeamId)) {
    await updateRssFeedModal(
      client,
      isRecord(body) ? body.view : undefined,
      buildRssFeedResultModal(translator.t("rssFeeds.error.contextMismatch"), translator),
      logger,
    );
    return;
  }
  if (options.rssFeedHome === undefined) {
    await updateRssFeedModal(
      client,
      isRecord(body) ? body.view : undefined,
      buildRssFeedResultModal(translator.t("rssFeeds.error.notConfigured"), translator),
      logger,
    );
    return;
  }
  const workspaces = await listInstalledWorkspacesForRssFeeds({ enterpriseId, logger, options });
  if (
    enterpriseId !== undefined &&
    options.installedWorkspaceDirectory !== undefined &&
    !workspaces.some((workspace) => workspace.teamId === teamId)
  ) {
    await updateRssFeedModal(
      client,
      isRecord(body) ? body.view : undefined,
      buildRssFeedResultModal(translator.t("rssFeeds.error.contextMismatch"), translator),
      logger,
    );
    return;
  }
  const userContext = await resolveSlackUserContext(
    client,
    slackUserId,
    translator,
    logger,
    teamId,
  );
  if (!userContext.isWorkspaceAdmin) {
    await updateRssFeedModal(
      client,
      isRecord(body) ? body.view : undefined,
      buildRssFeedResultModal(
        userContext.translator.t("rssFeeds.error.unauthorized"),
        userContext.translator,
      ),
      logger,
    );
    return;
  }
  const deleted = await options.rssFeedHome.repository.disableSubscription({
    subscriptionId,
    teamId,
    updatedAt: new Date(),
  });
  logInfo(logger, "Deleted RSS feed subscription from Slack modal.", {
    deleted,
    subscriptionId,
    teamId,
  });
  await updateRssFeedModal(
    client,
    isRecord(body) ? body.view : undefined,
    await buildRssFeedListModalForPage({
      enterpriseId,
      logger,
      options,
      page,
      selectedTeamId: teamId,
      teamId,
      translator: userContext.translator,
      workspaces,
    }),
    logger,
  );
}

async function openOrPushRssFeedModal(
  client: SlackClient,
  body: unknown,
  triggerId: string,
  input: { logger: unknown; view: Record<string, unknown> },
): Promise<void> {
  if (isSlackModalActionBody(body)) {
    try {
      await client.views.push({
        trigger_id: triggerId,
        view: input.view as never,
      });
      return;
    } catch (error) {
      logWarn(input.logger, "Failed to push RSS feed modal.", { error });
      return;
    }
  }
  await client.views.open({
    trigger_id: triggerId,
    view: input.view as never,
  });
}

async function openOrUpdateRssFeedModal(
  client: SlackClient,
  body: unknown,
  triggerId: string,
  input: { logger: unknown; view: Record<string, unknown> },
): Promise<void> {
  if (isSlackModalActionBody(body)) {
    await updateRssFeedModal(client, body.view, input.view, input.logger);
    return;
  }
  await client.views.open({
    trigger_id: triggerId,
    view: input.view as never,
  });
}

function isSlackModalActionBody(body: unknown): body is { view: Record<string, unknown> } {
  if (!isRecord(body) || !isRecord(body.view)) {
    return false;
  }
  return readString(body.view, "type") === "modal";
}

async function handleRssFeedListModalSubmission(
  { ack, body, logger, view }: SlackViewArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  const metadata = parseRssFeedActionValue(
    readString(view as unknown as StringIndexed, "private_metadata"),
  );
  const teamId =
    readSelectedOptionValue(
      view,
      RSS_FEED_LIST_WORKSPACE_SELECT_ACTION_ID,
      RSS_FEED_LIST_WORKSPACE_SELECT_ACTION_ID,
    ) ??
    metadata?.teamId ??
    metadata?.selectedTeamId;
  const slackUserId = readSlackUserId(body);
  const translator = await resolveHandlerTranslator(
    { enterpriseId: metadata?.enterpriseId ?? readSlackEnterpriseId(body), teamId },
    slackUserId,
    options,
    logger,
  );
  if (teamId === undefined) {
    await ack({ response_action: "clear" });
    logWarn(logger, "Ignoring RSS feed list modal submission with missing team context.", {});
    return;
  }
  await ack({
    response_action: "update",
    view: buildRssFeedModal({
      enterpriseId: metadata?.enterpriseId,
      source: "rss_list",
      teamId,
      translator,
    }) as never,
  });
}

async function handleRssFeedModalSubmission(
  { ack, body, client, logger, view }: SlackViewArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  const metadata = parseRssFeedActionValue(
    readString(view as unknown as StringIndexed, "private_metadata"),
  );
  const metadataTeamId = metadata?.teamId ?? metadata?.selectedTeamId;
  const bodyTeamId = readTeamId(body, {});
  const teamId =
    metadata?.enterpriseId === undefined
      ? (bodyTeamId ?? metadataTeamId)
      : (metadataTeamId ?? bodyTeamId);
  const slackUserId = readSlackUserId(body);
  const translator = await resolveHandlerTranslator(
    { enterpriseId: metadata?.enterpriseId ?? readSlackEnterpriseId(body), teamId },
    slackUserId,
    options,
    logger,
  );
  if (options.rssFeedHome === undefined || teamId === undefined || slackUserId === undefined) {
    await ack({
      errors: {
        [RSS_FEED_URL_BLOCK_ID]: translator.t("rssFeeds.error.notConfigured"),
      },
      response_action: "errors",
    });
    return;
  }
  if (metadata?.enterpriseId === undefined && hasTeamContextMismatch(metadataTeamId, bodyTeamId)) {
    await ack({
      errors: {
        [RSS_FEED_CHANNEL_BLOCK_ID]: translator.t("rssFeeds.error.contextMismatch"),
      },
      response_action: "errors",
    });
    return;
  }
  const parsed = parseRssFeedModal(view, translator);
  if ("errors" in parsed) {
    await ack({
      errors: parsed.errors,
      response_action: "errors",
    });
    return;
  }

  await ack({
    response_action: "update",
    view: buildRssFeedResultModal(translator.t("rssFeeds.result.saving"), translator) as never,
  });

  const userContext = await resolveSlackUserContext(
    client,
    slackUserId,
    translator,
    logger,
    teamId,
  );
  if (!userContext.isWorkspaceAdmin) {
    await updateRssFeedModal(
      client,
      view,
      buildRssFeedResultModal(
        userContext.translator.t("rssFeeds.error.unauthorized"),
        userContext.translator,
      ),
      logger,
    );
    return;
  }

  const feedValidation = await validateRssFeedUrl({
    feedUrl: parsed.feedUrl,
    fetchFn: options.rssFeedFetchFn,
    resolveHostname: options.rssFeedResolveHostname,
  });
  if (!feedValidation.ok) {
    const messageKey =
      feedValidation.reason === "unreachable"
        ? "rssFeeds.error.unreachableFeedUrl"
        : "rssFeeds.error.notFeedUrl";
    await updateRssFeedModal(
      client,
      view,
      buildRssFeedResultModal(userContext.translator.t(messageKey), userContext.translator),
      logger,
    );
    logWarn(logger, "Rejected RSS feed subscription with invalid feed URL.", {
      feedUrl: parsed.feedUrl,
      reason: feedValidation.reason,
      teamId,
    });
    return;
  }

  const joinResult = await joinRssFeedChannel(client, parsed.channelId);
  if (!joinResult.ok) {
    await updateRssFeedModal(
      client,
      view,
      buildRssFeedResultModal(
        userContext.translator.t(joinResult.messageKey),
        userContext.translator,
      ),
      logger,
    );
    logWarn(logger, "Could not join RSS feed channel before saving subscription.", {
      channelId: parsed.channelId,
      errorCode: joinResult.errorCode,
      teamId,
    });
    return;
  }

  try {
    const now = new Date();
    await options.rssFeedHome.repository.saveSubscription({
      channelId: parsed.channelId,
      createdAt: now,
      enabled: true,
      feedUrl: parsed.feedUrl,
      id: randomUUID(),
      payload: {
        created_by_slack_user_id: slackUserId,
        ...(parsed.prompt === undefined ? {} : { prompt: parsed.prompt }),
        source: "slack_app_home",
      },
      teamId,
      updatedAt: now,
    });
    logInfo(logger, "Saved RSS feed subscription from Slack modal.", {
      channelId: parsed.channelId,
      feedUrl: parsed.feedUrl,
      teamId,
    });
    await updateRssFeedModal(
      client,
      view,
      await buildRssFeedListModalForPage({
        enterpriseId: metadata?.enterpriseId,
        logger,
        options,
        page: 0,
        selectedTeamId: teamId,
        teamId,
        translator: userContext.translator,
      }),
      logger,
    );
  } catch (error) {
    logError(logger, "Failed to save RSS feed subscription from Slack modal.", {
      channelId: parsed.channelId,
      error,
      feedUrl: parsed.feedUrl,
      teamId,
    });
    await updateRssFeedModal(
      client,
      view,
      buildRssFeedResultModal(
        userContext.translator.t("rssFeeds.error.saveFailed"),
        userContext.translator,
      ),
      logger,
    );
  }
}

async function handleFeatureSettingsConfigureAction(
  { ack, body, client, logger }: SlackActionArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  await ack();
  const actionValue = parseFeatureSettingsActionValue(readActionValue(body));
  const enterpriseId = actionValue?.enterpriseId ?? readSlackEnterpriseId(body);
  const bodyTeamId = readTeamId(body, {});
  const selectedTeamId = actionValue?.selectedTeamId ?? actionValue?.teamId ?? bodyTeamId;
  const slackUserId = readSlackUserId(body);
  const triggerId = isRecord(body) ? readString(body, "trigger_id") : undefined;
  const translator = await resolveHandlerTranslator(
    { enterpriseId, teamId: selectedTeamId ?? bodyTeamId },
    slackUserId,
    options,
    logger,
  );
  if (slackUserId === undefined || triggerId === undefined || selectedTeamId === undefined) {
    logger.warn("Ignoring feature settings configuration action with missing Slack context.");
    return;
  }
  const userContext = await resolveSlackUserContext(
    client,
    slackUserId,
    translator,
    logger,
    selectedTeamId,
  );
  if (!userContext.isWorkspaceAdmin) {
    await client.views.open({
      trigger_id: triggerId,
      view: buildFeatureSettingsResultModal(
        userContext.translator.t("featureSettings.error.unauthorized"),
        userContext.translator,
      ) as never,
    });
    return;
  }
  if (options.featureSettingsHome === undefined) {
    await client.views.open({
      trigger_id: triggerId,
      view: buildFeatureSettingsResultModal(
        userContext.translator.t("featureSettings.error.notConfigured"),
        userContext.translator,
      ) as never,
    });
    return;
  }
  const [
    imageWorkspaceSetting,
    imageAllowedChannels,
    textToSpeechWorkspaceSetting,
    textToSpeechAllowedChannels,
  ] = await Promise.all([
    options.featureSettingsHome.repository.findWorkspaceFeatureSetting({
      featureKey: "image_generation",
      teamId: selectedTeamId,
    }),
    options.featureSettingsHome.repository.listAllowedChannels({
      featureKey: "image_generation",
      teamId: selectedTeamId,
    }),
    options.featureSettingsHome.repository.findWorkspaceFeatureSetting({
      featureKey: "text_to_speech",
      teamId: selectedTeamId,
    }),
    options.featureSettingsHome.repository.listAllowedChannels({
      featureKey: "text_to_speech",
      teamId: selectedTeamId,
    }),
  ]);
  const imageModel = resolveImageGenerationModel(
    options.featureSettingsHome.imageGenerationModelId,
    logger,
  );
  const textToSpeechModelOptionsForTeam = await textToSpeechModelOptions({
    logger,
    options,
    teamId: selectedTeamId,
  });
  const selectedTextToSpeechModelId =
    stringField(textToSpeechWorkspaceSetting?.payload, "text_to_speech_model_id") ??
    options.featureSettingsHome.textToSpeechModelId;
  const textToSpeechModel =
    selectedTextToSpeechModelId === undefined
      ? undefined
      : resolveTextToSpeechModel(selectedTextToSpeechModelId, logger);
  if (
    imageModel === undefined &&
    textToSpeechModel === undefined &&
    textToSpeechModelOptionsForTeam.length === 0
  ) {
    await client.views.open({
      trigger_id: triggerId,
      view: buildFeatureSettingsResultModal(
        userContext.translator.t("featureSettings.error.notConfigured"),
        userContext.translator,
      ) as never,
    });
    return;
  }
  const [hasImageCredential, hasTextToSpeechCredential] = await Promise.all([
    imageModel === undefined
      ? Promise.resolve(false)
      : hasAnyWorkspaceProviderApiKey(
          selectedTeamId,
          imageGenerationCredentialProviderKinds,
          options,
          logger,
        ),
    textToSpeechModel === undefined
      ? Promise.resolve(textToSpeechModelOptionsForTeam.length > 0)
      : hasAnyWorkspaceProviderApiKey(
          selectedTeamId,
          textToSpeechCredentialProviderKinds,
          options,
          logger,
        ),
  ]);
  if (
    !hasImageCredential &&
    imageWorkspaceSetting?.enabled !== true &&
    !hasTextToSpeechCredential &&
    textToSpeechWorkspaceSetting?.enabled !== true
  ) {
    await client.views.open({
      trigger_id: triggerId,
      view: buildFeatureSettingsResultModal(
        userContext.translator.t("featureSettings.error.missingImageCredential"),
        userContext.translator,
      ) as never,
    });
    return;
  }
  await client.views.open({
    trigger_id: triggerId,
    view: buildFeatureSettingsModal({
      imageAllowedChannelIds: imageAllowedChannels.map((channel) => channel.channelId),
      imageAllowDirectMessages:
        booleanField(imageWorkspaceSetting?.payload, "allow_direct_messages") === true,
      imageEnabled: imageWorkspaceSetting?.enabled === true,
      enterpriseId,
      imageGenerationModelId:
        stringField(imageWorkspaceSetting?.payload, "image_generation_model_id") ??
        options.featureSettingsHome.imageGenerationModelId,
      imageGenerationModelOptions: await imageGenerationModelOptions({
        logger,
        options,
        teamId: selectedTeamId,
      }),
      teamId: selectedTeamId,
      textToSpeechAllowedChannelIds: textToSpeechAllowedChannels.map(
        (channel) => channel.channelId,
      ),
      textToSpeechEnabled: textToSpeechWorkspaceSetting?.enabled === true,
      textToSpeechModelId: selectedTextToSpeechModelId,
      textToSpeechModelOptions: textToSpeechModelOptionsForTeam,
      translator: userContext.translator,
    }) as never,
  });
}

async function handleFeatureSettingsModalSubmission(
  { ack, body, client, logger, view }: SlackViewArgs,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  const metadata = parseFeatureSettingsActionValue(
    readString(view as unknown as StringIndexed, "private_metadata"),
  );
  const metadataTeamId = metadata?.teamId ?? metadata?.selectedTeamId;
  const bodyTeamId = readTeamId(body, {});
  const teamId =
    metadata?.enterpriseId === undefined
      ? (bodyTeamId ?? metadataTeamId)
      : (metadataTeamId ?? bodyTeamId);
  const slackUserId = readSlackUserId(body);
  const translator = await resolveHandlerTranslator(
    { enterpriseId: metadata?.enterpriseId ?? readSlackEnterpriseId(body), teamId },
    slackUserId,
    options,
    logger,
  );
  if (
    options.featureSettingsHome === undefined ||
    teamId === undefined ||
    slackUserId === undefined
  ) {
    await ack({
      errors: {
        [FEATURE_SETTINGS_IMAGE_CHANNELS_BLOCK_ID]: translator.t(
          "featureSettings.error.notConfigured",
        ),
      },
      response_action: "errors",
    });
    return;
  }
  if (
    metadata?.enterpriseId === undefined &&
    metadataTeamId !== undefined &&
    bodyTeamId !== undefined &&
    metadataTeamId !== bodyTeamId
  ) {
    await ack({
      errors: {
        [FEATURE_SETTINGS_IMAGE_CHANNELS_BLOCK_ID]: translator.t(
          "featureSettings.error.contextMismatch",
        ),
      },
      response_action: "errors",
    });
    return;
  }
  const imageEnabled = readSelectedOptionValues(
    view,
    FEATURE_SETTINGS_IMAGE_ENABLED_BLOCK_ID,
    FEATURE_SETTINGS_IMAGE_ENABLED_ACTION_ID,
  ).includes("enabled");
  const imageChannelIds = readSelectedConversationValues(
    view,
    FEATURE_SETTINGS_IMAGE_CHANNELS_BLOCK_ID,
    FEATURE_SETTINGS_IMAGE_CHANNELS_ACTION_ID,
  );
  const imageAllowDirectMessages = readSelectedOptionValues(
    view,
    FEATURE_SETTINGS_IMAGE_DIRECT_MESSAGES_BLOCK_ID,
    FEATURE_SETTINGS_IMAGE_DIRECT_MESSAGES_ACTION_ID,
  ).includes("enabled");
  const selectedImageGenerationModelId =
    readSelectedOptionValue(
      view,
      FEATURE_SETTINGS_IMAGE_MODEL_BLOCK_ID,
      FEATURE_SETTINGS_IMAGE_MODEL_ACTION_ID,
    ) ?? options.featureSettingsHome?.imageGenerationModelId;
  const textToSpeechEnabled = readSelectedOptionValues(
    view,
    FEATURE_SETTINGS_TTS_ENABLED_BLOCK_ID,
    FEATURE_SETTINGS_TTS_ENABLED_ACTION_ID,
  ).includes("enabled");
  const textToSpeechChannelIds = readSelectedConversationValues(
    view,
    FEATURE_SETTINGS_TTS_CHANNELS_BLOCK_ID,
    FEATURE_SETTINGS_TTS_CHANNELS_ACTION_ID,
  );
  const selectedTextToSpeechModelId =
    readSelectedOptionValue(
      view,
      FEATURE_SETTINGS_TTS_MODEL_BLOCK_ID,
      FEATURE_SETTINGS_TTS_MODEL_ACTION_ID,
    ) ?? options.featureSettingsHome?.textToSpeechModelId;
  if (imageEnabled && imageChannelIds.length === 0 && !imageAllowDirectMessages) {
    await ack({
      errors: {
        [FEATURE_SETTINGS_IMAGE_CHANNELS_BLOCK_ID]: translator.t(
          "featureSettings.error.imageChannelsRequired",
        ),
      },
      response_action: "errors",
    });
    return;
  }
  if (textToSpeechEnabled && textToSpeechChannelIds.length === 0) {
    await ack({
      errors: {
        [FEATURE_SETTINGS_TTS_CHANNELS_BLOCK_ID]: translator.t(
          "featureSettings.error.channelsRequired",
        ),
      },
      response_action: "errors",
    });
    return;
  }
  if (imageEnabled && selectedImageGenerationModelId === undefined) {
    await ack({
      errors: {
        [FEATURE_SETTINGS_IMAGE_MODEL_BLOCK_ID]: translator.t(
          "featureSettings.error.missingImageCredential",
        ),
      },
      response_action: "errors",
    });
    return;
  }
  if (textToSpeechEnabled && selectedTextToSpeechModelId === undefined) {
    await ack({
      errors: {
        [FEATURE_SETTINGS_TTS_ENABLED_BLOCK_ID]: translator.t(
          "featureSettings.error.missingTextToSpeechCredential",
        ),
      },
      response_action: "errors",
    });
    return;
  }
  await ack({
    response_action: "update",
    view: buildFeatureSettingsResultModal(
      translator.t("featureSettings.result.saving"),
      translator,
    ) as never,
  });
  const userContext = await resolveSlackUserContext(
    client,
    slackUserId,
    translator,
    logger,
    teamId,
  );
  if (!userContext.isWorkspaceAdmin) {
    await updateFeatureSettingsModal(
      client,
      view,
      buildFeatureSettingsResultModal(
        userContext.translator.t("featureSettings.error.unauthorized"),
        userContext.translator,
      ),
      logger,
    );
    return;
  }
  const imageModel =
    selectedImageGenerationModelId === undefined
      ? undefined
      : resolveImageGenerationModel(selectedImageGenerationModelId, logger);
  const textToSpeechModel =
    selectedTextToSpeechModelId === undefined
      ? undefined
      : resolveTextToSpeechModel(selectedTextToSpeechModelId, logger);
  if (imageEnabled && imageModel === undefined) {
    await updateFeatureSettingsModal(
      client,
      view,
      buildFeatureSettingsResultModal(
        userContext.translator.t("featureSettings.error.notConfigured"),
        userContext.translator,
      ),
      logger,
    );
    return;
  }
  if (textToSpeechEnabled && textToSpeechModel === undefined) {
    await updateFeatureSettingsModal(
      client,
      view,
      buildFeatureSettingsResultModal(
        userContext.translator.t("featureSettings.error.notConfigured"),
        userContext.translator,
      ),
      logger,
    );
    return;
  }
  if (
    imageEnabled &&
    imageModel !== undefined &&
    !(await hasWorkspaceProviderApiKey(teamId, imageModel.provider, options, logger))
  ) {
    await updateFeatureSettingsModal(
      client,
      view,
      buildFeatureSettingsResultModal(
        userContext.translator.t("featureSettings.error.missingImageCredential"),
        userContext.translator,
      ),
      logger,
    );
    return;
  }
  if (
    textToSpeechEnabled &&
    textToSpeechModel !== undefined &&
    !(await hasWorkspaceProviderApiKey(teamId, textToSpeechModel.provider, options, logger))
  ) {
    await updateFeatureSettingsModal(
      client,
      view,
      buildFeatureSettingsResultModal(
        userContext.translator.t("featureSettings.error.missingTextToSpeechCredential"),
        userContext.translator,
      ),
      logger,
    );
    return;
  }
  try {
    const now = new Date();
    await options.featureSettingsHome.repository.saveWorkspaceFeatureConfigurations({
      configurations: [
        {
          allowedChannelIds: imageChannelIds,
          workspaceSetting: {
            enabled: imageEnabled,
            featureKey: "image_generation",
            payload: {
              feature_key: "image_generation",
              allow_direct_messages: imageAllowDirectMessages,
              image_generation_model_id:
                selectedImageGenerationModelId ??
                options.featureSettingsHome.imageGenerationModelId,
            },
            teamId,
            updatedAt: now,
            updatedByUserId: slackUserId,
          },
        },
        {
          allowedChannelIds: textToSpeechChannelIds,
          workspaceSetting: {
            enabled: textToSpeechEnabled,
            featureKey: "text_to_speech",
            payload: {
              feature_key: "text_to_speech",
              ...(selectedTextToSpeechModelId === undefined
                ? {}
                : { text_to_speech_model_id: selectedTextToSpeechModelId }),
            },
            teamId,
            updatedAt: now,
            updatedByUserId: slackUserId,
          },
        },
      ],
    });
    await updateFeatureSettingsModal(
      client,
      view,
      buildFeatureSettingsResultModal(
        userContext.translator.t("featureSettings.result.saved"),
        userContext.translator,
      ),
      logger,
    );
  } catch (error) {
    logger.error("Failed to save workspace feature settings.", { error, teamId });
    await updateFeatureSettingsModal(
      client,
      view,
      buildFeatureSettingsResultModal(
        userContext.translator.t("featureSettings.error.saveFailed"),
        userContext.translator,
      ),
      logger,
    );
  }
}

function buildRssFeedModal(input: {
  enterpriseId?: string;
  source?: "app_home" | "rss_list";
  teamId: string;
  translator: Translator;
}): Record<string, unknown> {
  return {
    blocks: [
      {
        text: {
          text: input.translator.t("rssFeeds.modal.intro"),
          type: "mrkdwn",
        },
        type: "section",
      },
      {
        block_id: RSS_FEED_URL_BLOCK_ID,
        element: {
          action_id: RSS_FEED_URL_ACTION_ID,
          placeholder: { text: "https://example.com/feed.xml", type: "plain_text" },
          type: "plain_text_input",
        },
        label: { text: input.translator.t("rssFeeds.label.feedUrl"), type: "plain_text" },
        type: "input",
      },
      {
        block_id: RSS_FEED_CHANNEL_BLOCK_ID,
        element: {
          action_id: RSS_FEED_CHANNEL_ACTION_ID,
          filter: {
            exclude_bot_users: true,
            include: ["public"],
          },
          placeholder: {
            text: input.translator.t("rssFeeds.channel.placeholder"),
            type: "plain_text",
          },
          type: "conversations_select",
        },
        label: { text: input.translator.t("rssFeeds.label.channel"), type: "plain_text" },
        type: "input",
      },
      {
        block_id: RSS_FEED_PROMPT_BLOCK_ID,
        element: {
          action_id: RSS_FEED_PROMPT_ACTION_ID,
          max_length: 3000,
          multiline: true,
          placeholder: {
            text: input.translator.t("rssFeeds.prompt.placeholder"),
            type: "plain_text",
          },
          type: "plain_text_input",
        },
        label: { text: input.translator.t("rssFeeds.label.prompt"), type: "plain_text" },
        optional: true,
        type: "input",
      },
    ],
    callback_id: RSS_FEED_MODAL_CALLBACK_ID,
    close: { text: input.translator.t("common.cancel"), type: "plain_text" },
    private_metadata: JSON.stringify({
      enterpriseId: input.enterpriseId,
      source: input.source ?? "app_home",
      teamId: input.teamId,
    }),
    submit: { text: input.translator.t("common.save"), type: "plain_text" },
    title: { text: input.translator.t("rssFeeds.title"), type: "plain_text" },
    type: "modal",
  };
}

function buildRssFeedResultModal(message: string, translator: Translator): Record<string, unknown> {
  return {
    blocks: [
      {
        text: { text: message, type: "mrkdwn" },
        type: "section",
      },
    ],
    close: { text: translator.t("common.close"), type: "plain_text" },
    title: { text: translator.t("rssFeeds.title"), type: "plain_text" },
    type: "modal",
  };
}

function parseRssFeedModal(
  view: unknown,
  translator: Translator,
): { channelId: string; feedUrl: string; prompt?: string } | { errors: Record<string, string> } {
  const rawFeedUrl = readModalInputValue(view, RSS_FEED_URL_BLOCK_ID, RSS_FEED_URL_ACTION_ID);
  const rawPrompt = readModalInputValue(view, RSS_FEED_PROMPT_BLOCK_ID, RSS_FEED_PROMPT_ACTION_ID);
  const prompt = normalizeOptionalRssPrompt(rawPrompt);
  let feedUrl: string | undefined;
  try {
    feedUrl = rawFeedUrl === undefined ? undefined : normalizeRssFeedUrl(rawFeedUrl);
  } catch {
    feedUrl = undefined;
  }
  const channelId = readSelectedConversationValue(
    view,
    RSS_FEED_CHANNEL_BLOCK_ID,
    RSS_FEED_CHANNEL_ACTION_ID,
  );
  const errors: Record<string, string> = {};
  if (feedUrl === undefined || !isHttpUrl(feedUrl)) {
    errors[RSS_FEED_URL_BLOCK_ID] = translator.t("rssFeeds.error.invalidFeedUrl");
  }
  if (channelId === undefined) {
    errors[RSS_FEED_CHANNEL_BLOCK_ID] = translator.t("rssFeeds.error.channelRequired");
  }
  if (Object.keys(errors).length > 0) {
    return { errors };
  }
  if (channelId === undefined || feedUrl === undefined) {
    return {
      errors: {
        [RSS_FEED_CHANNEL_BLOCK_ID]: translator.t("rssFeeds.error.channelRequired"),
      },
    };
  }
  return prompt === undefined ? { channelId, feedUrl } : { channelId, feedUrl, prompt };
}

function normalizeOptionalRssPrompt(value: string | undefined): string | undefined {
  const prompt = value?.trim();
  return prompt === undefined || prompt.length === 0 ? undefined : prompt;
}

function hasTeamContextMismatch(
  metadataTeamId: string | undefined,
  bodyTeamId: string | undefined,
): boolean {
  return metadataTeamId !== undefined && bodyTeamId !== undefined && metadataTeamId !== bodyTeamId;
}

async function joinRssFeedChannel(
  client: SlackClient,
  channelId: string,
): Promise<
  | { ok: true }
  | {
      errorCode?: string;
      messageKey: "rssFeeds.error.joinMissingScope" | "rssFeeds.error.joinFailed";
      ok: false;
    }
> {
  try {
    await client.conversations.join({ channel: channelId });
    return { ok: true };
  } catch (error) {
    const errorCode = readSlackApiErrorCode(error);
    if (errorCode === "already_in_channel") {
      return { ok: true };
    }
    return {
      errorCode,
      messageKey:
        errorCode === "missing_scope"
          ? "rssFeeds.error.joinMissingScope"
          : "rssFeeds.error.joinFailed",
      ok: false,
    };
  }
}

async function updateRssFeedModal(
  client: SlackClient,
  view: unknown,
  modal: Record<string, unknown>,
  logger: unknown,
): Promise<void> {
  const viewId = isRecord(view) ? readString(view, "id") : undefined;
  if (viewId === undefined) {
    logWarn(logger, "Could not update RSS feed modal without Slack view id.", {});
    return;
  }
  try {
    await client.views.update({
      view: modal as never,
      view_id: viewId,
    });
  } catch (error) {
    logWarn(logger, "Failed to update RSS feed modal.", { error, viewId });
  }
}

function buildFeatureSettingsModal(input: {
  enterpriseId?: string;
  imageAllowedChannelIds: readonly string[];
  imageAllowDirectMessages: boolean;
  imageEnabled: boolean;
  imageGenerationModelId: string;
  imageGenerationModelOptions: readonly SlackOption[];
  teamId: string;
  textToSpeechAllowedChannelIds: readonly string[];
  textToSpeechEnabled: boolean;
  textToSpeechModelId?: string;
  textToSpeechModelOptions: readonly SlackOption[];
  translator: Translator;
}): Record<string, unknown> {
  const imageEnabledOption = {
    text: { text: input.translator.t("featureSettings.image.enabled"), type: "plain_text" },
    value: "enabled",
  };
  const imageDirectMessagesOption = {
    text: {
      text: input.translator.t("featureSettings.image.directMessages"),
      type: "plain_text",
    },
    value: "enabled",
  };
  const textToSpeechEnabledOption = {
    text: { text: input.translator.t("featureSettings.tts.enabled"), type: "plain_text" },
    value: "enabled",
  };
  const initialImageGenerationModelOption =
    input.imageGenerationModelOptions.find(
      (option) => option.value === input.imageGenerationModelId,
    ) ?? input.imageGenerationModelOptions[0];
  const initialTextToSpeechModelOption =
    input.textToSpeechModelOptions.find((option) => option.value === input.textToSpeechModelId) ??
    input.textToSpeechModelOptions[0];
  return {
    blocks: [
      {
        text: {
          text: input.translator.t("featureSettings.modal.intro"),
          type: "mrkdwn",
        },
        type: "section",
      },
      {
        block_id: FEATURE_SETTINGS_IMAGE_ENABLED_BLOCK_ID,
        element: {
          action_id: FEATURE_SETTINGS_IMAGE_ENABLED_ACTION_ID,
          ...(input.imageEnabled ? { initial_options: [imageEnabledOption] } : {}),
          options: [imageEnabledOption],
          type: "checkboxes",
        },
        label: {
          text: input.translator.t("featureSettings.image.title"),
          type: "plain_text",
        },
        optional: true,
        type: "input",
      },
      ...(input.imageGenerationModelOptions.length === 0
        ? []
        : [
            {
              block_id: FEATURE_SETTINGS_IMAGE_MODEL_BLOCK_ID,
              element: {
                action_id: FEATURE_SETTINGS_IMAGE_MODEL_ACTION_ID,
                ...(initialImageGenerationModelOption === undefined
                  ? {}
                  : { initial_option: initialImageGenerationModelOption }),
                options: input.imageGenerationModelOptions,
                placeholder: {
                  text: input.translator.t("featureSettings.image.modelPlaceholder"),
                  type: "plain_text",
                },
                type: "static_select",
              },
              label: {
                text: input.translator.t("featureSettings.image.model"),
                type: "plain_text",
              },
              optional: false,
              type: "input",
            },
          ]),
      {
        block_id: FEATURE_SETTINGS_IMAGE_DIRECT_MESSAGES_BLOCK_ID,
        element: {
          action_id: FEATURE_SETTINGS_IMAGE_DIRECT_MESSAGES_ACTION_ID,
          ...(input.imageAllowDirectMessages
            ? { initial_options: [imageDirectMessagesOption] }
            : {}),
          options: [imageDirectMessagesOption],
          type: "checkboxes",
        },
        label: {
          text: input.translator.t("featureSettings.image.directMessages"),
          type: "plain_text",
        },
        optional: true,
        type: "input",
      },
      {
        block_id: FEATURE_SETTINGS_IMAGE_CHANNELS_BLOCK_ID,
        element: {
          action_id: FEATURE_SETTINGS_IMAGE_CHANNELS_ACTION_ID,
          filter: {
            exclude_bot_users: true,
            include: ["public", "private"],
          },
          ...(input.imageAllowedChannelIds.length > 0
            ? { initial_conversations: input.imageAllowedChannelIds }
            : {}),
          placeholder: {
            text: input.translator.t("featureSettings.channels.placeholder"),
            type: "plain_text",
          },
          type: "multi_conversations_select",
        },
        label: {
          text: input.translator.t("featureSettings.channels.label"),
          type: "plain_text",
        },
        optional: true,
        type: "input",
      },
      {
        block_id: FEATURE_SETTINGS_TTS_ENABLED_BLOCK_ID,
        element: {
          action_id: FEATURE_SETTINGS_TTS_ENABLED_ACTION_ID,
          ...(input.textToSpeechEnabled ? { initial_options: [textToSpeechEnabledOption] } : {}),
          options: [textToSpeechEnabledOption],
          type: "checkboxes",
        },
        label: {
          text: input.translator.t("featureSettings.tts.title"),
          type: "plain_text",
        },
        optional: true,
        type: "input",
      },
      ...(input.textToSpeechModelOptions.length === 0
        ? []
        : [
            {
              block_id: FEATURE_SETTINGS_TTS_MODEL_BLOCK_ID,
              element: {
                action_id: FEATURE_SETTINGS_TTS_MODEL_ACTION_ID,
                ...(initialTextToSpeechModelOption === undefined
                  ? {}
                  : { initial_option: initialTextToSpeechModelOption }),
                options: input.textToSpeechModelOptions,
                placeholder: {
                  text: input.translator.t("featureSettings.tts.modelPlaceholder"),
                  type: "plain_text",
                },
                type: "static_select",
              },
              label: {
                text: input.translator.t("featureSettings.tts.model"),
                type: "plain_text",
              },
              optional: false,
              type: "input",
            },
          ]),
      {
        block_id: FEATURE_SETTINGS_TTS_CHANNELS_BLOCK_ID,
        element: {
          action_id: FEATURE_SETTINGS_TTS_CHANNELS_ACTION_ID,
          filter: {
            exclude_bot_users: true,
            include: ["public", "private"],
          },
          ...(input.textToSpeechAllowedChannelIds.length > 0
            ? { initial_conversations: input.textToSpeechAllowedChannelIds }
            : {}),
          placeholder: {
            text: input.translator.t("featureSettings.channels.placeholder"),
            type: "plain_text",
          },
          type: "multi_conversations_select",
        },
        label: {
          text: input.translator.t("featureSettings.channels.label"),
          type: "plain_text",
        },
        optional: true,
        type: "input",
      },
    ],
    callback_id: FEATURE_SETTINGS_MODAL_CALLBACK_ID,
    close: { text: input.translator.t("common.cancel"), type: "plain_text" },
    private_metadata: JSON.stringify({
      enterpriseId: input.enterpriseId,
      source: "app_home",
      teamId: input.teamId,
    }),
    submit: { text: input.translator.t("common.save"), type: "plain_text" },
    title: { text: input.translator.t("featureSettings.title"), type: "plain_text" },
    type: "modal",
  };
}

function buildFeatureSettingsResultModal(
  message: string,
  translator: Translator,
): Record<string, unknown> {
  return {
    blocks: [
      {
        text: { text: message, type: "mrkdwn" },
        type: "section",
      },
    ],
    close: { text: translator.t("common.close"), type: "plain_text" },
    title: { text: translator.t("featureSettings.title"), type: "plain_text" },
    type: "modal",
  };
}

async function updateFeatureSettingsModal(
  client: SlackClient,
  view: unknown,
  modal: Record<string, unknown>,
  logger: unknown,
): Promise<void> {
  const viewId = isRecord(view) ? readString(view, "id") : undefined;
  if (viewId === undefined) {
    logWarn(logger, "Could not update feature settings modal without Slack view id.", {});
    return;
  }
  try {
    await client.views.update({
      view: modal as never,
      view_id: viewId,
    });
  } catch (error) {
    logWarn(logger, "Failed to update feature settings modal.", { error, viewId });
  }
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

async function handleAssistantThreadEvent(
  {
    body,
    client,
    event,
    logger,
  }: SlackEventArgs<"assistant_thread_context_changed" | "assistant_thread_started">,
  options: AgentSlackHandlerOptions,
): Promise<void> {
  const assistantThread = readAssistantThread(event);
  if (assistantThread === undefined) {
    logWarn(logger, "Ignoring Slack assistant thread event without assistant_thread details.", {
      eventType: readString(event, "type"),
    });
    return;
  }
  const teamId = readTeamId(body, event);
  if (teamId === undefined) {
    logWarn(logger, "Ignoring Slack assistant thread event without a team id.", {
      channelId: assistantThread.channelId,
      threadTs: assistantThread.threadTs,
    });
    return;
  }
  if (options.routingRepository === undefined) {
    logWarn(logger, "Ignoring Slack assistant thread event without routing repository.", {
      channelId: assistantThread.channelId,
      teamId,
      threadTs: assistantThread.threadTs,
    });
    return;
  }

  const accessibleAssistantThread = await assistantThreadWithAccessibleContext({
    assistantThread,
    client,
    clearMissingContext: readString(event, "type") === "assistant_thread_context_changed",
    logger,
  });
  try {
    await saveAssistantThreadState({
      assistantThread: accessibleAssistantThread,
      eventTs: readString(event, "event_ts"),
      logger,
      repository: options.routingRepository,
      teamId,
    });
  } catch (error) {
    logWarn(logger, "Failed to persist Slack assistant thread state.", {
      channelId: accessibleAssistantThread.channelId,
      error,
      teamId,
      threadTs: accessibleAssistantThread.threadTs,
    });
  }
}

async function assistantThreadWithAccessibleContext(input: {
  assistantThread: SlackAssistantThread;
  clearMissingContext: boolean;
  client: Pick<SlackClient, "conversations">;
  logger: unknown;
}): Promise<SlackAssistantThread> {
  const contextChannelId = input.assistantThread.contextChannelId;
  if (contextChannelId === undefined) {
    return input.clearMissingContext
      ? {
          ...input.assistantThread,
          clearContext: true,
        }
      : input.assistantThread;
  }
  try {
    await input.client.conversations.info({ channel: contextChannelId });
    return input.assistantThread;
  } catch (error) {
    const errorCode = slackWebApiErrorCode(error);
    if (errorCode === "channel_not_found" || errorCode === "not_in_channel") {
      logWarn(input.logger, "Ignoring inaccessible Slack assistant thread context channel.", {
        channelId: input.assistantThread.channelId,
        contextChannelId,
        error,
        threadTs: input.assistantThread.threadTs,
      });
      return {
        ...input.assistantThread,
        clearContext: true,
        contextChannelId: undefined,
        contextEnterpriseId: undefined,
        contextTeamId: undefined,
      };
    }
    logWarn(input.logger, "Ignoring inaccessible Slack assistant thread context channel.", {
      channelId: input.assistantThread.channelId,
      contextChannelId,
      error,
      threadTs: input.assistantThread.threadTs,
    });
    return input.assistantThread;
  }
}

type SlackAssistantThread = {
  channelId: string;
  clearContext?: boolean;
  contextChannelId?: string;
  contextEnterpriseId?: string;
  contextTeamId?: string;
  threadTs: string;
  userId?: string;
};

async function saveAssistantThreadState(input: {
  assistantThread: SlackAssistantThread;
  eventTs?: string;
  logger: unknown;
  repository: SlackAgentRoutingRepository;
  teamId: string;
}): Promise<void> {
  const { assistantThread, repository, teamId } = input;
  const existing = await repository.findSlackThread(
    teamId,
    assistantThread.channelId,
    assistantThread.threadTs,
  );
  const now = new Date();
  const createdAt = new Date(stringField(existing, "created_at") ?? now.toISOString());
  const agentId = stringField(existing, "agent_id") ?? "assistant";
  const lastMessageTs = stringField(existing, "last_message_ts") ?? input.eventTs;
  const payload: JsonObject = {
    ...existing,
    agent_id: agentId,
    assistant_thread_channel_id: assistantThread.channelId,
    ...(assistantThread.contextChannelId === undefined
      ? {}
      : { assistant_thread_context_channel_id: assistantThread.contextChannelId }),
    ...(assistantThread.contextEnterpriseId === undefined
      ? {}
      : { assistant_thread_context_enterprise_id: assistantThread.contextEnterpriseId }),
    ...(assistantThread.contextTeamId === undefined
      ? {}
      : { assistant_thread_context_team_id: assistantThread.contextTeamId }),
    ...(assistantThread.userId === undefined
      ? {}
      : { assistant_thread_user_id: assistantThread.userId }),
    channel_id: assistantThread.channelId,
    created_at: createdAt.toISOString(),
    ...(lastMessageTs === undefined ? {} : { last_message_ts: lastMessageTs }),
    root_message_ts: stringField(existing, "root_message_ts") ?? assistantThread.threadTs,
    source: "assistant_view",
    status: "active",
    team_id: teamId,
    thread_ts: assistantThread.threadTs,
    updated_at: now.toISOString(),
  };
  if (assistantThread.clearContext === true) {
    delete payload.assistant_thread_context_channel_id;
    delete payload.assistant_thread_context_enterprise_id;
    delete payload.assistant_thread_context_team_id;
  }

  if (repository.saveSlackThread !== undefined) {
    await repository.saveSlackThread({
      agentId,
      channelId: assistantThread.channelId,
      createdAt,
      lastMessageTs: stringField(payload, "last_message_ts"),
      modelId: stringField(existing, "model_id"),
      payload,
      reasoningEffort: stringField(existing, REASONING_EFFORT_FIELD),
      rootMessageTs: stringField(payload, "root_message_ts") ?? assistantThread.threadTs,
      status: "active",
      teamId,
      threadTs: assistantThread.threadTs,
      updatedAt: now,
    });
    return;
  }

  try {
    await repository.activateThreadAgent({
      agentId,
      channelId: assistantThread.channelId,
      lastMessageTs: input.eventTs ?? assistantThread.threadTs,
      modelId: stringField(existing, "model_id"),
      reasoningEffort: stringField(existing, REASONING_EFFORT_FIELD),
      rootMessageTs: stringField(existing, "root_message_ts") ?? assistantThread.threadTs,
      teamId,
      threadTs: assistantThread.threadTs,
    });
  } catch (error) {
    logWarn(input.logger, "Failed to persist Slack assistant thread state.", {
      channelId: assistantThread.channelId,
      error,
      teamId,
      threadTs: assistantThread.threadTs,
    });
  }
}

function readAssistantThread(event: StringIndexed): SlackAssistantThread | undefined {
  const assistantThread = event.assistant_thread;
  if (!isRecord(assistantThread)) {
    return undefined;
  }
  const channelId = readString(assistantThread, "channel_id");
  const threadTs = readString(assistantThread, "thread_ts");
  if (channelId === undefined || threadTs === undefined) {
    return undefined;
  }
  const context = isRecord(assistantThread.context) ? assistantThread.context : undefined;
  return {
    channelId,
    contextChannelId: context === undefined ? undefined : readString(context, "channel_id"),
    contextEnterpriseId: context === undefined ? undefined : readString(context, "enterprise_id"),
    contextTeamId: context === undefined ? undefined : readString(context, "team_id"),
    threadTs,
    userId: readString(assistantThread, "user_id"),
  };
}

async function handleMention(
  { body, client, context, event, logger, sayStream }: SlackEventArgs<"app_mention">,
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
  const hasMentionAttachmentInput = hasSlackAttachmentInput(event);
  if (options.agentJobQueue !== undefined) {
    if (
      options.routingRepository !== undefined &&
      !(await options.routingRepository.isChannelEnabled(teamId, event.channel))
    ) {
      return;
    }
    if (mentionText.length === 0 && !hasMentionAttachmentInput) {
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
        hasAttachmentInput: hasMentionAttachmentInput,
        isEnterpriseInstall: readSlackEnterpriseInstall(body),
        messageTs: event.ts,
        retryNum: readOptionalContextValue(context.retryNum),
        retryReason: readOptionalContextValue(context.retryReason),
        slackAppKey: AGENTS_SLACK_APP_KEY,
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
  let postedResult = false;
  let text: string;
  try {
    if (
      options.routingRepository !== undefined &&
      !(await options.routingRepository.isChannelEnabled(teamId, event.channel))
    ) {
      return;
    }
    if (mentionText.length === 0 && !hasMentionAttachmentInput) {
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
    const threadMessages = await readThreadMessages(client, event.channel, threadTs);
    const referenceImages = await resolveReferenceImagesForInvocation({
      client,
      event,
      messages: threadMessages,
      options,
    });
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
    const validatedRoute = await validateSlackAgentRouteForRunner({
      channelId: event.channel,
      eventType: "app_mention",
      logger,
      route,
      routingRepository: options.routingRepository,
      teamId,
      threadTs,
    });
    if (!validatedRoute.valid) {
      await postNoEnabledModelConfiguredMessage({
        channelId: event.channel,
        client,
        text: translator.t("modelRouting.error.noEnabledModel"),
        threadTs,
      });
      return;
    }
    await notifyModelFallback({
      channelId: event.channel,
      client,
      logger,
      route: validatedRoute.route,
      threadTs,
      translator,
      userId: event.user,
    });
    const invocation = {
      channelId: event.channel,
      enterpriseId: readSlackEnterpriseId(body),
      isEnterpriseInstall: readSlackEnterpriseInstall(body),
      messageTs: event.ts,
      modelId: validatedRoute.route?.modelId,
      referenceImages,
      reasoningEffort: validatedRoute.route?.reasoningEffort,
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
    };
    const runtimeOptions = imageGenerationRuntimeOptions({
      channelId: event.channel,
      client,
      logger,
      threadTs,
      translator,
      userId: event.user,
    });
    const streamingResult =
      sayStream === undefined
        ? undefined
        : await tryPostStreamingAgentRun({
            channel: event.channel,
            client,
            invocation,
            logger,
            runner,
            runtimeOptions,
            startStream: () => sayStream({ buffer_size: SLACK_AGENT_STREAM_BUFFER_SIZE }),
            threadTs,
            translator,
          });
    if (streamingResult?.type === "posted-error") {
      return;
    }
    postedResult = streamingResult?.type === "success";
    const result =
      streamingResult?.type === "success"
        ? streamingResult.result
        : await runner.run(invocation, runtimeOptions);
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
          modelId: threadScopedModelId(validatedRoute.route),
          reasoningEffort: threadScopedReasoningEffort(validatedRoute.route),
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
    if (
      await postImageInputErrorMessage({
        channelId: event.channel,
        client,
        error,
        logger,
        threadTs,
        userId: event.user,
      })
    ) {
      return;
    }
    text = runnerUserFacingErrorMessage(error, translator);
  }

  if (postedResult) {
    return;
  }
  await postAgentResult({
    channel: event.channel,
    client,
    logger,
    result: runnerResult,
    sayStream,
    text,
    threadTs,
  });
}

async function handleMessage(
  { body, client, context, event, logger, sayStream }: SlackEventArgs<"message">,
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
  if (!isSupportedFollowUpMessage(event, threadTs)) {
    return;
  }
  if (threadTs === undefined) {
    return;
  }
  if (options.routingRepository === undefined) {
    await postImageInputValidationErrorForEvent({
      channelId: event.channel,
      client,
      event,
      options,
      threadTs,
      userId: event.user,
    });
    return;
  }

  const thread = await options.routingRepository.findSlackThread(teamId, event.channel, threadTs);
  if (!isActiveThread(thread)) {
    return;
  }
  const routeChannelId = slackThreadRouteChannelId(thread, event.channel);
  const [autoReplyEnabled, channelEnabled] = await Promise.all([
    options.routingRepository.isThreadAutoReplyEnabled(teamId, routeChannelId),
    options.routingRepository.isChannelEnabled(teamId, routeChannelId),
  ]);
  if (!channelEnabled || !autoReplyEnabled) {
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
  const hasMessageAttachmentInput = hasSlackAttachmentInput(event);
  if (isMentionOnlyText(messageText, context?.botUserId) && !hasMessageAttachmentInput) {
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
      routeChannelId,
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
        hasAttachmentInput: hasMessageAttachmentInput,
        isEnterpriseInstall: readSlackEnterpriseInstall(body),
        messageTs: event.ts,
        retryNum: readOptionalContextValue(context.retryNum),
        retryReason: readOptionalContextValue(context.retryReason),
        slackAppKey: AGENTS_SLACK_APP_KEY,
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
  let postedResult = false;
  let text: string;
  try {
    const threadMessages = await readThreadMessages(client, event.channel, threadTs);
    const referenceImages = await resolveReferenceImagesForInvocation({
      client,
      event,
      messages: threadMessages,
      options,
    });
    const route = await resolveSlackAgentRoute(options.routingRepository, {
      channelId: routeChannelId,
      teamId,
      threadChannelId: event.channel,
      threadTs,
    });
    if (options.routingRepository.resolveAgent !== undefined && route === undefined) {
      return;
    }
    const validatedRoute = await validateSlackAgentRouteForRunner({
      channelId: routeChannelId,
      eventType: "message_follow_up",
      logger,
      route,
      routingRepository: options.routingRepository,
      teamId,
      thread,
      threadChannelId: event.channel,
      threadTs,
    });
    if (!validatedRoute.valid) {
      await postNoEnabledModelEphemeral({
        channelId: event.channel,
        client,
        logger,
        text: translator.t("modelRouting.error.noEnabledModel"),
        threadTs,
        userId: event.user,
      });
      return;
    }
    await notifyModelFallback({
      channelId: event.channel,
      client,
      logger,
      route: validatedRoute.route,
      threadTs,
      translator,
      userId: event.user,
    });
    const modelId =
      validatedRoute.route === undefined
        ? stringField(thread, "model_id")
        : validatedRoute.route.modelId;
    const reasoningEffort =
      validatedRoute.route === undefined
        ? stringField(thread, REASONING_EFFORT_FIELD)
        : validatedRoute.route.reasoningEffort;
    const invocation = {
      channelId: event.channel,
      enterpriseId: readSlackEnterpriseId(body),
      isEnterpriseInstall: readSlackEnterpriseInstall(body),
      messageTs: event.ts,
      modelId,
      referenceImages,
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
      viewerContextChannelIds: slackThreadViewerContextChannelIds(thread, event.channel, teamId),
    };
    const runtimeOptions = imageGenerationRuntimeOptions({
      channelId: event.channel,
      client,
      logger,
      threadTs,
      translator,
      userId: event.user,
    });
    const streamingResult =
      sayStream === undefined
        ? undefined
        : await tryPostStreamingAgentRun({
            channel: event.channel,
            client,
            invocation,
            logger,
            runner,
            runtimeOptions,
            startStream: () => sayStream({ buffer_size: SLACK_AGENT_STREAM_BUFFER_SIZE }),
            threadTs,
            translator,
          });
    if (streamingResult?.type === "posted-error") {
      return;
    }
    postedResult = streamingResult?.type === "success";
    const result =
      streamingResult?.type === "success"
        ? streamingResult.result
        : await runner.run(invocation, runtimeOptions);
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
        modelId:
          validatedRoute.route === undefined
            ? stringField(thread, "model_id")
            : threadScopedModelId(validatedRoute.route),
        reasoningEffort:
          validatedRoute.route === undefined
            ? stringField(thread, REASONING_EFFORT_FIELD)
            : threadScopedReasoningEffort(validatedRoute.route),
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
    if (
      await postImageInputErrorMessage({
        channelId: event.channel,
        client,
        error,
        logger,
        threadTs,
        userId: event.user,
      })
    ) {
      return;
    }
    text = runnerUserFacingErrorMessage(error, translator);
  }

  if (postedResult) {
    return;
  }
  await postAgentResult({
    channel: event.channel,
    client,
    logger,
    result: runnerResult,
    sayStream,
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
    imageFetchFn?: typeof fetch;
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
    imageFetchFn?: typeof fetch;
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
  const hasLegacyAttachmentInput =
    job.text.trim().length === 0 && !queuedJobMayHaveAttachmentInput(job)
      ? await queuedJobHasLegacyAttachmentInput(input.client, job)
      : false;
  if (
    job.text.trim().length === 0 &&
    !queuedJobMayHaveAttachmentInput(job) &&
    !hasLegacyAttachmentInput
  ) {
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
  let postedResult = false;
  let text: string;
  try {
    const threadMessages = await readThreadMessagesForQueuedJob(input.client, job, {
      forceAttachmentInput: hasLegacyAttachmentInput,
    });
    const referenceImages = await resolveReferenceImagesForInvocation({
      client: input.client,
      messages: threadMessages,
      options: input,
    });
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
    const validatedRoute = await validateSlackAgentRouteForRunner({
      channelId: job.channelId,
      eventType: "app_mention",
      logger: input.logger,
      route,
      routingRepository: input.routingRepository,
      teamId: job.teamId,
      threadTs: job.threadTs,
    });
    if (!validatedRoute.valid) {
      await postNoEnabledModelConfiguredMessage({
        channelId: job.channelId,
        client: input.client,
        text: translator.t("modelRouting.error.noEnabledModel"),
        threadTs: job.threadTs,
      });
      return;
    }
    await notifyModelFallback({
      channelId: job.channelId,
      client: input.client,
      logger: input.logger,
      route: validatedRoute.route,
      threadTs: job.threadTs,
      translator,
      userId: job.userId,
    });
    const invocation = {
      channelId: job.channelId,
      enterpriseId: job.enterpriseId,
      isEnterpriseInstall: job.isEnterpriseInstall,
      messageTs: job.messageTs,
      modelId: validatedRoute.route?.modelId,
      referenceImages,
      reasoningEffort: validatedRoute.route?.reasoningEffort,
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
    };
    const runtimeOptions = imageGenerationRuntimeOptions({
      channelId: job.channelId,
      client: input.client,
      logger: input.logger,
      threadTs: job.threadTs,
      translator,
      userId: job.userId,
    });
    const streamingResult = await tryPostStreamingAgentRun({
      channel: job.channelId,
      client: input.client,
      invocation,
      logger: input.logger,
      runner: input.runner,
      runtimeOptions,
      startStream: createSlackClientStreamStarter({
        channelId: job.channelId,
        client: input.client,
        teamId: job.teamId,
        threadTs: job.threadTs,
        userId: job.userId,
      }),
      threadTs: job.threadTs,
      translator,
    });
    if (streamingResult.type === "posted-error") {
      return;
    }
    postedResult = streamingResult.type === "success";
    const result =
      streamingResult.type === "success"
        ? streamingResult.result
        : await input.runner.run(invocation, runtimeOptions);
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
          modelId: threadScopedModelId(validatedRoute.route),
          reasoningEffort: threadScopedReasoningEffort(validatedRoute.route),
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
    if (
      await postImageInputErrorMessage({
        channelId: job.channelId,
        client: input.client,
        error,
        logger: input.logger,
        threadTs: job.threadTs,
        userId: job.userId,
      })
    ) {
      return;
    }
    if (shouldRetryJobFailure(error, input.retryContext)) {
      throw error;
    }
    text = runnerUserFacingErrorMessage(error, translator);
  }

  if (postedResult) {
    return;
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
    imageFetchFn?: typeof fetch;
    logger: unknown;
    retryContext?: SlackAgentJobRetryContext;
    routingRepository?: SlackAgentRoutingRepository;
    runner: AgentRunner;
    userSettingsRepository?: UserSettingsRepository;
  },
): Promise<void> {
  if (input.routingRepository === undefined) {
    await postImageInputValidationErrorForQueuedJob({ input, job });
    return;
  }
  const thread = await input.routingRepository.findSlackThread(
    job.teamId,
    job.channelId,
    job.threadTs,
  );
  if (!isActiveThread(thread)) {
    return;
  }
  const routeChannelId = slackThreadRouteChannelId(thread, job.channelId);
  const [autoReplyEnabled, channelEnabled] = await Promise.all([
    input.routingRepository.isThreadAutoReplyEnabled(job.teamId, routeChannelId),
    input.routingRepository.isChannelEnabled(job.teamId, routeChannelId),
  ]);
  if (!channelEnabled || !autoReplyEnabled) {
    return;
  }

  const translator = await resolveHandlerTranslator(
    { enterpriseId: job.enterpriseId, teamId: job.teamId },
    job.userId,
    input,
    input.logger,
  );
  if (isMentionOnlyText(job.text, job.botUserId) && !queuedJobMayHaveAttachmentInput(job)) {
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
      routeChannelId,
      routingRepository: input.routingRepository,
      teamId: job.teamId,
      threadTs: job.threadTs,
    });
    return;
  }
  let runnerResult: AgentRunnerResult | undefined;
  let postedResult = false;
  let text: string;
  try {
    const threadMessages = await readThreadMessagesForQueuedJob(input.client, job);
    const referenceImages = await resolveReferenceImagesForInvocation({
      client: input.client,
      messages: threadMessages,
      options: input,
    });
    const route = await resolveSlackAgentRoute(input.routingRepository, {
      channelId: routeChannelId,
      teamId: job.teamId,
      threadChannelId: job.channelId,
      threadTs: job.threadTs,
    });
    if (input.routingRepository.resolveAgent !== undefined && route === undefined) {
      return;
    }
    const validatedRoute = await validateSlackAgentRouteForRunner({
      channelId: routeChannelId,
      eventType: "message_follow_up",
      logger: input.logger,
      route,
      routingRepository: input.routingRepository,
      teamId: job.teamId,
      thread,
      threadChannelId: job.channelId,
      threadTs: job.threadTs,
    });
    if (!validatedRoute.valid) {
      await postNoEnabledModelEphemeral({
        channelId: job.channelId,
        client: input.client,
        logger: input.logger,
        text: translator.t("modelRouting.error.noEnabledModel"),
        threadTs: job.threadTs,
        userId: job.userId,
      });
      return;
    }
    await notifyModelFallback({
      channelId: job.channelId,
      client: input.client,
      logger: input.logger,
      route: validatedRoute.route,
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
    const modelId =
      validatedRoute.route === undefined
        ? stringField(thread, "model_id")
        : validatedRoute.route.modelId;
    const reasoningEffort =
      validatedRoute.route === undefined
        ? stringField(thread, REASONING_EFFORT_FIELD)
        : validatedRoute.route.reasoningEffort;
    const invocation = {
      channelId: job.channelId,
      enterpriseId: job.enterpriseId,
      isEnterpriseInstall: job.isEnterpriseInstall,
      messageTs: job.messageTs,
      modelId,
      referenceImages,
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
      viewerContextChannelIds: slackThreadViewerContextChannelIds(
        thread,
        job.channelId,
        job.teamId,
      ),
    };
    const runtimeOptions = imageGenerationRuntimeOptions({
      channelId: job.channelId,
      client: input.client,
      logger: input.logger,
      threadTs: job.threadTs,
      translator,
      userId: job.userId,
    });
    const streamingResult = await tryPostStreamingAgentRun({
      channel: job.channelId,
      client: input.client,
      invocation,
      logger: input.logger,
      runner: input.runner,
      runtimeOptions,
      startStream: createSlackClientStreamStarter({
        channelId: job.channelId,
        client: input.client,
        teamId: job.teamId,
        threadTs: job.threadTs,
        userId: job.userId,
      }),
      threadTs: job.threadTs,
      translator,
    });
    if (streamingResult.type === "posted-error") {
      return;
    }
    postedResult = streamingResult.type === "success";
    const result =
      streamingResult.type === "success"
        ? streamingResult.result
        : await input.runner.run(invocation, runtimeOptions);
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
        modelId:
          validatedRoute.route === undefined
            ? stringField(thread, "model_id")
            : threadScopedModelId(validatedRoute.route),
        reasoningEffort:
          validatedRoute.route === undefined
            ? stringField(thread, REASONING_EFFORT_FIELD)
            : threadScopedReasoningEffort(validatedRoute.route),
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
    if (
      await postImageInputErrorMessage({
        channelId: job.channelId,
        client: input.client,
        error,
        logger: input.logger,
        threadTs: job.threadTs,
        userId: job.userId,
      })
    ) {
      return;
    }
    if (shouldRetryJobFailure(error, input.retryContext)) {
      throw error;
    }
    text = runnerUserFacingErrorMessage(error, translator);
  }

  if (postedResult) {
    return;
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
    const validatedRoute = await validateSlackAgentRouteForRunner({
      channelId: job.channelId,
      eventType: "reaction_added",
      logger: input.logger,
      route,
      routingRepository: input.routingRepository,
      teamId: job.teamId,
      threadTs,
    });
    if (!validatedRoute.valid) {
      await postNoEnabledModelEphemeral({
        channelId: job.channelId,
        client: input.client,
        logger: input.logger,
        text: translator.t("modelRouting.error.noEnabledModel"),
        threadTs,
        userId: job.userId,
      });
      return;
    }
    await notifyModelFallback({
      channelId: job.channelId,
      client: input.client,
      logger: input.logger,
      route: validatedRoute.route,
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
        enterpriseId: job.enterpriseId,
        isEnterpriseInstall: job.isEnterpriseInstall,
        messageTs: job.messageTs,
        modelId: validatedRoute.route?.modelId,
        reasoningEffort: validatedRoute.route?.reasoningEffort,
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
    if (shouldRetryJobFailure(error, input.retryContext)) {
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
  routeChannelId?: string;
  routingRepository?: SlackAgentRoutingRepository;
  teamId: string;
  threadTs: string;
}): Promise<void> {
  const route = await resolveSlackAgentRoute(input.routingRepository, {
    channelId: input.routeChannelId ?? input.channelId,
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

async function postNoEnabledModelConfiguredMessage(input: {
  channelId: string;
  client: SlackAgentClient;
  text: string;
  threadTs: string;
}): Promise<void> {
  await input.client.chat.postMessage({
    channel: input.channelId,
    text: input.text,
    thread_ts: input.threadTs,
  });
}

async function postNoEnabledModelEphemeral(input: {
  channelId: string;
  client: SlackAgentClient;
  logger: unknown;
  text: string;
  threadTs: string;
  userId?: string;
}): Promise<void> {
  if (input.userId === undefined || input.client.chat.postEphemeral === undefined) {
    logWarn(input.logger, "Cannot post no-enabled-model ephemeral Slack message.", {
      channelId: input.channelId,
      threadTs: input.threadTs,
      userId: input.userId,
    });
    return;
  }
  try {
    await input.client.chat.postEphemeral({
      channel: input.channelId,
      text: input.text,
      thread_ts: input.threadTs,
      user: input.userId,
    });
  } catch (error) {
    logWarn(input.logger, "Failed to post no-enabled-model ephemeral Slack message.", {
      channelId: input.channelId,
      error,
      threadTs: input.threadTs,
      userId: input.userId,
    });
  }
}

function imageGenerationRuntimeOptions(input: {
  channelId: string;
  client: SlackAgentClient;
  logger: unknown;
  threadTs: string;
  translator: Translator;
  userId: string;
}): AgentRunnerRuntimeOptions {
  return {
    onImageGenerationStart: async () => {
      await postImageGenerationStartedEphemeral(input);
    },
  };
}

async function postImageGenerationStartedEphemeral(input: {
  channelId: string;
  client: SlackAgentClient;
  logger: unknown;
  threadTs: string;
  translator: Translator;
  userId: string;
}): Promise<void> {
  const postEphemeral = input.client.chat.postEphemeral;
  if (postEphemeral === undefined) {
    logWarn(input.logger, "Cannot post image generation started ephemeral Slack message.", {
      channelId: input.channelId,
      threadTs: input.threadTs,
      userId: input.userId,
    });
    return;
  }
  try {
    await postEphemeral({
      channel: input.channelId,
      text: input.translator.t("slack.notice.imageGenerationStarted"),
      thread_ts: input.threadTs,
      user: input.userId,
    });
  } catch (error) {
    logWarn(input.logger, "Failed to post image generation started ephemeral Slack message.", {
      channelId: input.channelId,
      error,
      threadTs: input.threadTs,
      userId: input.userId,
    });
  }
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

async function validateSlackAgentRouteForRunner(input: {
  channelId: string;
  eventType: string;
  logger: unknown;
  route: SlackResolvedAgentRoute | undefined;
  routingRepository?: SlackAgentRoutingRepository;
  teamId: string;
  thread?: JsonObject;
  threadChannelId?: string;
  threadTs?: string;
}): Promise<ValidatedSlackAgentRoute> {
  const repository = input.routingRepository;
  if (
    repository === undefined ||
    repository.findWorkspaceSettings === undefined ||
    repository.findChannelSettings === undefined
  ) {
    const modelId =
      input.route === undefined ? stringField(input.thread, "model_id") : input.route.modelId;
    if (modelId !== undefined && !createDefaultModelRegistry().has(modelId)) {
      logWarn(input.logger, "Rejected Slack route with unknown model before runner invocation.", {
        channelId: input.channelId,
        eventType: input.eventType,
        routeFailure: { reason: "unknown_model" },
        skippedModelIds: [modelId],
        teamId: input.teamId,
        threadTs: input.threadTs,
      });
      return { reason: "no_enabled_model", skippedModelIds: [modelId], valid: false };
    }
    return { route: input.route, valid: true };
  }

  const threadLookupChannelId = input.threadChannelId ?? input.channelId;
  const [workspaceSettings, channelSettings, thread] = await Promise.all([
    repository.findWorkspaceSettings(input.teamId),
    repository.findChannelSettings(input.teamId, input.channelId),
    input.threadTs === undefined || repository.findSlackThread === undefined
      ? Promise.resolve(input.thread)
      : repository.findSlackThread(input.teamId, threadLookupChannelId, input.threadTs),
  ]);
  const activeThread = isActiveThread(thread) ? thread : undefined;
  const enabledModelIds = stringArrayField(workspaceSettings, "enabled_model_ids");
  const candidates: Array<{ modelId?: string; scope: "channel" | "thread" | "workspace" }> = [
    {
      modelId:
        stringField(activeThread, "model_scope") === "thread"
          ? stringField(activeThread, "model_id")
          : undefined,
      scope: "thread",
    },
    { modelId: stringField(channelSettings, "default_model_id"), scope: "channel" },
    { modelId: stringField(workspaceSettings, "default_model_id"), scope: "workspace" },
  ];
  const modelRegistry = createDefaultModelRegistry();
  const skipped: Array<{ modelId: string; scope: "channel" | "thread" | "workspace" }> = [];
  let selected: { modelId: string; scope: "channel" | "thread" | "workspace" } | undefined;
  if (enabledModelIds.length > 0) {
    for (const candidate of candidates) {
      if (candidate.modelId === undefined) {
        continue;
      }
      if (modelRegistry.has(candidate.modelId) && enabledModelIds.includes(candidate.modelId)) {
        selected = { modelId: candidate.modelId, scope: candidate.scope };
        break;
      }
      skipped.push({ modelId: candidate.modelId, scope: candidate.scope });
    }
  } else {
    for (const candidate of candidates) {
      if (candidate.modelId !== undefined) {
        skipped.push({ modelId: candidate.modelId, scope: candidate.scope });
      }
    }
  }

  await repairSkippedSlackModelOverrides({
    channelId: input.channelId,
    logger: input.logger,
    repository,
    skipped,
    teamId: input.teamId,
    threadChannelId: input.threadChannelId,
    threadTs: input.threadTs,
  });

  if (selected === undefined) {
    logWarn(input.logger, "Rejected Slack route without a validated enabled model.", {
      channelId: input.channelId,
      eventType: input.eventType,
      routeFailure: { reason: "no_enabled_model" },
      skippedModelIds: skipped.map((item) => item.modelId),
      teamId: input.teamId,
      threadChannelId: input.threadChannelId,
      threadTs: input.threadTs,
    });
    return {
      reason: "no_enabled_model",
      skippedModelIds: skipped.map((item) => item.modelId),
      valid: false,
    };
  }

  const fallbackFrom = skipped[0];
  return {
    route: {
      ...(input.route ?? {
        agent: {},
        agentId: stringField(activeThread, "agent_id") ?? DEFAULT_AGENT_OPTION.id,
        scope: "thread",
      }),
      modelFallback:
        fallbackFrom === undefined
          ? input.route?.modelFallback
          : {
              fromModelId: fallbackFrom.modelId,
              fromScope: fallbackFrom.scope,
              toModelId: selected.modelId,
              toScope: selected.scope,
            },
      modelId: selected.modelId,
      modelScope: selected.scope,
      reasoningEffort: reasoningEffortForResolvedModelScope({
        channelSettings,
        scope: selected.scope,
        thread: activeThread,
        workspaceSettings,
      }),
    },
    valid: true,
  };
}

async function repairSkippedSlackModelOverrides(input: {
  channelId: string;
  logger: unknown;
  repository: SlackAgentRoutingRepository;
  skipped: readonly { modelId: string; scope: "channel" | "thread" | "workspace" }[];
  teamId: string;
  threadChannelId?: string;
  threadTs?: string;
}): Promise<void> {
  const now = new Date();
  for (const skipped of input.skipped) {
    try {
      if (skipped.scope === "thread" && input.threadTs !== undefined) {
        await input.repository.clearThreadModelOverride?.({
          channelId: input.threadChannelId ?? input.channelId,
          teamId: input.teamId,
          threadTs: input.threadTs,
          updatedAt: now,
        });
      }
      if (skipped.scope === "channel") {
        await input.repository.clearChannelModelOverride?.({
          channelId: input.channelId,
          teamId: input.teamId,
          updatedAt: now,
        });
      }
    } catch (error) {
      logWarn(input.logger, "Failed to repair invalid Slack model routing override.", {
        channelId: input.channelId,
        error,
        repair: { disabledModelId: skipped.modelId, kind: skipped.scope },
        teamId: input.teamId,
        threadChannelId: input.threadChannelId,
        threadTs: input.threadTs,
      });
    }
  }
}

function reasoningEffortForResolvedModelScope(input: {
  channelSettings?: JsonObject;
  scope: "channel" | "thread" | "workspace";
  thread?: JsonObject;
  workspaceSettings?: JsonObject;
}): string | undefined {
  switch (input.scope) {
    case "thread":
      return (
        stringField(input.thread, REASONING_EFFORT_FIELD) ??
        stringField(input.channelSettings, REASONING_EFFORT_FIELD) ??
        stringField(input.workspaceSettings, REASONING_EFFORT_FIELD)
      );
    case "channel":
      return (
        stringField(input.channelSettings, REASONING_EFFORT_FIELD) ??
        stringField(input.workspaceSettings, REASONING_EFFORT_FIELD)
      );
    case "workspace":
      return stringField(input.workspaceSettings, REASONING_EFFORT_FIELD);
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
        slackAppKey: AGENTS_SLACK_APP_KEY,
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
    const reactionUserId = readString(event, "user") ?? "unknown";
    const validatedRoute = await validateSlackAgentRouteForRunner({
      channelId,
      eventType: "reaction_added",
      logger,
      route,
      routingRepository: options.routingRepository,
      teamId,
      threadTs,
    });
    if (!validatedRoute.valid) {
      await postNoEnabledModelEphemeral({
        channelId,
        client,
        logger,
        text: translator.t("modelRouting.error.noEnabledModel"),
        threadTs,
        userId: reactionUserId,
      });
      return;
    }
    await notifyModelFallback({
      channelId,
      client,
      logger,
      route: validatedRoute.route,
      threadTs,
      translator,
      userId: reactionUserId,
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
        enterpriseId: readSlackEnterpriseId(body),
        isEnterpriseInstall: readSlackEnterpriseInstall(body),
        messageTs,
        modelId: validatedRoute.route?.modelId,
        reasoningEffort: validatedRoute.route?.reasoningEffort,
        teamId,
        text:
          `Translate the following Slack message to ${targetLanguage}.\n` +
          "Return only the structured translation result. Preserve Slack mentions, URLs, emoji, and code blocks where possible.\n\n" +
          sourceText,
        threadTs,
        userId: reactionUserId,
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
  return (readString(event, "text") ?? "").trim() !== "" || hasSlackAttachmentInput(event);
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

async function readThreadMessagesForQueuedJob(
  client: SlackAgentClient,
  job: SlackAgentJob,
  options: { forceAttachmentInput?: boolean } = {},
): Promise<StringIndexed[]> {
  const mustFindAttachmentInput =
    job.hasAttachmentInput === true || options.forceAttachmentInput === true;
  const mustUseStrictRead = mustFindAttachmentInput || queuedJobMayHaveLegacyAttachmentInput(job);
  const messages = mustUseStrictRead
    ? await readThreadMessagesStrict(client, job.channelId, job.threadTs)
    : await readThreadMessages(client, job.channelId, job.threadTs);
  if (
    mustFindAttachmentInput &&
    !messages.some(
      (message) => readString(message, "ts") === job.messageTs && hasSlackAttachmentInput(message),
    )
  ) {
    throw new SlackThreadReadError("Could not read the Slack attachment input.");
  }
  return messages;
}

function queuedJobMayHaveAttachmentInput(job: SlackAgentJob): boolean {
  return (
    job.hasAttachmentInput === true ||
    (job.eventType === "message_follow_up" &&
      job.hasAttachmentInput === undefined &&
      job.text === "")
  );
}

function queuedJobMayHaveLegacyAttachmentInput(job: SlackAgentJob): boolean {
  return (
    job.hasAttachmentInput === undefined &&
    (job.eventType === "app_mention" || job.eventType === "message_follow_up")
  );
}

async function queuedJobHasLegacyAttachmentInput(
  client: SlackAgentClient,
  job: SlackAgentJob,
): Promise<boolean> {
  if (!queuedJobMayHaveLegacyAttachmentInput(job) || job.text.trim().length !== 0) {
    return false;
  }
  const messages = await readThreadMessagesStrict(client, job.channelId, job.threadTs);
  return messages.some(
    (message) => readString(message, "ts") === job.messageTs && hasSlackAttachmentInput(message),
  );
}

async function readThreadMessagesStrict(
  client: SlackAgentClient,
  channelId: string,
  threadTs: string,
): Promise<StringIndexed[]> {
  const messages: StringIndexed[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  try {
    do {
      const response = await client.conversations.replies({
        channel: channelId,
        cursor,
        include_all_metadata: true,
        limit: SLACK_THREAD_ATTACHMENT_PAGE_LIMIT,
        ts: threadTs,
      });
      const pageMessages = Array.isArray(response.messages) ? response.messages : [];
      messages.push(
        ...pageMessages.filter((message): message is StringIndexed => isRecord(message)),
      );
      if (cursor !== undefined) {
        seenCursors.add(cursor);
      }
      const metadata = response.response_metadata;
      cursor = isRecord(metadata)
        ? readString(metadata as StringIndexed, "next_cursor")
        : undefined;
    } while (cursor !== undefined && !seenCursors.has(cursor));
    return messages;
  } catch (error) {
    throw new SlackThreadReadError("Could not read the Slack thread.", error);
  }
}

class SlackThreadReadError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SlackThreadReadError";
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

async function resolveReferenceImagesForInvocation(input: {
  client: SlackAgentClient;
  event?: StringIndexed;
  messages: readonly StringIndexed[];
  options: {
    imageFetchFn?: typeof fetch;
  };
}) {
  const messages = mergeSlackMessages(input.messages, input.event);
  return resolveSlackImageAttachments({
    clientToken: input.client.token,
    fetchFn: input.options.imageFetchFn,
    messages,
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
  if (event !== undefined && (!hasFallback || hasSlackAttachmentInput(event))) {
    merged.push(event);
  }
  return merged;
}

function hasSlackAttachmentInput(message: StringIndexed): boolean {
  return hasSlackAudioFiles(message) || hasSlackImageFiles(message);
}

function runnerUserFacingErrorMessage(error: unknown, translator: Translator): string {
  if (error instanceof SlackAudioProcessingError) {
    return error.message;
  }
  if (error instanceof SlackImageProcessingError) {
    return error.message;
  }
  return translator.t("slack.error.genericRequest");
}

async function postImageInputErrorMessage(input: {
  channelId: string;
  client: SlackAgentClient;
  error: unknown;
  logger?: unknown;
  threadTs: string;
  userId: string;
}): Promise<boolean> {
  if (
    !(input.error instanceof SlackImageProcessingError) ||
    input.error.code === "download_failed"
  ) {
    return false;
  }
  const postEphemeral = input.client.chat.postEphemeral;
  if (postEphemeral === undefined) {
    return true;
  }
  try {
    await postEphemeral({
      channel: input.channelId,
      text: input.error.message,
      thread_ts: input.threadTs,
      user: input.userId,
    });
  } catch (error) {
    logWarn(input.logger, "Failed to post Slack image input validation message.", { error });
  }
  return true;
}

async function postImageInputValidationErrorForEvent(input: {
  channelId: string;
  client: SlackAgentClient;
  event: StringIndexed;
  options: {
    imageFetchFn?: typeof fetch;
  };
  threadTs: string;
  userId: string;
}): Promise<void> {
  try {
    validateSlackImageAttachments([input.event]);
  } catch (error) {
    await postImageInputErrorMessage({
      channelId: input.channelId,
      client: input.client,
      error,
      threadTs: input.threadTs,
      userId: input.userId,
    });
  }
}

async function postImageInputValidationErrorForQueuedJob(input: {
  input: {
    client: SlackAgentClient;
    imageFetchFn?: typeof fetch;
    logger?: unknown;
    retryContext?: SlackAgentJobRetryContext;
  };
  job: SlackAgentJob;
}): Promise<void> {
  if (!queuedJobMayHaveAttachmentInput(input.job)) {
    return;
  }
  try {
    const messages = await readThreadMessagesForQueuedJob(input.input.client, input.job);
    validateSlackImageAttachments(messages);
  } catch (error) {
    const posted = await postImageInputErrorMessage({
      channelId: input.job.channelId,
      client: input.input.client,
      error,
      logger: input.input.logger,
      threadTs: input.job.threadTs,
      userId: input.job.userId,
    });
    if (!posted && shouldRetryJobFailure(error, input.input.retryContext)) {
      throw error;
    }
  }
}

export async function postAgentResult(input: {
  channel: string;
  client: SlackAgentClient;
  logger: unknown;
  result: AgentRunnerResult | undefined;
  sayStream?: SayStreamFn;
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
  if (
    suffix === undefined &&
    input.sayStream !== undefined &&
    (await postStreamingAgentMessage({
      channel: input.channel,
      logger: input.logger,
      sayStream: input.sayStream,
      text: input.text,
      threadTs: input.threadTs,
    }))
  ) {
    return;
  }

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

type StreamingAgentRunOutcome =
  | {
      result: AgentRunnerResult;
      type: "success";
    }
  | {
      type: "posted-error";
    }
  | {
      type: "unsupported";
    };

async function tryPostStreamingAgentRun(input: {
  channel: string;
  client: SlackAgentClient;
  invocation: unknown;
  logger: unknown;
  runner: AgentRunner;
  runtimeOptions: AgentRunnerRuntimeOptions;
  startStream(): SlackAgentMessageStream | undefined;
  threadTs: string;
  translator: Translator;
}): Promise<StreamingAgentRunOutcome> {
  const runStream = (input.runner as { runStream?: unknown }).runStream;
  if (typeof runStream !== "function") {
    return { type: "unsupported" };
  }

  let stream: SlackAgentMessageStream | undefined;
  let streamedText = "";
  const ensureStream = () => {
    stream ??= input.startStream();
    if (stream === undefined) {
      throw new Error("Slack chat streaming is not available for this delivery path.");
    }
    return stream;
  };
  try {
    let finalResult: AgentRunnerResult | undefined;
    for await (const event of runStream.call(
      input.runner,
      input.invocation,
      input.runtimeOptions,
    ) as AsyncIterable<AgentRunnerStreamEvent>) {
      if (event.type === "text-delta") {
        if (event.text.length === 0) {
          continue;
        }
        await ensureStream().append({ markdown_text: event.text });
        streamedText += event.text;
        continue;
      }
      finalResult = event.result;
    }
    if (finalResult === undefined) {
      throw new Error("Agent stream ended without a final result.");
    }

    await appendStreamingResultHandoff({
      channel: input.channel,
      client: input.client,
      ensureStream,
      result: finalResult,
      streamedText,
      threadTs: input.threadTs,
    });
    if (
      streamedText.length === 0 &&
      readGeneratedMedia(finalResult.structuredResult) === undefined
    ) {
      await ensureStream().append({ markdown_text: finalResult.message });
    }
    await stream?.stop();
    logInfo(input.logger, "Delivered agent message to Slack with live stream.", {
      channelId: input.channel,
      delivery: "live_stream",
      threadTs: input.threadTs,
    });
    return { result: finalResult, type: "success" };
  } catch (error) {
    logWarn(input.logger, "Failed while streaming Slack agent message.", {
      channelId: input.channel,
      error,
      threadTs: input.threadTs,
    });
    if (stream === undefined) {
      throw error;
    }
    if (streamedText.length > 0) {
      try {
        await stream.append({
          markdown_text: `\n\n${runnerUserFacingErrorMessage(error, input.translator)}`,
        });
        await stream.stop();
      } catch (stopError) {
        logWarn(input.logger, "Failed to stop Slack agent live stream after an error.", {
          channelId: input.channel,
          error: stopError,
          threadTs: input.threadTs,
        });
      }
      return { type: "posted-error" };
    }
    try {
      await stream?.stop();
    } catch (stopError) {
      logWarn(input.logger, "Failed to stop empty Slack agent live stream after an error.", {
        channelId: input.channel,
        error: stopError,
        threadTs: input.threadTs,
      });
    }
    throw error;
  }
}

async function appendStreamingResultHandoff(input: {
  channel: string;
  client: SlackAgentClient;
  ensureStream(): SlackAgentMessageStream;
  result: AgentRunnerResult;
  streamedText: string;
  threadTs: string;
}): Promise<void> {
  const media = readGeneratedMedia(input.result.structuredResult);
  if (media?.dataBase64 !== undefined) {
    await input.client.filesUploadV2({
      channel_id: input.channel,
      file: Buffer.from(media.dataBase64, "base64"),
      filename: mediaFilename(media),
      initial_comment: input.streamedText.trim().length === 0 ? input.result.message : "",
      thread_ts: input.threadTs,
    });
    return;
  }
  const suffix = media?.uri ?? media?.operationName;
  if (suffix !== undefined) {
    await input.ensureStream().append({ markdown_text: `\n${suffix}` });
  }
}

function createSlackClientStreamStarter(input: {
  channelId: string;
  client: SlackAgentClient;
  teamId: string;
  threadTs: string;
  userId: string;
}): () => SlackAgentMessageStream | undefined {
  return () =>
    input.client.chatStream?.({
      buffer_size: SLACK_AGENT_STREAM_BUFFER_SIZE,
      channel: input.channelId,
      recipient_team_id: input.teamId,
      recipient_user_id: input.userId,
      thread_ts: input.threadTs,
    });
}

async function postStreamingAgentMessage(input: {
  channel: string;
  logger: unknown;
  sayStream: SayStreamFn;
  text: string;
  threadTs: string;
}): Promise<boolean> {
  if (input.text.length === 0) {
    return false;
  }
  try {
    const stream = input.sayStream({ buffer_size: SLACK_AGENT_STREAM_BUFFER_SIZE });
    await stream.append({ markdown_text: input.text });
    await stream.stop();
    logInfo(input.logger, "Delivered agent message to Slack with sayStream.", {
      channelId: input.channel,
      delivery: "stream",
      threadTs: input.threadTs,
    });
    return true;
  } catch (error) {
    logWarn(input.logger, "Failed to deliver Slack agent message with sayStream.", {
      channelId: input.channel,
      error,
      threadTs: input.threadTs,
    });
    return false;
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
    toolResultNames: [...new Set(input.result.toolResults.map((tool) => tool.toolName))],
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

function readSlackApiErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const data = error.data;
  if (isRecord(data) && typeof data.error === "string") {
    return data.error;
  }
  return typeof error.code === "string" ? error.code : undefined;
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
  teamId?: string,
): Promise<{ isWorkspaceAdmin: boolean; translator: Translator }> {
  const info = client.users?.info;
  if (info === undefined || userId === undefined) {
    return { isWorkspaceAdmin: false, translator };
  }
  try {
    const response = await info({
      ...(teamId === undefined ? {} : { team_id: teamId }),
      user: userId,
    } as never);
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

function shouldRetryJobFailure(
  error: unknown,
  context: SlackAgentJobRetryContext | undefined,
): boolean {
  if (context === undefined) {
    return false;
  }
  if (isNonRetryableProviderFailure(error)) {
    return false;
  }
  return context.attemptsMade + 1 < context.attempts;
}

function isNonRetryableProviderFailure(error: unknown): boolean {
  return errorContainsField(error, "code", "context_length_exceeded");
}

function errorContainsField(error: unknown, field: string, expected: string): boolean {
  const visited = new Set<unknown>();
  const stack = [error];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!isRecord(current) || visited.has(current)) {
      continue;
    }
    visited.add(current);
    if (current[field] === expected) {
      return true;
    }
    for (const linkedField of ["cause", "error"]) {
      const linkedValue = current[linkedField];
      if (typeof linkedValue === "object" && linkedValue !== null) {
        stack.push(linkedValue);
      }
    }
    for (const value of Object.values(current)) {
      if (typeof value === "object" && value !== null) {
        stack.push(value);
      }
    }
  }
  return false;
}

function readGeneratedMedia(value: JsonValue | undefined): GeneratedSlackMedia | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const media = value.media;
  if (!isRecord(media)) {
    return undefined;
  }
  if (media.kind !== "audio" && media.kind !== "image" && media.kind !== "video") {
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
  kind: "audio" | "image" | "video";
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
  if (media.mimeType === "audio/wav" || media.mimeType === "audio/x-wav") {
    return "wav";
  }
  if (media.mimeType === "audio/mpeg" || media.mimeType === "audio/mp3") {
    return "mp3";
  }
  if (media.kind === "audio") {
    return "mp3";
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

function readActionSelectedOptionValue(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.actions)) {
    return undefined;
  }
  const [action] = body.actions;
  const option = isRecord(action) ? action.selected_option : undefined;
  return isRecord(option) && typeof option.value === "string" ? option.value : undefined;
}

function readModalPrivateMetadata(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.view)) {
    return undefined;
  }
  return readString(body.view, "private_metadata");
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

function readSelectedConversationValues(
  view: unknown,
  blockId: string,
  actionId: string,
): string[] {
  const element = readModalElement(view, blockId, actionId);
  const conversations =
    isRecord(element) && Array.isArray(element.selected_conversations)
      ? element.selected_conversations
      : [];
  return conversations.filter(
    (conversation): conversation is string =>
      typeof conversation === "string" && conversation.length > 0,
  );
}

function readSelectedConversationValue(
  view: unknown,
  blockId: string,
  actionId: string,
): string | undefined {
  const element = readModalElement(view, blockId, actionId);
  return isRecord(element) && typeof element.selected_conversation === "string"
    ? element.selected_conversation
    : undefined;
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

function slackThreadRouteChannelId(
  thread: JsonObject | undefined,
  fallbackChannelId: string,
): string {
  return stringField(thread, "assistant_thread_context_channel_id") ?? fallbackChannelId;
}

function slackThreadViewerContextChannelIds(
  thread: JsonObject | undefined,
  fallbackChannelId: string,
  teamId: string,
): string[] {
  const contextTeamId = stringField(thread, "assistant_thread_context_team_id");
  const contextChannelId =
    contextTeamId === teamId
      ? stringField(thread, "assistant_thread_context_channel_id")
      : undefined;
  return [
    ...new Set(
      [contextChannelId, fallbackChannelId].filter(
        (channelId): channelId is string => channelId !== undefined,
      ),
    ),
  ];
}

async function resolveSlackAgentRoute(
  repository: SlackAgentRoutingRepository | undefined,
  input: {
    channelId: string;
    teamId: string;
    threadChannelId?: string;
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

function slackWebApiErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  if (error.code === ErrorCode.PlatformError && isRecord(error.data)) {
    const code = error.data.error;
    return typeof code === "string" && code.length > 0 ? code : undefined;
  }
  if (error.code === ErrorCode.RateLimitedError) {
    return "rate_limited";
  }
  return undefined;
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
