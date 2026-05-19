import type { AppSettings } from "../config.js";
import type {
  ConversationHistory,
  ConversationMessage,
  JsonValue,
  UserMessagePart,
} from "../domain/messageHistory.js";
import { createAiSdkAdapters } from "../providers/aiSdkAdapter.js";
import type { LlmRequest, LlmResult, ModelInfo } from "../providers/contracts.js";
import type { ProviderCredentialResolver } from "../providers/credentials.js";
import { createNativeProviderAdapters } from "../providers/nativeProviderAdapters.js";
import { ProviderRouter } from "../providers/providerRouter.js";
import { normalizeReasoningEffort } from "../providers/reasoningOptions.js";
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
  defaultModelId: string;
  maxToolRounds?: number;
  providerRouter: Pick<ProviderRouter, "generate" | "registry">;
  systemPrompt?: string;
  toolRegistry?: AgentToolRegistry;
  toolRegistryFactory?: (
    invocation: SlackAgentInvocation,
    model: ModelInfo,
  ) => AgentToolRegistry | undefined;
};

const DEFAULT_SYSTEM_PROMPT =
  "You are the general Agents party assistant. Reply directly and concisely for Slack. Use available tools when they are helpful, and ask for missing details before taking ambiguous actions.";

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

  private async runAgent(
    invocation: SlackAgentInvocation,
  ): Promise<{ model: ModelInfo; result: LlmResult; toolResults: AgentToolResult[] }> {
    const model = this.resolveModel(invocation.modelId);
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
        reasoningEffort: normalizeReasoningEffort(invocation.reasoningEffort),
        system: this.systemPrompt(),
        tools: toolRegistry?.definitions(),
      };
      const maxToolRounds = this.options.maxToolRounds ?? 1;
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
    }
  }

  private systemPrompt(): string {
    return this.options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
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
    salesforcePdfTools?: Omit<SalesforcePdfToolOptions, "context">;
  } = {},
): AgentRunner {
  const salesforcePdfTools = options.salesforcePdfTools;
  return new AgentRunner({
    credentialResolver: options.credentialResolver,
    defaultModelId: settings.agentModelId,
    providerRouter: new ProviderRouter([
      ...createNativeProviderAdapters({ credentialResolver: options.credentialResolver }),
      ...createAiSdkAdapters({}, { credentialResolver: options.credentialResolver }),
    ]),
    toolRegistryFactory: (invocation, model) => {
      if (!model.capabilities.includes("tool_calling")) {
        return new AgentToolRegistry();
      }
      const tools = [
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
                image.url === undefined
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
              output: { type: "json" as const, value: result.output ?? null },
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
  return {
    decision,
    message: agentTextResultSchema.parse({ message: nonEmptyAgentMessage(result) }).message,
    model: modelSummary,
    raw: result.raw,
    toolResults,
  };
}

function nonEmptyAgentMessage(result: LlmResult): string {
  if (result.content.trim().length > 0) {
    return result.content;
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
