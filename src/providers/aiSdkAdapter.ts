import { anthropic, createAnthropic, type AnthropicProviderSettings } from "@ai-sdk/anthropic";
import { azure, createAzure, type AzureOpenAIProviderSettings } from "@ai-sdk/azure";
import {
  createGoogleGenerativeAI,
  google,
  type GoogleGenerativeAIProviderSettings,
} from "@ai-sdk/google";
import { createGroq, groq, type GroqProviderSettings } from "@ai-sdk/groq";
import { createOpenAI, openai, type OpenAIProviderSettings } from "@ai-sdk/openai";
import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from "@ai-sdk/openai-compatible";
import {
  generateText,
  jsonSchema,
  streamText,
  tool,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type ToolSet,
} from "ai";

import {
  convertHistoryToAiSdkMessages,
  aiSdkMessageConversionCapabilitiesForModel,
} from "./aiSdkMessageConverter.js";
import type {
  LlmAdapter,
  LlmCapability,
  LlmProvider,
  LlmRequest,
  LlmResult,
  LlmStreamEvent,
  LlmToolCall,
  LlmUsage,
  ModelInfo,
} from "./contracts.js";

export type AiSdkModelResolver = (model: ModelInfo) => LanguageModel;

export type AiSdkAdapterSettings = {
  anthropic?: AnthropicProviderSettings;
  azureOpenAI?: AzureOpenAIProviderSettings;
  google?: GoogleGenerativeAIProviderSettings;
  groq?: GroqProviderSettings;
  openAI?: OpenAIProviderSettings;
  openAICompatible?: Partial<Record<OpenAICompatibleProvider, OpenAICompatibleProviderConfig>>;
};

export type OpenAICompatibleProvider = "litellm" | "nvidia" | "plamo" | "xai";

export type OpenAICompatibleProviderConfig = Omit<
  OpenAICompatibleProviderSettings,
  "baseURL" | "name"
> & {
  baseURL?: string;
  name?: string;
};

export class LlmProviderError extends Error {
  constructor(
    readonly provider: LlmProvider,
    readonly modelId: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LlmProviderError";
  }
}

export class AiSdkLlmAdapter implements LlmAdapter {
  constructor(
    readonly provider: LlmProvider,
    private readonly resolveModel: AiSdkModelResolver,
  ) {}

  async generate(request: LlmRequest): Promise<LlmResult> {
    try {
      assertSupportedResponseFormat(request);
      const result = await generateText({
        maxOutputTokens: request.maxOutputTokens,
        messages: convertHistoryToAiSdkMessages(
          request.history,
          aiSdkMessageConversionCapabilitiesForModel(request.model),
        ),
        model: this.resolveModel(request.model),
        providerOptions: request.providerOptions,
        temperature: request.temperature,
        tools: toAiSdkTools(request.tools),
      });

      return {
        content: result.text,
        finishReason: mapFinishReason(result.finishReason),
        raw: result,
        toolCalls: result.toolCalls.map(mapToolCall),
        usage: mapUsage(result.usage),
      };
    } catch (error) {
      throw normalizeProviderError(request.model, error);
    }
  }

  supports(_request: LlmRequest, requiredCapabilities: readonly LlmCapability[]): boolean {
    if (
      _request.model.provider === "google" &&
      requiredCapabilities.some((capability) => googleNativeOnlyCapabilities.has(capability))
    ) {
      return false;
    }
    return !requiredCapabilities.some((capability) => nativeOnlyCapabilities.has(capability));
  }

  stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    return this.streamResponse(request);
  }

  private async *streamResponse(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    try {
      assertSupportedResponseFormat(request);
      const result = streamText({
        maxOutputTokens: request.maxOutputTokens,
        messages: convertHistoryToAiSdkMessages(
          request.history,
          aiSdkMessageConversionCapabilitiesForModel(request.model),
        ),
        model: this.resolveModel(request.model),
        providerOptions: request.providerOptions,
        temperature: request.temperature,
        tools: toAiSdkTools(request.tools),
      });

      let text = "";
      let finishReason: FinishReason | undefined;
      let usage: LanguageModelUsage | undefined;
      let hasError = false;
      const toolCalls: LlmToolCall[] = [];

      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            text += part.text;
            yield {
              text: part.text,
              type: "text-delta",
            };
            break;
          case "tool-call": {
            const toolCall = mapToolCall(part);
            toolCalls.push(toolCall);
            yield {
              toolCall,
              type: "tool-call",
            };
            break;
          }
          case "finish":
            finishReason = part.finishReason;
            usage = part.totalUsage;
            break;
          case "error":
            hasError = true;
            yield {
              error: normalizeProviderError(request.model, part.error),
              type: "error",
            };
            break;
        }
      }

      if (hasError) {
        return;
      }

      const mappedUsage = usage === undefined ? undefined : mapUsage(usage);
      if (mappedUsage !== undefined) {
        yield {
          type: "usage",
          usage: mappedUsage,
        };
      }
      yield {
        result: {
          content: text,
          finishReason: finishReason === undefined ? "unknown" : mapFinishReason(finishReason),
          toolCalls,
          usage: mappedUsage,
        },
        type: "done",
      };
    } catch (error) {
      yield {
        error: normalizeProviderError(request.model, error),
        type: "error",
      };
    }
  }
}

const nativeOnlyCapabilities = new Set<LlmCapability>([
  "embeddings",
  "image_generation",
  "thinking",
  "web_search",
]);

