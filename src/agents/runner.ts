import type { AppSettings } from "../config.js";
import type { ConversationHistory, JsonValue, UserMessagePart } from "../domain/messageHistory.js";
import { createAiSdkAdapters } from "../providers/aiSdkAdapter.js";
import type { LlmRequest, LlmResult, ModelInfo } from "../providers/contracts.js";
import type { ProviderCredentialResolver } from "../providers/credentials.js";
import { createNativeProviderAdapters } from "../providers/nativeProviderAdapters.js";
import { ProviderRouter } from "../providers/providerRouter.js";
import {
  type AgentRouterDecision,
  type AgentSpecialist,
  type SlackAgentInvocation,
  agentRouterDecisionSchema,
  slackAgentInvocationSchema,
  specialistTextResultSchema,
  translationResultSchema,
  workManagerResultSchema,
} from "./schemas.js";
import {
  AgentSpecialistRuntimeError,
  createDefaultSpecialistRuntimes,
  type AgentSpecialistRuntime,
} from "./specialistRuntimes.js";
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
    readonly specialist: AgentSpecialist,
    readonly model: AgentRunnerModelTrace | undefined,
    cause: unknown,
  ) {
    super(`TypeScript AgentRunner failed for ${specialist}: ${errorMessage(cause)}`, { cause });
    this.name = "AgentRunnerExecutionError";
  }
}

export type AgentRunnerOptions = {
  credentialResolver?: ProviderCredentialResolver;
  defaultModelId: string;
  maxToolRounds?: number;
  providerRouter: Pick<ProviderRouter, "generate" | "registry">;
  specialistRuntimes?: Partial<Record<AgentSpecialist, AgentSpecialistRuntime>>;
  specialistPrompts?: Partial<Record<AgentSpecialist, string>>;
  toolRegistry?: AgentToolRegistry;
};

const DEFAULT_SPECIALIST_PROMPTS = {
  assistant:
    "You are the general Party on Slack assistant. Reply directly and concisely for Slack.",
  google_maps:
    "You are the Google Maps specialist. Return a concise Slack-ready answer with place, route, or map context.",
  image_generation:
    "You are the image-generation specialist. Describe the image generation outcome or ask for missing details.",
  translation:
    "You are the translation specialist. Return JSON with action, translatedText, sourceLanguage, targetLanguage, and optional message.",
  video_generation:
    "You are the video-generation specialist. Describe the video generation plan or ask for missing details.",
  web_research:
    "You are the web-research specialist. Produce a source-aware concise answer and call out any freshness limits.",
  work_manager:
    "You are the work-manager specialist. Return JSON with action, message, and workItems when relevant.",
} as const satisfies Record<AgentSpecialist, string>;

export class AgentRunner {
  constructor(private readonly options: AgentRunnerOptions) {}

  async run(invocationInput: unknown): Promise<AgentRunnerResult> {
    const invocation = slackAgentInvocationSchema.parse(invocationInput);
    const decision = selectSpecialist(invocation);
    const nativeRuntime = this.options.specialistRuntimes?.[decision.specialist];
    if (nativeRuntime !== undefined) {
      const model = this.resolveModel(decision.specialist, invocation.modelId);
      let result;
      try {
        result = await nativeRuntime({
          invocation,
          model,
          providerRouter: this.options.providerRouter,
        });
      } catch (error) {
        throw new AgentRunnerExecutionError(
          decision.specialist,
          modelTraceFromRuntimeError(error),
          error,
        );
      }
      return {
        decision,
        message: result.message,
        model: result.model,
        raw: result.raw,
        structuredResult: result.structuredResult,
        toolResults: [],
      };
    }
    const { model, result, toolResults } = await this.runSpecialist(invocation, decision);

    try {
      return normalizeRunnerResult(decision, model, result, toolResults);
    } catch (error) {
      throw new AgentRunnerExecutionError(decision.specialist, modelTrace(model), error);
    }
  }

