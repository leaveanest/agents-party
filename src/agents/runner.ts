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
import { AgentToolRegistry, type AgentToolResult } from "./toolContracts.js";

export type AgentRunnerResult = {
  decision: AgentRouterDecision;
  message: string;
  raw?: unknown;
  structuredResult?: JsonValue;
  toolResults: AgentToolResult[];
};

export type AgentRunnerOptions = {
  defaultModelId: string;
  providerRouter: Pick<ProviderRouter, "generate" | "registry">;
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
    const result = await this.runSpecialist(invocation, decision);
    const toolResults =
      this.options.toolRegistry === undefined
        ? []
        : await this.options.toolRegistry.executeAll(result.toolCalls ?? []);

    return normalizeRunnerResult(decision, result, toolResults);
  }

  private async runSpecialist(
    invocation: SlackAgentInvocation,
    decision: AgentRouterDecision,
  ): Promise<LlmResult> {
    const model = this.options.providerRouter.registry.get(this.options.defaultModelId);
    const request: LlmRequest = {
      history: buildSpecialistHistory({
        invocation,
        model,
        prompt: this.promptFor(decision.specialist),
        toolResults: [],
      }),
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
    return this.options.providerRouter.generate(request);
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
    toolRegistry: new AgentToolRegistry(),
  });
}

export function selectSpecialist(invocation: SlackAgentInvocation): AgentRouterDecision {
  const text = invocation.text.toLocaleLowerCase();
  const specialist: AgentSpecialist =
    /\b(todo|tasks?|work items?|remind|due|担当|タスク|リマインド)\b/u.test(text)
      ? "work_manager"
      : /\b(translate|translation|翻訳|訳して)\b/u.test(text)
        ? "translation"
        : /\b(map|route|place|nearby|地図|場所|経路)\b/u.test(text)
          ? "google_maps"
          : /\b(image|draw|picture|画像|絵)\b/u.test(text)
            ? "image_generation"
            : /\b(video|movie|動画)\b/u.test(text)
              ? "video_generation"
              : /\b(research|source|調べ|検索)\b/u.test(text)
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
    ],
  };
}

function normalizeRunnerResult(
  decision: AgentRouterDecision,
  result: LlmResult,
  toolResults: AgentToolResult[],
): AgentRunnerResult {
  if (decision.specialist === "work_manager") {
    const parsed = parseJsonObject(result.content);
    const structured = workManagerResultSchema.parse(parsed);
    return {
      decision,
      message: structured.message,
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
      raw: result.raw,
      structuredResult: structured,
      toolResults,
    };
  }
  return {
    decision,
    message: specialistTextResultSchema.parse({ message: result.content }).message,
    raw: result.raw,
    toolResults,
  };
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