const googleNativeOnlyCapabilities = new Set<LlmCapability>(["file_input"]);

function assertSupportedResponseFormat(request: LlmRequest): void {
  if (request.responseFormat !== undefined && request.responseFormat.type !== "text") {
    throw new LlmProviderError(
      request.model.provider,
      request.model.id,
      "AI SDK common adapter currently supports text response format only.",
    );
  }
}

export function createAiSdkAdapters(settings: AiSdkAdapterSettings = {}): AiSdkLlmAdapter[] {
  const resolveModel = createAiSdkModelResolver(settings);
  const commonLaneProviders = [
    "openai",
    "azure_openai",
    "anthropic",
    "google",
    "groq",
    "xai",
    "plamo",
    "nvidia",
    "litellm",
  ] as const satisfies readonly LlmProvider[];

  return commonLaneProviders.map((provider) => new AiSdkLlmAdapter(provider, resolveModel));
}

export function createAiSdkModelResolver(settings: AiSdkAdapterSettings = {}): AiSdkModelResolver {
  const configuredOpenAI = settings.openAI === undefined ? openai : createOpenAI(settings.openAI);
  const configuredAzure =
    settings.azureOpenAI === undefined ? azure : createAzure(settings.azureOpenAI);
  const configuredAnthropic =
    settings.anthropic === undefined ? anthropic : createAnthropic(settings.anthropic);
  const configuredGoogle =
    settings.google === undefined ? google : createGoogleGenerativeAI(settings.google);
  const configuredGroq = settings.groq === undefined ? groq : createGroq(settings.groq);
  const openAICompatibleProviders = createOpenAICompatibleProviders(settings.openAICompatible);

  return (model: ModelInfo): LanguageModel => {
    switch (model.provider) {
      case "openai":
        return configuredOpenAI(model.providerModelId);
      case "azure_openai":
        return configuredAzure(model.providerModelId);
      case "anthropic":
        return configuredAnthropic(model.providerModelId);
      case "google":
        return configuredGoogle(model.providerModelId);
      case "groq":
        return configuredGroq(model.providerModelId);
      case "xai":
      case "plamo":
      case "nvidia":
      case "litellm":
        return openAICompatibleProviders[model.provider](model.providerModelId);
      case "bedrock":
      case "dify":
        throw new LlmProviderError(
          model.provider,
          model.id,
          `Provider '${model.provider}' is not handled by the AI SDK common adapter lane.`,
        );
    }
  };
}

function createOpenAICompatibleProviders(
  configuredProviders: AiSdkAdapterSettings["openAICompatible"] = {},
) {
  return {
    litellm: createOpenAICompatible(
      openAICompatibleSettings("litellm", configuredProviders.litellm),
    ),
    nvidia: createOpenAICompatible(openAICompatibleSettings("nvidia", configuredProviders.nvidia)),
    plamo: createOpenAICompatible(openAICompatibleSettings("plamo", configuredProviders.plamo)),
    xai: createOpenAICompatible(openAICompatibleSettings("xai", configuredProviders.xai)),
  };
}

function openAICompatibleSettings(
  provider: OpenAICompatibleProvider,
  config: OpenAICompatibleProviderConfig = {},
): OpenAICompatibleProviderSettings {
  return {
    ...config,
    apiKey: config.apiKey ?? defaultOpenAICompatibleApiKey(provider),
    baseURL: config.baseURL ?? defaultOpenAICompatibleBaseUrl(provider),
    name: config.name ?? provider,
  };
}

function defaultOpenAICompatibleApiKey(provider: OpenAICompatibleProvider): string | undefined {
  switch (provider) {
    case "xai":
      return process.env.XAI_API_KEY;
    case "plamo":
      return process.env.PLAMO_API_KEY;
    case "nvidia":
      return process.env.NVIDIA_API_KEY;
    case "litellm":
      return process.env.LITELLM_API_KEY;
  }
}

function defaultOpenAICompatibleBaseUrl(provider: OpenAICompatibleProvider): string {
  switch (provider) {
    case "xai":
      return process.env.XAI_BASE_URL ?? "https://api.x.ai/v1";
    case "plamo":
      return process.env.PLAMO_API_BASE_URL ?? "https://api.platform.preferredai.jp/v1";
    case "nvidia":
      return process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
    case "litellm":
      return process.env.LITELLM_BASE_URL ?? "http://localhost:4000/v1";
  }
}

function toAiSdkTools(tools: LlmRequest["tools"]): ToolSet | undefined {
  if (tools === undefined || tools.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    tools.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(
          definition.parameters ?? {
            additionalProperties: true,
            type: "object",
          },
        ),
      }),
    ]),
  ) as ToolSet;
}

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

function mapUsage(usage: LanguageModelUsage): LlmUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

function mapFinishReason(reason: FinishReason): LlmResult["finishReason"] {
  switch (reason) {
    case "stop":
    case "length":
    case "content-filter":
    case "tool-calls":
    case "error":
      return reason === "content-filter"
        ? "content_filter"
        : reason === "tool-calls"
          ? "tool_call"
          : reason;
    case "other":
      return "unknown";
  }
}

function normalizeProviderError(model: ModelInfo, error: unknown): LlmProviderError {
  if (error instanceof LlmProviderError) {
    return error;
  }

  const message = error instanceof Error ? error.message : "Unknown provider invocation error.";
  return new LlmProviderError(model.provider, model.id, message, error);
}
