import type { ToolSet } from "ai";

import type { AppSettings } from "../config.js";
import type {
  ConversationHistory,
  ConversationMessage,
  JsonValue,
  UserMessagePart,
} from "../domain/messageHistory.js";
import { createAiSdkAdapters } from "../providers/aiSdkAdapter.js";
import type {
  LlmRequest,
  LlmResponseFormat,
  LlmResult,
  ModelInfo,
} from "../providers/contracts.js";
import type { ProviderCredentialResolver } from "../providers/credentials.js";
import { createNativeProviderAdapters } from "../providers/nativeProviderAdapters.js";
import { ProviderRouter } from "../providers/providerRouter.js";
import { normalizeReasoningEffort } from "../providers/reasoningOptions.js";
import type { WorkspaceFeatureSettingsRepository } from "../repositories/workspaceFeatureSettings.js";
import {
  createMediaGenerationAgentTools,
  defaultImageGenerationFallbackModelIds,
} from "./mediaGeneration/tools.js";
import {
  type AgentRouterDecision,
  type SlackAgentInvocation,
  agentTextResultSchema,
  agentRouterDecisionSchema,
  slackAgentInvocationSchema,
} from "./schemas.js";
import {
  createSalesforcePdfAgentTools,
  type SalesforcePdfToolOptions,
} from "./salesforcePdf/index.js";
import { createSpeechGenerationAgentTools } from "./speechGeneration/index.js";
import { createSlackMcpToolSet, type SlackMcpTokenResolver } from "./slackMcp/index.js";
import { createSoracomAgentTools } from "./soracom/index.js";
import { AgentToolRegistry, type AgentToolResult } from "./toolContracts.js";

export type AgentRunnerResult = {
  decision: AgentRouterDecision;
  message: string;
  model?: AgentRunnerModelTrace;
  raw?: unknown;
  structuredResult?: JsonValue;
  toolResults: AgentToolResult[];
};

export type AgentRunnerStructuredResult = {
  model?: AgentRunnerModelTrace;
  raw?: unknown;
  structuredOutput: JsonValue;
};

export type AgentRunnerModelTrace = {
  id: string;
  provider?: ModelInfo["provider"];
};

export class AgentRunnerExecutionError extends Error {
  constructor(
    readonly model: AgentRunnerModelTrace | undefined,
    cause: unknown,
  ) {
    super(`TypeScript AgentRunner failed: ${errorMessage(cause)}`, { cause });
    this.name = "AgentRunnerExecutionError";
  }
}

export type AgentRunnerOptions = {
  credentialResolver?: ProviderCredentialResolver;
  aiSdkToolSetPreparationTimeoutMs?: number;
  defaultModelId: string;
  featureSettingsRepository?: WorkspaceFeatureSettingsRepository;
  imageGenerationModelId?: string;
  logger?: unknown;
  maxToolRounds?: number;
  providerRouter: Pick<ProviderRouter, "generate" | "registry">;
  systemPrompt?: string;
  textToSpeechModelId?: string;
  aiSdkToolSetFactory?: (
    invocation: SlackAgentInvocation,
    model: ModelInfo,
  ) =>
    | AgentRunnerAiSdkToolSetHandle
    | readonly AgentRunnerAiSdkToolSetHandle[]
    | undefined
    | Promise<AgentRunnerAiSdkToolSetHandle | readonly AgentRunnerAiSdkToolSetHandle[] | undefined>;
  toolRegistry?: AgentToolRegistry;
  toolRegistryFactory?: (
    invocation: SlackAgentInvocation,
    model: ModelInfo,
  ) => AgentToolRegistry | undefined;
};

export type AgentRunnerAiSdkToolSetHandle = {
  close(): Promise<void>;
  tools: ToolSet;
};

const DEFAULT_SYSTEM_PROMPT =
  "You are the general Agents party assistant. Reply directly and concisely for Slack. Use available tools when they are helpful, and ask for missing details before taking ambiguous actions.";
const DEFAULT_MAX_TOOL_ROUNDS = 3;
const DEFAULT_AI_SDK_TOOLSET_PREPARATION_TIMEOUT_MS = 3000;

