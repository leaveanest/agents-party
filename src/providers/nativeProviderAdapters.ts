import type {
  LlmAdapter,
  LlmCapability,
  LlmProvider,
  LlmRequest,
  LlmResult,
  LlmStreamEvent,
  LlmToolCall,
} from "./contracts.js";
import { google } from "@ai-sdk/google";
import { generateText, type FinishReason } from "ai";
import {
  aiSdkMessageConversionCapabilitiesForModel,
  convertHistoryToAiSdkMessages,
} from "./aiSdkMessageConverter.js";

export type NativeProviderAdapterSpec = {
  capabilities: readonly LlmCapability[];
  provider: LlmProvider;
  reason: string;
};

export class NativeProviderUnsupportedError extends Error {
  constructor(
    readonly provider: LlmProvider,
    readonly modelId: string,
    readonly capabilities: readonly LlmCapability[],
    readonly userMessage: string,
  ) {
    super(userMessage);
    this.name = "NativeProviderUnsupportedError";
  }
}

export class UnsupportedNativeProviderAdapter implements LlmAdapter {
  readonly provider: LlmProvider;
  private readonly capabilities: ReadonlySet<LlmCapability>;

  constructor(private readonly spec: NativeProviderAdapterSpec) {
    this.provider = spec.provider;
    this.capabilities = new Set(spec.capabilities);
  }

  supports(_request: LlmRequest, requiredCapabilities: readonly LlmCapability[]): boolean {
    return requiredCapabilities.some((capability) => this.capabilities.has(capability));
  }

  async generate(request: LlmRequest): Promise<LlmResult> {
    throw this.unsupported(request);
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    yield {
      error: this.unsupported(request),
      type: "error",
    };
  }

  private unsupported(request: LlmRequest): NativeProviderUnsupportedError {
    const requestedCapabilities = request.requiredCapabilities?.filter((capability) =>
      this.capabilities.has(capability),
    );
    const capabilities =
      requestedCapabilities !== undefined && requestedCapabilities.length > 0
        ? requestedCapabilities
        : [...this.capabilities];

    return new NativeProviderUnsupportedError(
      request.model.provider,
      request.model.id,
      capabilities,
      `${request.model.provider} model '${request.model.id}' requires a native provider path for ${capabilities.join(", ")}, but that path is not implemented yet. ${this.spec.reason}`,
    );
  }
}

export class GoogleWebSearchNativeAdapter implements LlmAdapter {
  readonly provider = "google" as const;

  supports(_request: LlmRequest, requiredCapabilities: readonly LlmCapability[]): boolean {
    return requiredCapabilities.includes("web_search");
  }

  async generate(request: LlmRequest): Promise<LlmResult> {
    const result = await generateText({
      maxOutputTokens: request.maxOutputTokens,
      messages: convertHistoryToAiSdkMessages(
        request.history,
        aiSdkMessageConversionCapabilitiesForModel(request.model),
      ),
      model: google(request.model.providerModelId),
      providerOptions: request.providerOptions,
      temperature: request.temperature,
      tools: {
        google_search: google.tools.googleSearch({}),
      },
    });
    return {
      content: result.text,
      finishReason: mapFinishReason(result.finishReason),
      raw: result,
      sources: result.sources
        .filter((source) => source.sourceType === "url")
        .map((source) => ({
          title: source.title,
          url: source.url,
        })),
      toolCalls: result.toolCalls.map(mapToolCall),
      usage:
        result.usage === undefined
          ? undefined
          : {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              totalTokens: result.usage.totalTokens,
            },
    };
  }
}

export function createNativeProviderAdapters(): LlmAdapter[] {
  return [
    new GoogleWebSearchNativeAdapter(),
    ...nativeProviderAdapterSpecs.map((spec) => new UnsupportedNativeProviderAdapter(spec)),
  ];
}

export const nativeProviderAdapterSpecs: readonly NativeProviderAdapterSpec[] = [
  {
    capabilities: ["image_generation", "web_search"],
    provider: "openai",
    reason: "Use a future OpenAI Responses/native tools adapter instead of the AI SDK common lane.",
  },
  {
    capabilities: ["thinking", "web_search"],
    provider: "anthropic",
    reason: "Use a future Anthropic native adapter for thinking and web-search options.",
  },
  {
    capabilities: ["file_input"],
    provider: "google",
    reason: "Use a future Gemini native adapter for file APIs.",
  },
  {
    capabilities: ["image_input", "streaming", "text", "thinking"],
    provider: "bedrock",
    reason: "Use a future AWS Bedrock Claude adapter with AWS credential and region handling.",
  },
  {
    capabilities: ["streaming", "text", "tool_calling"],
    provider: "dify",
    reason: "Use a future Dify endpoint adapter with workspace endpoint and credential lookup.",
  },
];

function mapToolCall(toolCall: {
  input: unknown;
  toolCallId: string;
  toolName: string;
}): LlmToolCall {
  return {
    input: toolCall.input,
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
  };
}

function mapFinishReason(
  reason: FinishReason,
): "stop" | "length" | "tool_call" | "content_filter" | "error" | "unknown" {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool-calls":
      return "tool_call";
    case "content-filter":
      return "content_filter";
    case "error":
      return "error";
    default:
      return "unknown";
  }
}
