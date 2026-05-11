import type { AppSettings } from "../config.js";
import type { ConversationHistory, JsonValue, UserMessagePart } from "../domain/messageHistory.js";
import { createAiSdkAdapters } from "../providers/aiSdkAdapter.js";
import type { LlmRequest, LlmResult, ModelInfo } from "../providers/contracts.js";
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
  createDefaultSpecialistRuntimes,
  type AgentSpecialistRuntime,
} from "./specialistRuntimes.js";
import { AgentToolRegistry, type AgentToolResult } from "./toolContracts.js";

export type AgentRunnerResult = {
  decision: AgentRouterDecision;
  message: string;
  model: Pick<ModelInfo, "id" | "provider">;
  raw?: unknown;
  structuredResult?: JsonValue;
  toolResults: AgentToolResult[];
};

export type AgentRunnerOptions = {
  defaultModelId: string;
  maxToolRounds?: number;
  providerRouter: Pick<ProviderRouter, "generate" | "registry">;
  specialistRuntimes?: Partial<Record<AgentSpecialist, AgentSpecialistRuntime>>;
  specialistPrompts?: Partial<Record<AgentSpecialist, string>>;
  toolRegistry?: AgentToolRegistry;
};

const DEFAULT_SPECIALIST_PROMPTS = {
  assistant: "You are the general Agents Party assistant. Reply directly and concisely for Slack.",
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
      const model = this.options.providerRouter.registry.get(this.options.defaultModelId);
      const result = await nativeRuntime({
        invocation,
        model,
        providerRouter: this.options.providerRouter,
      });
      return {
        decision,
        message: result.message,
        model: modelTrace(model),
        raw: result.raw,
        structuredResult: result.structuredResult,
        toolResults: [],
      };
    }
    const { model, result, toolResults } = await this.runSpecialist(invocation, decision);

    return normalizeRunnerResult(decision, model, result, toolResults);
  }

  private async runSpecialist(
    invocation: SlackAgentInvocation,
    decision: AgentRouterDecision,
  ): Promise<{ model: ModelInfo; result: LlmResult; toolResults: AgentToolResult[] }> {
    const model = this.options.providerRouter.registry.get(this.options.defaultModelId);
    const toolResults: AgentToolResult[] = [];
    let history = buildSpecialistHistory({
      invocation,
      model,
      prompt: this.promptFor(decision.specialist),
      toolResults,
    });
    const requestBase: Omit<LlmRequest, "history"> = {
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
  }

  private promptFor(specialist: AgentSpecialist): string {
    return this.options.specialistPrompts?.[specialist] ?? DEFAULT_SPECIALIST_PROMPTS[specialist];
  }
}

export function createDefaultAgentRunner(settings: AppSettings): AgentRunner {
  return new AgentRunner({
    defaultModelId: settings.agentModelId,
    providerRouter: new ProviderRouter([
      ...createNativeProviderAdapters(),
      ...createAiSdkAdapters(),
    ]),
    specialistRuntimes: createDefaultSpecialistRuntimes(settings),
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

  const text = invocation.text.toLocaleLowerCase();
  const specialist: AgentSpecialist = matchesAny(text, [
    /\b(todo|tasks?|work items?|remind|due)\b/u,
    /担当|タスク|リマインド/u,
  ])
    ? "work_manager"
    : matchesAny(text, [/\b(translate|translation)\b/u, /翻訳|訳して/u])
      ? "translation"
      : matchesAny(text, [/\b(map|route|place|nearby)\b/u, /地図|場所|経路/u])
        ? "google_maps"
        : matchesAny(text, [/\b(image|draw|picture)\b/u, /画像|絵/u])
          ? "image_generation"
          : matchesAny(text, [/\b(video|movie)\b/u, /動画/u])
            ? "video_generation"
            : matchesAny(text, [/\b(research|source)\b/u, /調べ|検索/u])
              ? "web_research"
              : "assistant";

  return agentRouterDecisionSchema.parse({
    confidence: specialist === "assistant" ? 0.5 : 0.8,
    reason: "keyword_match",
    specialist,
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

function modelTrace(model: ModelInfo): Pick<ModelInfo, "id" | "provider"> {
  return {
    id: model.id,
    provider: model.provider,
  };
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
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