export class AgentRunner {
  constructor(private readonly options: AgentRunnerOptions) {}

  async run(invocationInput: unknown): Promise<AgentRunnerResult> {
    const invocation = slackAgentInvocationSchema.parse(invocationInput);
    const decision = selectAgentAction();
    const { model, result, toolResults } = await this.runAgent(invocation);

    try {
      return normalizeRunnerResult(decision, model, result, toolResults);
    } catch (error) {
      throw new AgentRunnerExecutionError(modelTrace(model), error);
    }
  }

  async runStructured(
    invocationInput: unknown,
    responseFormat: Extract<LlmResponseFormat, { type: "json" }>,
  ): Promise<AgentRunnerStructuredResult> {
    const invocation = slackAgentInvocationSchema.parse(invocationInput);
    const model = this.resolveModel(invocation.modelId);
    try {
      const result = await this.options.providerRouter.generate({
        context: {
          workspaceId: invocation.teamId,
        },
        history: buildAgentHistory({
          invocation,
          toolResults: [],
        }),
        metadata: {
          slack_channel_id: invocation.channelId,
          slack_team_id: invocation.teamId,
          slack_user_id: invocation.userId,
        },
        model,
        reasoningEffort: normalizeReasoningEffort(invocation.reasoningEffort),
        responseFormat,
        system: this.systemPrompt(),
      });
      if (result.structuredOutput === undefined) {
        throw new Error("Provider returned no structured output.");
      }
      return {
        model: modelTrace(model),
        raw: result.raw,
        structuredOutput: result.structuredOutput,
      };
    } catch (error) {
      throw new AgentRunnerExecutionError(modelTrace(model), error);
    }
  }

  private async runAgent(
    invocation: SlackAgentInvocation,
  ): Promise<{ model: ModelInfo; result: LlmResult; toolResults: AgentToolResult[] }> {
    const model = this.resolveModel(invocation.modelId);
    const aiSdkToolSetHandles = await this.resolveAiSdkToolSetHandles(invocation, model);
    const aiSdkTools = mergeAiSdkToolSets(aiSdkToolSetHandles.map((handle) => handle.tools));
    const toolRegistry =
      this.options.toolRegistryFactory?.(invocation, model) ?? this.options.toolRegistry;
    const toolResults: AgentToolResult[] = [];
    try {
      let history = buildAgentHistory({
        invocation,
        toolResults,
      });
      const requestBase: Omit<LlmRequest, "history"> = {
        context: {
          workspaceId: invocation.teamId,
        },
        metadata: {
          slack_channel_id: invocation.channelId,
          slack_team_id: invocation.teamId,
          slack_user_id: invocation.userId,
        },
        model,
        aiSdkTools,
        reasoningEffort: normalizeReasoningEffort(invocation.reasoningEffort),
        system: this.systemPrompt(),
        tools: toolRegistry?.definitions(),
      };
      const maxToolRounds = this.options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
      for (let round = 0; round <= maxToolRounds; round += 1) {
        const result = await this.options.providerRouter.generate({ ...requestBase, history });
        if ((result.toolCalls?.length ?? 0) === 0) {
          return { model, result, toolResults };
        }
        if (toolRegistry === undefined) {
          throw new Error("Agent returned tool calls, but no tool registry is configured.");
        }
        if (round === maxToolRounds) {
          throw new Error("Agent exceeded the configured tool-call round limit.");
        }
        const roundToolResults = await toolRegistry.executeAll(result.toolCalls ?? []);
        toolResults.push(...roundToolResults);
        history = buildAgentHistory({
          invocation,
          toolResults,
        });
      }
      throw new Error("Agent tool-call loop ended unexpectedly.");
    } catch (error) {
      if (error instanceof AgentRunnerExecutionError) {
        throw error;
      }
      throw new AgentRunnerExecutionError(modelTrace(model), error);
    } finally {
      await closeAiSdkToolSetHandles(aiSdkToolSetHandles);
    }
  }