  private async runSpecialist(
    invocation: SlackAgentInvocation,
    decision: AgentRouterDecision,
  ): Promise<{ model: ModelInfo; result: LlmResult; toolResults: AgentToolResult[] }> {
    const model = this.resolveModel(decision.specialist, invocation.modelId);
    const toolResults: AgentToolResult[] = [];
    try {
      let history = buildSpecialistHistory({
        invocation,
        model,
        prompt: this.promptFor(decision.specialist),
        toolResults,
      });
      const requestBase: Omit<LlmRequest, "history"> = {
        context: {
          workspaceId: invocation.teamId,
        },
        maxOutputTokens: 1200,
        metadata: {
          slack_channel_id: invocation.channelId,
          slack_team_id: invocation.teamId,
          slack_user_id: invocation.userId,
          specialist: decision.specialist,
        },
        model,
        tools:
          decision.specialist === "work_manager"
            ? this.options.toolRegistry?.definitions()
            : undefined,
      };
      const maxToolRounds = this.options.maxToolRounds ?? 1;
      for (let round = 0; round <= maxToolRounds; round += 1) {
        const result = await this.options.providerRouter.generate({ ...requestBase, history });
        if ((result.toolCalls?.length ?? 0) === 0) {
          return { model, result, toolResults };
        }
        if (this.options.toolRegistry === undefined) {
          throw new Error("Agent returned tool calls, but no tool registry is configured.");
        }
        if (round === maxToolRounds) {
          throw new Error("Agent exceeded the configured tool-call round limit.");
        }
        const roundToolResults = await this.options.toolRegistry.executeAll(result.toolCalls ?? []);
        toolResults.push(...roundToolResults);
        history = buildSpecialistHistory({
          invocation,
          model,
          prompt: this.promptFor(decision.specialist),
          toolResults,
        });
      }
      throw new Error("Agent tool-call loop ended unexpectedly.");
    } catch (error) {
      if (error instanceof AgentRunnerExecutionError) {
        throw error;
      }
      throw new AgentRunnerExecutionError(decision.specialist, modelTrace(model), error);
    }
  }

  private promptFor(specialist: AgentSpecialist): string {
    return this.options.specialistPrompts?.[specialist] ?? DEFAULT_SPECIALIST_PROMPTS[specialist];
  }

  private resolveModel(specialist: AgentSpecialist, modelId?: string): ModelInfo {
    const resolvedModelId = modelId ?? this.options.defaultModelId;
    try {
      return this.options.providerRouter.registry.get(resolvedModelId);
    } catch (error) {
      throw new AgentRunnerExecutionError(specialist, { id: resolvedModelId }, error);
    }
  }
}

export function createDefaultAgentRunner(
  settings: AppSettings,
  options: { credentialResolver?: ProviderCredentialResolver } = {},
): AgentRunner {
  return new AgentRunner({
    credentialResolver: options.credentialResolver,
    defaultModelId: settings.agentModelId,
    providerRouter: new ProviderRouter([
      ...createNativeProviderAdapters({ credentialResolver: options.credentialResolver }),
      ...createAiSdkAdapters({}, { credentialResolver: options.credentialResolver }),
    ]),
    specialistRuntimes: createDefaultSpecialistRuntimes(settings, {
      credentialResolver: options.credentialResolver,
    }),
    toolRegistry: new AgentToolRegistry(),
  });
}

export function selectSpecialist(invocation: SlackAgentInvocation): AgentRouterDecision {
  if (invocation.specialist !== undefined) {
    return agentRouterDecisionSchema.parse({
      confidence: 1,
      reason: "forced_invocation",
      specialist: invocation.specialist,
    });
  }

  return agentRouterDecisionSchema.parse({
    confidence: 0.5,
    reason: "unrouted_invocation",
    specialist: "assistant",
  });
}

function buildSpecialistHistory(input: {
  invocation: SlackAgentInvocation;
  model: ModelInfo;
  prompt: string;
  toolResults: AgentToolResult[];
}): ConversationHistory {
  return {
    messages: [
      {
        content: input.prompt,
        id: "system",
        role: "system",
      },
      ...input.invocation.threadMessages.map((message, index) => ({
        author: { id: "slack-thread", kind: "user" as const },
        content: [{ text: message, type: "text" as const }],
        id: `thread-${index}`,
        role: "user" as const,
      })),
      {
        author: { id: input.invocation.userId, kind: "user" },
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
  if (decision.specialist === "work_manager") {
    const parsed = parseJsonObject(result.content);
    const structured = workManagerResultSchema.parse(parsed);
    return {
      decision,
      message: structured.message,
      model: modelSummary,
      raw: result.raw,
      structuredResult: structured,
      toolResults,
    };
  }
  if (decision.specialist === "translation") {
    const parsed = parseJsonObject(result.content);
    const structured = translationResultSchema.parse(parsed);
    return {
      decision,
      message: structured.translatedText ?? structured.message ?? "Translation completed.",
      model: modelSummary,
      raw: result.raw,
      structuredResult: structured,
      toolResults,
    };
  }
  return {
    decision,
    message: specialistTextResultSchema.parse({ message: result.content }).message,
    model: modelSummary,
    raw: result.raw,
    toolResults,
  };
}

function modelTrace(model: ModelInfo): AgentRunnerModelTrace {
  return {
    id: model.id,
    provider: model.provider,
  };
}

function modelTraceFromRuntimeError(error: unknown): AgentRunnerModelTrace | undefined {
  return error instanceof AgentSpecialistRuntimeError ? error.model : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function parseJsonObject(content: string): JsonValue {
  const trimmed = content.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Agent response did not contain a JSON object.");
  }
  return JSON.parse(trimmed.slice(start, end + 1)) as JsonValue;
}
