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
  LlmToolCall,
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
import { createSlackRealTimeSearchAgentTools } from "./slackSearch/index.js";
import { createSoracomAgentTools } from "./soracom/index.js";
import {
  AgentToolRegistry,
  createAiSdkToolSetFromAgentTools,
  type AgentToolDefinition,
  type AgentToolResult,
} from "./toolContracts.js";

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

export type AgentRunnerStreamEvent =
  | {
      text: string;
      type: "text-delta";
    }
  | {
      toolName: string;
      type: "tool-call";
    }
  | {
      result: AgentRunnerResult;
      type: "result";
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
  directInvocationHandler?: (
    invocation: SlackAgentInvocation,
    runtimeOptions: AgentRunnerRuntimeOptions,
  ) => Promise<AgentRunnerDirectInvocationResult | undefined>;
  featureSettingsRepository?: WorkspaceFeatureSettingsRepository;
  imageGenerationModelId?: string;
  logger?: unknown;
  maxToolRounds?: number;
  providerRouter: Pick<ProviderRouter, "generate" | "registry"> &
    Partial<Pick<ProviderRouter, "stream">>;
  systemPrompt?: string;
  textToSpeechModelId?: string;
  aiSdkToolSetFactory?: (
    invocation: SlackAgentInvocation,
    model: ModelInfo,
    runtimeOptions: AgentRunnerRuntimeOptions,
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

export type AgentRunnerRuntimeOptions = {
  onImageGenerationStart?: (input: {
    channelId: string;
    modelId: string;
    prompt: string;
    provider: string;
    teamId: string;
  }) => Promise<void> | void;
};

type AgentRunnerDirectInvocationResult = {
  model: ModelInfo;
  result: LlmResult;
  toolResults: AgentToolResult[];
};

const DEFAULT_SYSTEM_PROMPT = [
  "You are the general Agents Party assistant running inside Slack.",
  "Reply in the user's language. Be direct, concise, and useful for a Slack thread.",
  "Use short bullets when structure helps. Avoid unnecessary preambles.",
  "Use only the tools that are available in the current request. Do not claim that you used a tool that was not available.",
  "Use tools when they can materially improve accuracy, retrieve relevant workspace context, or complete the requested action.",
  "If a useful tool is unavailable, answer from the provided context when possible, or ask for the missing details.",
  "If a request is ambiguous but low risk, make a reasonable assumption and state it briefly. Ask a clarifying question before irreversible, privileged, or high-impact actions.",
  "When Slack workspace search is needed and slack_real_time_search is available, prefer it. If it is unavailable and slack_search_public is available, use slack_search_public as a fallback.",
  "Use slack_read_channel or slack_read_thread when those tools are available and you only need context from the current channel or thread.",
  "When the user asks to create, generate, read, or summarize content into a Slack Canvas, use the Slack MCP canvas tools when they are available. Use slack_update_canvas only when the user explicitly names the target Canvas id or Slack Canvas URL in the request.",
  "Summarize tool results instead of dumping raw data or internal identifiers.",
  "Do not expose credentials, tokens, or sensitive identifiers in Slack replies.",
  "When SORACOM tools are available and the user asks for SORACOM SIM, SoraCam, or device information, use the relevant SORACOM discovery or status tools before asking for details.",
  'For a generic SORACOM SIM information request without an ID, if soracom_find_resources is available, call it with query "sim" and resourceTypes ["sim"], then summarize candidates or ask which candidate to inspect.',
  "Do not reveal full SORACOM SIM IDs, IMSIs, or ICCIDs in Slack replies; use the masked identifiers returned by tools.",
].join(" ");
const DEFAULT_MAX_TOOL_ROUNDS = 3;
const DEFAULT_AI_SDK_TOOLSET_PREPARATION_TIMEOUT_MS = 3000;

export class AgentRunner {
  constructor(private readonly options: AgentRunnerOptions) {}

  async run(
    invocationInput: unknown,
    runtimeOptions: AgentRunnerRuntimeOptions = {},
  ): Promise<AgentRunnerResult> {
    const invocation = slackAgentInvocationSchema.parse(invocationInput);
    const decision = selectAgentAction();
    const directResult = await this.options.directInvocationHandler?.(invocation, runtimeOptions);
    if (directResult !== undefined) {
      return normalizeRunnerResult(
        decision,
        directResult.model,
        directResult.result,
        directResult.toolResults,
      );
    }
    const { model, result, toolResults } = await this.runAgent(invocation, runtimeOptions);

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

  async *runStream(
    invocationInput: unknown,
    runtimeOptions: AgentRunnerRuntimeOptions = {},
  ): AsyncIterable<AgentRunnerStreamEvent> {
    const invocation = slackAgentInvocationSchema.parse(invocationInput);
    const decision = selectAgentAction();
    const model = this.resolveModel(invocation.modelId);
    try {
      const directResult = await this.options.directInvocationHandler?.(invocation, runtimeOptions);
      if (directResult !== undefined) {
        yield {
          result: normalizeRunnerResult(
            decision,
            directResult.model,
            directResult.result,
            directResult.toolResults,
          ),
          type: "result",
        };
        return;
      }
      const agentStream = this.runAgentStream(invocation, model, runtimeOptions);
      let next = await agentStream.next();
      while (!next.done) {
        yield next.value;
        next = await agentStream.next();
      }
      const { result, toolResults } = next.value;
      yield {
        result: normalizeRunnerResult(decision, model, result, toolResults),
        type: "result",
      };
    } catch (error) {
      if (error instanceof AgentRunnerExecutionError) {
        throw error;
      }
      throw new AgentRunnerExecutionError(modelTrace(model), error);
    }
  }

  private async runAgent(
    invocation: SlackAgentInvocation,
    runtimeOptions: AgentRunnerRuntimeOptions,
  ): Promise<{ model: ModelInfo; result: LlmResult; toolResults: AgentToolResult[] }> {
    const model = this.resolveModel(invocation.modelId);
    const aiSdkToolSetHandles = await this.resolveAiSdkToolSetHandles(
      invocation,
      model,
      runtimeOptions,
    );
    const aiSdkTools = mergeAiSdkToolSets(aiSdkToolSetHandles.map((handle) => handle.tools));
    const toolRegistry =
      this.options.toolRegistryFactory?.(invocation, model) ?? this.options.toolRegistry;
    const toolResults: AgentToolResult[] = [];
    try {
      const unavailableCanvasMessage = slackCanvasUnavailableMessage(invocation, aiSdkTools);
      if (unavailableCanvasMessage !== undefined) {
        return {
          model,
          result: {
            content: unavailableCanvasMessage,
          },
          toolResults,
        };
      }
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
        toolResults.push(...(result.toolResults ?? []));
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

  private async *runAgentStream(
    invocation: SlackAgentInvocation,
    model: ModelInfo,
    runtimeOptions: AgentRunnerRuntimeOptions,
  ): AsyncGenerator<
    Exclude<AgentRunnerStreamEvent, { type: "result" }>,
    { result: LlmResult; toolResults: AgentToolResult[] },
    void
  > {
    if (this.options.providerRouter.stream === undefined) {
      throw new Error("The configured provider router does not support streaming.");
    }

    const aiSdkToolSetHandles = await this.resolveAiSdkToolSetHandles(
      invocation,
      model,
      runtimeOptions,
    );
    const aiSdkTools = mergeAiSdkToolSets(aiSdkToolSetHandles.map((handle) => handle.tools));
    const toolRegistry =
      this.options.toolRegistryFactory?.(invocation, model) ?? this.options.toolRegistry;
    const toolResults: AgentToolResult[] = [];
    try {
      const unavailableCanvasMessage = slackCanvasUnavailableMessage(invocation, aiSdkTools);
      if (unavailableCanvasMessage !== undefined) {
        return {
          result: {
            content: unavailableCanvasMessage,
          },
          toolResults,
        };
      }
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
        const roundToolCalls: LlmToolCall[] = [];
        let result: LlmResult | undefined;
        for await (const event of this.options.providerRouter.stream({
          ...requestBase,
          history,
        })) {
          switch (event.type) {
            case "text-delta":
              yield event;
              break;
            case "tool-call":
              roundToolCalls.push(event.toolCall);
              yield {
                toolName: event.toolCall.toolName,
                type: "tool-call",
              };
              break;
            case "done":
              result = event.result;
              break;
            case "error":
              throw event.error;
            case "usage":
              break;
          }
        }
        if (result === undefined) {
          throw new Error("Provider stream ended without a final result.");
        }
        toolResults.push(...(result.toolResults ?? []));
        const toolCalls = mergeStreamToolCalls(roundToolCalls, result.toolCalls);
        const roundResult = { ...result, toolCalls };
        if (toolCalls.length === 0) {
          return { result: roundResult, toolResults };
        }
        if (toolRegistry === undefined) {
          throw new Error("Agent returned tool calls, but no tool registry is configured.");
        }
        if (round === maxToolRounds) {
          throw new Error("Agent exceeded the configured tool-call round limit.");
        }
        const roundToolResults = await toolRegistry.executeAll(toolCalls);
        toolResults.push(...roundToolResults);
        history = buildAgentHistory({
          invocation,
          toolResults,
        });
      }
      throw new Error("Agent tool-call loop ended unexpectedly.");
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
    runtimeOptions: AgentRunnerRuntimeOptions,
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
      .then(() => factory(invocation, model, runtimeOptions))
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
    directInvocationHandler: async (invocation, runtimeOptions) =>
      runFocusedImageGenerationInvocation({
        invocation,
        modelRegistry: providerRouter.registry,
        options,
        runtimeOptions,
        settings,
      }),
    featureSettingsRepository: options.featureSettingsRepository,
    imageGenerationModelId: settings.imageGenerationModelId,
    logger: options.logger,
    providerRouter,
    textToSpeechModelId: settings.textToSpeechModelId,
    aiSdkToolSetFactory: async (invocation, model, runtimeOptions) => {
      if (!model.capabilities.includes("tool_calling")) {
        return [];
      }
      const toolSelection = selectDefaultAgentToolSelection(invocation);
      const handles: AgentRunnerAiSdkToolSetHandle[] = [
        {
          close: async () => {},
          tools: createAiSdkToolSetFromAgentTools(
            createDefaultAgentTools({
              invocation,
              modelRegistry: providerRouter.registry,
              options,
              runtimeOptions,
              salesforcePdfTools,
              settings,
              toolSelection,
            }),
          ),
        },
      ];
      if (toolSelection.kind === "all" && options.slackMcpTokenResolver !== undefined) {
        try {
          const slackMcpToolSet = await createSlackMcpToolSet({
            context: {
              enterpriseId: invocation.enterpriseId,
              isEnterpriseInstall: invocation.isEnterpriseInstall,
              sourceText: invocation.text,
              teamId: invocation.teamId,
              userId: invocation.userId,
              viewerContextChannelIds: invocation.viewerContextChannelIds,
            },
            tokenResolver: options.slackMcpTokenResolver,
          });
          if (slackMcpToolSet !== undefined) {
            handles.push(slackMcpToolSet);
          }
        } catch (error) {
          logWarn(options.logger, "Failed to prepare Slack MCP toolset for agent invocation.", {
            channelId: invocation.channelId,
            error,
            modelId: model.id,
            provider: model.provider,
            teamId: invocation.teamId,
          });
        }
      }
      return handles;
    },
    toolRegistryFactory: () => new AgentToolRegistry(),
  });
}

async function runFocusedImageGenerationInvocation(input: {
  invocation: SlackAgentInvocation;
  modelRegistry: ProviderRouter["registry"];
  options: {
    credentialResolver?: ProviderCredentialResolver;
    featureSettingsRepository?: WorkspaceFeatureSettingsRepository;
  };
  runtimeOptions: AgentRunnerRuntimeOptions;
  settings: AppSettings;
}): Promise<AgentRunnerDirectInvocationResult | undefined> {
  const { invocation, modelRegistry, options, runtimeOptions, settings } = input;
  if (!shouldUseFocusedImageGenerationInvocation(invocation)) {
    return undefined;
  }
  const prompt = focusedImageGenerationPrompt(invocation);
  const [generateImage] = createMediaGenerationAgentTools({
    context: {
      channelId: invocation.channelId,
      teamId: invocation.teamId,
      viewerContextChannelIds: invocation.viewerContextChannelIds,
    },
    credentialResolver: options.credentialResolver,
    featureSettingsRepository: options.featureSettingsRepository,
    imageGenerationFallbackModelIds: defaultImageGenerationFallbackModelIds,
    imageGenerationModelId: settings.imageGenerationModelId,
    modelRegistry,
    onGenerationStart: runtimeOptions.onImageGenerationStart,
  });
  if (generateImage === undefined) {
    return undefined;
  }
  const output = await generateImage.execute({ prompt });
  const toolResult: AgentToolResult = {
    input: { prompt },
    output,
    toolCallId: "direct-generate-image",
    toolName: generateImage.name,
  };
  return {
    model: modelForToolOutput(output, modelRegistry, settings.agentModelId),
    result: {
      content: toolOutputMessage(output),
      finishReason: "stop",
    },
    toolResults: [toolResult],
  };
}

function createDefaultAgentTools(input: {
  invocation: SlackAgentInvocation;
  modelRegistry: ProviderRouter["registry"];
  options: {
    credentialResolver?: ProviderCredentialResolver;
    featureSettingsRepository?: WorkspaceFeatureSettingsRepository;
    logger?: unknown;
    salesforcePdfTools?: Omit<SalesforcePdfToolOptions, "context">;
    slackMcpTokenResolver?: SlackMcpTokenResolver;
  };
  runtimeOptions: AgentRunnerRuntimeOptions;
  salesforcePdfTools?: Omit<SalesforcePdfToolOptions, "context">;
  settings: AppSettings;
  toolSelection: DefaultAgentToolSelection;
}): AgentToolDefinition[] {
  const {
    invocation,
    modelRegistry,
    options,
    runtimeOptions,
    salesforcePdfTools,
    settings,
    toolSelection,
  } = input;
  return [
    ...(toolSelection.kind !== "all" || options.slackMcpTokenResolver === undefined
      ? []
      : createSlackRealTimeSearchAgentTools({
          context: {
            channelId: invocation.channelId,
            enterpriseId: invocation.enterpriseId,
            isEnterpriseInstall: invocation.isEnterpriseInstall,
            teamId: invocation.teamId,
            userId: invocation.userId,
          },
          fallbackQuery: invocation.text,
          logger: options.logger,
          tokenResolver: options.slackMcpTokenResolver,
        })),
    ...createMediaGenerationAgentTools({
      context: {
        channelId: invocation.channelId,
        teamId: invocation.teamId,
        viewerContextChannelIds: invocation.viewerContextChannelIds,
      },
      credentialResolver: options.credentialResolver,
      featureSettingsRepository: options.featureSettingsRepository,
      imageGenerationFallbackModelIds: defaultImageGenerationFallbackModelIds,
      imageGenerationModelId: settings.imageGenerationModelId,
      modelRegistry,
      onGenerationStart: runtimeOptions.onImageGenerationStart,
    }),
    ...(toolSelection.kind !== "all"
      ? []
      : createSpeechGenerationAgentTools({
          context: {
            channelId: invocation.channelId,
            teamId: invocation.teamId,
          },
          credentialResolver: options.credentialResolver,
          featureSettingsRepository: options.featureSettingsRepository,
          modelRegistry,
          textToSpeechModelId: settings.textToSpeechModelId,
        })),
    ...(toolSelection.kind !== "all" || salesforcePdfTools === undefined
      ? []
      : createSalesforcePdfAgentTools({
          ...salesforcePdfTools,
          context: {
            slackUserId: invocation.userId,
            teamId: invocation.teamId,
          },
        })),
    ...(toolSelection.kind !== "all" || options.credentialResolver === undefined
      ? []
      : createSoracomAgentTools({
          context: {
            teamId: invocation.teamId,
          },
          credentialResolver: options.credentialResolver,
        })),
  ];
}

function modelForToolOutput(
  output: JsonValue,
  modelRegistry: ProviderRouter["registry"],
  fallbackModelId: string,
): ModelInfo {
  const media = isJsonObject(output) ? output.media : undefined;
  const modelId =
    isJsonObject(media) && typeof media.modelId === "string" ? media.modelId : fallbackModelId;
  try {
    return modelRegistry.get(modelId);
  } catch {
    return modelRegistry.get(fallbackModelId);
  }
}

function toolOutputMessage(output: JsonValue): string {
  return isJsonObject(output) && typeof output.message === "string"
    ? output.message
    : "Image generation completed.";
}

type DefaultAgentToolSelection = {
  kind: "all" | "image_generation_only";
};

function selectDefaultAgentToolSelection(
  invocation: SlackAgentInvocation,
): DefaultAgentToolSelection {
  return shouldUseFocusedImageGenerationInvocation(invocation)
    ? { kind: "image_generation_only" }
    : { kind: "all" };
}

export function shouldUseFocusedImageGenerationInvocation(
  invocation: SlackAgentInvocation,
): boolean {
  return (
    shouldUseFocusedImageGenerationTools(invocation.text) ||
    (findPriorImageGenerationRequest(invocation) !== undefined &&
      isImageModificationRequest(invocation.text))
  );
}

function focusedImageGenerationPrompt(invocation: SlackAgentInvocation): string {
  const priorRequest = findPriorImageGenerationRequest(invocation);
  if (priorRequest === undefined || shouldUseFocusedImageGenerationTools(invocation.text)) {
    return invocation.text;
  }
  return [
    "Create a new image based on the earlier image request, applying the follow-up change.",
    `Earlier image request: ${priorRequest}`,
    `Follow-up change: ${invocation.text}`,
  ].join("\n");
}

export function shouldUseFocusedImageGenerationTools(text: string): boolean {
  const normalizedText = text.normalize("NFKC").toLowerCase();
  const hasImageTarget =
    /\b(image|picture|photo|illustration|drawing)\b/u.test(normalizedText) ||
    /(画像|イメージ|絵|写真|イラスト)/u.test(normalizedText);
  const hasGenerationIntent =
    /\b(generate|create|draw|render|produce)\b/u.test(normalizedText) ||
    /\bmake\s+(an?\s+)?(image|picture|photo|illustration|drawing)\b/u.test(normalizedText) ||
    /(生成|作成|作って|つくって|描いて|描画)/u.test(normalizedText);
  return hasImageTarget && hasGenerationIntent;
}

function isImageModificationRequest(text: string): boolean {
  const normalizedText = text.normalize("NFKC").toLowerCase();
  return (
    /\b(edit|modify)\b|\b(change|adjust|update)\s+(it|this|that|the image|the picture|the photo)\b/u.test(
      normalizedText,
    ) ||
    /\b(make|turn)\s+(it|this|that|the image|the picture|the photo)?\s*(black|white|red|blue|green|brighter|darker|larger|smaller)\b/u.test(
      normalizedText,
    ) ||
    /\b(change|set|adjust)\s+(the\s+)?colou?r\b|\bcolou?r\s+(to|into)\s+(black|white|red|blue|green)\b/u.test(
      normalizedText,
    ) ||
    /(変えて|変更して|編集して|修正して|加工して)/u.test(normalizedText) ||
    /(色|カラー).*(変えて|変更して)/u.test(normalizedText) ||
    /(黒|白|赤|青|緑)(くして|にして|っぽくして|い[^。！？\n]*にして)/u.test(normalizedText) ||
    /(明るく|暗く|大きく|小さく).*(して|変えて)/u.test(normalizedText)
  );
}

function findPriorImageGenerationRequest(invocation: SlackAgentInvocation): string | undefined {
  for (const message of [...invocation.threadHistory].reverse()) {
    if (message.role === "user" && shouldUseFocusedImageGenerationTools(message.text)) {
      return message.text;
    }
  }
  for (const message of [...invocation.threadMessages].reverse()) {
    if (shouldUseFocusedImageGenerationTools(message)) {
      return message;
    }
  }
  return undefined;
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
  const threadId = slackThreadScopedId(
    input.invocation.teamId,
    input.invocation.channelId,
    input.invocation.threadTs ??
      input.invocation.threadHistory[0]?.messageTs ??
      input.invocation.messageTs,
  );
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
                    threadId,
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
                    threadId,
                  },
                  role: "user",
                },
        )
      : input.invocation.threadMessages.map(
          (message, index): ConversationMessage => ({
            author: { id: slackScopedId(input.invocation.teamId, "thread"), kind: "user" },
            content: [{ text: message, type: "text" }],
            id: `thread-${index}`,
            provenance: {
              source: "slack",
              threadId,
            },
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
          threadId,
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

function slackThreadScopedId(teamId: string, channelId: string, threadTs: string): string {
  return `${teamId}:${channelId}:${threadTs}`;
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
  const structuredResult = generatedArtifactToolOutput(toolResults);
  const slackCanvasUrl = slackCreateCanvasUrlFromToolResults(toolResults);
  return {
    decision,
    message: agentTextResultSchema.parse({
      message: nonEmptyAgentMessage(result, structuredResult, slackCanvasUrl),
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

function generatedArtifactToolOutput(toolResults: AgentToolResult[]): JsonValue | undefined {
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

function slackCanvasUnavailableMessage(
  invocation: SlackAgentInvocation,
  aiSdkTools: ToolSet | undefined,
): string | undefined {
  if (!looksLikeSlackCanvasCreationRequest(invocation.text)) {
    return undefined;
  }
  if (aiSdkTools?.slack_create_canvas !== undefined) {
    return undefined;
  }
  if (containsJapanese(invocation.text)) {
    return "Slack Canvasを作成するには、Slack MCPのユーザー認可が必要です。アプリを canvases:read / canvases:write のユーザースコープ付きで再インストールしてから、もう一度試してください。";
  }
  return "Creating a Slack Canvas requires Slack MCP user authorization. Reinstall the app with the canvases:read and canvases:write user scopes, then try again.";
}

function looksLikeSlackCanvasCreationRequest(text: string): boolean {
  if (!/(canvas|キャンバス)/i.test(text)) {
    return false;
  }
  if (/(create|generate|make|turn|作成|生成|作|して)/i.test(text)) {
    return true;
  }
  return (
    /summari[sz]e.+\b(into|to|as)\b.+canvas/i.test(text) ||
    /(canvas|キャンバス).*(に|へ).*(まとめ|要約)/i.test(text)
  );
}

function containsJapanese(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
}

function mergeStreamToolCalls(
  streamedToolCalls: readonly LlmToolCall[],
  finalToolCalls: readonly LlmToolCall[] | undefined,
): LlmToolCall[] {
  const merged = new Map<string, LlmToolCall>();
  for (const toolCall of [...streamedToolCalls, ...(finalToolCalls ?? [])]) {
    merged.set(toolCall.toolCallId, toolCall);
  }
  return [...merged.values()];
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function slackCreateCanvasUrlFromToolResults(
  toolResults: readonly AgentToolResult[],
): string | undefined {
  for (const result of [...toolResults].reverse()) {
    if (result.toolName !== "slack_create_canvas") {
      continue;
    }
    const url = firstSlackCanvasUrl(result.output);
    if (url !== undefined) {
      return url;
    }
  }
  return undefined;
}

function firstSlackCanvasUrl(value: unknown): string | undefined {
  if (typeof value === "string") {
    return slackCanvasUrlFromText(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = firstSlackCanvasUrl(item);
      if (url !== undefined) {
        return url;
      }
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  for (const item of Object.values(value)) {
    const url = firstSlackCanvasUrl(item);
    if (url !== undefined) {
      return url;
    }
  }
  return undefined;
}

function slackCanvasUrlFromText(text: string): string | undefined {
  const match = text.match(slackCanvasUrlPattern());
  if (match === null) {
    return undefined;
  }
  return slackCanvasLink(match[1], match[2]);
}

function withSlackCanvasUrl(message: string, slackCanvasUrl: string | undefined): string {
  const normalizedMessage = normalizeSlackCanvasUrls(message);
  if (slackCanvasUrl === undefined || normalizedMessage.includes(slackCanvasUrl)) {
    return normalizedMessage;
  }
  return `${normalizedMessage.trim()}\n${slackCanvasUrl}`;
}

function normalizeSlackCanvasUrls(message: string): string {
  return message.replace(slackCanvasUrlPattern("g"), (_url, teamId: string, canvasId: string) => {
    return slackCanvasLink(teamId, canvasId);
  });
}

function slackCanvasLink(teamId: string, canvasId: string): string {
  return `<https://app.slack.com/docs/${teamId}/${canvasId}>`;
}

function slackCanvasUrlPattern(flags = ""): RegExp {
  return new RegExp(
    "<?https://(?:app|[a-z0-9-]+)\\.slack\\.com/docs/([a-z0-9]+)/(f(?=[a-z0-9]*\\d)[a-z0-9]{7,})(?![a-z0-9])(?:\\|[^>]+>|>?)",
    `i${flags}`,
  );
}

function nonEmptyAgentMessage(
  result: LlmResult,
  structuredResult?: JsonValue,
  slackCanvasUrl?: string,
): string {
  if (result.content.trim().length > 0) {
    return withSlackCanvasUrl(result.content, slackCanvasUrl);
  }
  if (isJsonObject(structuredResult) && typeof structuredResult.message === "string") {
    return withSlackCanvasUrl(structuredResult.message, slackCanvasUrl);
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