  private systemPrompt(): string {
    return this.options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  private async resolveAiSdkToolSetHandles(
    invocation: SlackAgentInvocation,
    model: ModelInfo,
  ): Promise<readonly AgentRunnerAiSdkToolSetHandle[]> {
    const factory = this.options.aiSdkToolSetFactory;
    if (factory === undefined) {
      return [];
    }
    const timeoutMs = Math.max(
      1,
      this.options.aiSdkToolSetPreparationTimeoutMs ??
        DEFAULT_AI_SDK_TOOLSET_PREPARATION_TIMEOUT_MS,
    );
    let timedOut = false;
    const handlesPromise = Promise.resolve()
      .then(() => factory(invocation, model))
      .then(normalizeAiSdkToolSetHandles);
    void handlesPromise.then(
      async (handles) => {
        if (timedOut) {
          await closeAiSdkToolSetHandles(handles);
        }
      },
      (error) => {
        if (timedOut) {
          logWarn(
            this.options.logger,
            "AI SDK toolset preparation failed after the agent invocation continued.",
            {
              channelId: invocation.channelId,
              error,
              modelId: model.id,
              provider: model.provider,
              teamId: invocation.teamId,
              timeoutMs,
            },
          );
        }
      },
    );
    try {
      return await withTimeout(handlesPromise, timeoutMs, () => {
        timedOut = true;
      });
    } catch (error) {
      logWarn(this.options.logger, "Failed to prepare AI SDK toolsets for agent invocation.", {
        channelId: invocation.channelId,
        error,
        modelId: model.id,
        provider: model.provider,
        teamId: invocation.teamId,
        timeoutMs,
      });
      return [];
    }
  }

  private resolveModel(modelId?: string): ModelInfo {
    const resolvedModelId = modelId ?? this.options.defaultModelId;
    try {
      return this.options.providerRouter.registry.get(resolvedModelId);
    } catch (error) {
      throw new AgentRunnerExecutionError({ id: resolvedModelId }, error);
    }
  }
}

export function createDefaultAgentRunner(
  settings: AppSettings,
  options: {
    credentialResolver?: ProviderCredentialResolver;
    featureSettingsRepository?: WorkspaceFeatureSettingsRepository;
    logger?: unknown;
    salesforcePdfTools?: Omit<SalesforcePdfToolOptions, "context">;
    slackMcpTokenResolver?: SlackMcpTokenResolver;
  } = {},
): AgentRunner {
  const salesforcePdfTools = options.salesforcePdfTools;
  const providerRouter = new ProviderRouter([
    ...createNativeProviderAdapters({ credentialResolver: options.credentialResolver }),
    ...createAiSdkAdapters({}, { credentialResolver: options.credentialResolver }),
  ]);
  return new AgentRunner({
    credentialResolver: options.credentialResolver,
    defaultModelId: settings.agentModelId,
    featureSettingsRepository: options.featureSettingsRepository,
    imageGenerationModelId: settings.imageGenerationModelId,
    logger: options.logger,
    providerRouter,
    textToSpeechModelId: settings.textToSpeechModelId,
    aiSdkToolSetFactory: async (invocation, model) => {
      if (
        !model.capabilities.includes("tool_calling") ||
        options.slackMcpTokenResolver === undefined
      ) {
        return [];
      }
      const slackMcpToolSet = await createSlackMcpToolSet({
        context: {
          enterpriseId: invocation.enterpriseId,
          isEnterpriseInstall: invocation.isEnterpriseInstall,
          teamId: invocation.teamId,
          userId: invocation.userId,
          viewerContextChannelIds: invocation.viewerContextChannelIds,
        },
        tokenResolver: options.slackMcpTokenResolver,
      });
      return slackMcpToolSet === undefined ? [] : [slackMcpToolSet];
    },
    toolRegistryFactory: (invocation, model) => {
      if (!model.capabilities.includes("tool_calling")) {
        return new AgentToolRegistry();
      }
      const tools = [
        ...createMediaGenerationAgentTools({
          context: {
            channelId: invocation.channelId,
            teamId: invocation.teamId,
          },
          credentialResolver: options.credentialResolver,
          featureSettingsRepository: options.featureSettingsRepository,
          imageGenerationFallbackModelIds: defaultImageGenerationFallbackModelIds,
          imageGenerationModelId: settings.imageGenerationModelId,
          modelRegistry: providerRouter.registry,
        }),
        ...createSpeechGenerationAgentTools({
          context: {
            channelId: invocation.channelId,
            teamId: invocation.teamId,
          },
          credentialResolver: options.credentialResolver,
          featureSettingsRepository: options.featureSettingsRepository,
          modelRegistry: providerRouter.registry,
          textToSpeechModelId: settings.textToSpeechModelId,
        }),
        ...(salesforcePdfTools === undefined
          ? []
          : createSalesforcePdfAgentTools({
              ...salesforcePdfTools,
              context: {
                slackUserId: invocation.userId,
                teamId: invocation.teamId,
              },
            })),
        ...(options.credentialResolver === undefined
          ? []
          : createSoracomAgentTools({
              context: {
                teamId: invocation.teamId,
              },
              credentialResolver: options.credentialResolver,
            })),
      ];
      return new AgentToolRegistry(tools);
    },
  });
}

function normalizeAiSdkToolSetHandles(
  handles: AgentRunnerAiSdkToolSetHandle | readonly AgentRunnerAiSdkToolSetHandle[] | undefined,
): readonly AgentRunnerAiSdkToolSetHandle[] {
  if (handles === undefined) {
    return [];
  }
  return Array.isArray(handles) ? [...handles] : [handles as AgentRunnerAiSdkToolSetHandle];
}

function mergeAiSdkToolSets(toolSets: readonly ToolSet[]): ToolSet | undefined {
  if (toolSets.length === 0) {
    return undefined;
  }
  return Object.assign({}, ...toolSets) as ToolSet;
}

async function closeAiSdkToolSetHandles(
  handles: readonly AgentRunnerAiSdkToolSetHandle[],
): Promise<void> {
  await Promise.all(handles.map((handle) => handle.close().catch(() => {})));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout();
      reject(new Error(`AI SDK toolset preparation timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function logWarn(logger: unknown, message: string, metadata: Record<string, unknown>): void {
  if (isRecord(logger) && typeof logger.warn === "function") {
    logger.warn(message, metadata);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function selectAgentAction(): AgentRouterDecision {
  return agentRouterDecisionSchema.parse({
    action: "respond",
    reason: "agent_invocation",
  });
}

function buildAgentHistory(input: {
  invocation: SlackAgentInvocation;
  toolResults: AgentToolResult[];
}): ConversationHistory {
  const threadHistoryMessages =
    input.invocation.threadHistory.length > 0
      ? input.invocation.threadHistory.map(
          (message, index): ConversationMessage =>
            message.role === "assistant"
              ? {
                  content: [{ text: message.text, type: "text" }],
                  id: message.messageTs ?? `thread-${index}`,
                  provenance: {
                    externalMessageId: message.messageTs,
                    source: "slack",
                    threadId: input.invocation.threadTs,
                  },
                  role: "assistant",
                }
              : {
                  author: { id: slackScopedId(message.teamId, message.userId), kind: "user" },
                  content: [{ text: message.text, type: "text" }],
                  id: message.messageTs ?? `thread-${index}`,
                  provenance: {
                    externalMessageId: message.messageTs,
                    source: "slack",
                    threadId: input.invocation.threadTs,
                  },
                  role: "user",
                },
        )
      : input.invocation.threadMessages.map(
          (message, index): ConversationMessage => ({
            author: { id: slackScopedId(input.invocation.teamId, "thread"), kind: "user" },
            content: [{ text: message, type: "text" }],
            id: `thread-${index}`,
            role: "user",
          }),
        );
  return {
    messages: [
      ...threadHistoryMessages,
      {
        author: {
          id: slackScopedId(input.invocation.teamId, input.invocation.userId),
          kind: "user",
        },
        content: [
          { text: input.invocation.text, type: "text" },
          ...input.invocation.transientAttachments.flatMap((attachment): UserMessagePart[] =>
            attachment.kind === "audio" && attachment.transcript !== undefined
              ? [
                  {
                    text: renderTransientAudioTranscript(attachment),
                    type: "text",
                  },
                ]
              : [],
          ),
          ...input.invocation.referenceImages.map(
            (image): UserMessagePart => ({
              filename: image.identifier,
              id: image.identifier,
              mediaType: image.mediaType,
              source:
                image.data !== undefined
                  ? { data: image.data, type: "bytes" }
                  : image.url === undefined
                    ? { reason: "not_downloaded", type: "unavailable" }
                    : { type: "url", url: image.url },
              type: "image",
            }),
          ),
        ] satisfies UserMessagePart[],
        id: input.invocation.messageTs,
        provenance: {
          externalMessageId: input.invocation.messageTs,
          source: "slack",
          threadId: input.invocation.threadTs,
        },
        role: "user",
      },
      ...input.toolResults.flatMap((result, index) => [
        {
          content: [
            {
              input: result.input,
              toolCallId: result.toolCallId,
              toolName: result.toolName,
              type: "tool-call" as const,
            },
          ],
          id: `assistant-tool-call-${index}`,
          role: "assistant" as const,
        },
        {
          content: [
            {
              output: { type: "json" as const, value: redactToolOutput(result.output) },
              toolCallId: result.toolCallId,
              toolName: result.toolName,
              type: "tool-result" as const,
            },
          ],
          id: `tool-result-${index}`,
          role: "tool" as const,
        },
      ]),
    ],
  };
}

function slackScopedId(teamId: string, id: string): string {
  return `slack:${teamId}:${id}`;
}

function renderTransientAudioTranscript(attachment: {
  filename?: string;
  id: string;
  transcript?: string;
}): string {
  const label = attachment.filename ?? attachment.id;
  return `[audio: ${label}]\n${attachment.transcript ?? ""}`;
}

function normalizeRunnerResult(
  decision: AgentRouterDecision,
  model: ModelInfo,
  result: LlmResult,
  toolResults: AgentToolResult[],
): AgentRunnerResult {
  const modelSummary = modelTrace(model);
  const structuredResult = generatedMediaToolOutput(toolResults);
  return {
    decision,
    message: agentTextResultSchema.parse({
      message: nonEmptyAgentMessage(result, structuredResult),
    }).message,
    model: modelSummary,
    raw: result.raw,
    structuredResult,
    toolResults,
  };
}

function redactToolOutput(output: JsonValue | undefined): JsonValue {
  if (!isJsonObject(output)) {
    return output ?? null;
  }
  return redactGeneratedMedia(output);
}

function redactGeneratedMedia(value: Record<string, JsonValue>): JsonValue {
  const media = value.media;
  if (!isJsonObject(media) || typeof media.dataBase64 !== "string") {
    return value;
  }
  return {
    ...value,
    media: {
      ...media,
      dataBase64: "[redacted]",
    },
  };
}

function generatedMediaToolOutput(toolResults: AgentToolResult[]): JsonValue | undefined {
  for (const result of [...toolResults].reverse()) {
    if (!isJsonObject(result.output) || result.output.ok !== true) {
      continue;
    }
    const media = result.output.media;
    if (
      isJsonObject(media) &&
      (media.kind === "audio" || media.kind === "image" || media.kind === "video")
    ) {
      return result.output;
    }
  }
  return undefined;
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyAgentMessage(result: LlmResult, structuredResult?: JsonValue): string {
  if (result.content.trim().length > 0) {
    return result.content;
  }
  if (isJsonObject(structuredResult) && typeof structuredResult.message === "string") {
    return structuredResult.message;
  }
  if ((result.sources?.length ?? 0) > 0) {
    return "検索は実行されましたが、回答本文が返されませんでした。もう一度お試しください。";
  }
  return "回答本文を生成できませんでした。もう一度お試しください。";
}

function modelTrace(model: ModelInfo): AgentRunnerModelTrace {
  return {
    id: model.id,
    provider: model.provider,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
