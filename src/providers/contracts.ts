import type { ToolSet } from "ai";

import type { ConversationHistory, JsonValue } from "../domain/messageHistory.js";

export const LlmProviderId = {
  Anthropic: "anthropic",
  AzureOpenAI: "azure_openai",
  Baseten: "baseten",
  Bedrock: "bedrock",
  Cerebras: "cerebras",
  Cohere: "cohere",
  DeepInfra: "deepinfra",
  DeepSeek: "deepseek",
  Dify: "dify",
  Fireworks: "fireworks",
  Google: "google",
  Groq: "groq",
  LiteLLM: "litellm",
  Mistral: "mistral",
  Nvidia: "nvidia",
  OpenAI: "openai",
  PLaMo: "plamo",
  Perplexity: "perplexity",
  TogetherAI: "togetherai",
  XAI: "xai",
} as const;

export type LlmProvider = (typeof LlmProviderId)[keyof typeof LlmProviderId];

export const llmProviders = Object.values(LlmProviderId);

export const LlmCapabilityId = {
  AudioInput: "audio_input",
  Embeddings: "embeddings",
  FileInput: "file_input",
  ImageGeneration: "image_generation",
  ImageInput: "image_input",
  Streaming: "streaming",
  StructuredOutput: "structured_output",
  Text: "text",
  TextToSpeech: "text_to_speech",
  Thinking: "thinking",
  ToolCalling: "tool_calling",
  Transcription: "transcription",
  VideoGeneration: "video_generation",
  WebSearch: "web_search",
} as const;

export type LlmCapability = (typeof LlmCapabilityId)[keyof typeof LlmCapabilityId];

export const llmCapabilities = Object.values(LlmCapabilityId);

export type ModelInfo = {
  aliases?: readonly string[];
  capabilities: readonly LlmCapability[];
  displayName?: string;
  id: string;
  provider: LlmProvider;
  providerModelId: string;
};

export type LlmToolDefinition = {
  description?: string;
  name: string;
  parameters?: JsonValue;
};

export type LlmResponseFormat =
  | {
      type: "text";
    }
  | {
      jsonSchemaDescription?: string;
      jsonSchemaName?: string;
      jsonSchema?: JsonValue;
      type: "json";
    };

export const LlmReasoningEffortId = {
  High: "high",
  Low: "low",
  Medium: "medium",
  Minimal: "minimal",
  None: "none",
  ProviderDefault: "provider_default",
  XHigh: "xhigh",
} as const;

export type LlmReasoningEffort = (typeof LlmReasoningEffortId)[keyof typeof LlmReasoningEffortId];

export type LlmInvocationContext = {
  workspaceId?: string;
};

export type LlmRequest = {
  aiSdkTools?: ToolSet;
  context?: LlmInvocationContext;
  history: ConversationHistory;
  maxOutputTokens?: number;
  metadata?: Record<string, JsonValue>;
  model: ModelInfo;
  providerOptions?: Record<string, Record<string, JsonValue>>;
  reasoningEffort?: LlmReasoningEffort;
  requiredCapabilities?: readonly LlmCapability[];
  responseFormat?: LlmResponseFormat;
  system?: string;
  temperature?: number;
  tools?: readonly LlmToolDefinition[];
};

export type LlmUsage = {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
};

export type LlmSource = {
  title?: string;
  url: string;
};

export type LlmResult = {
  content: string;
  finishReason?: "stop" | "length" | "tool_call" | "content_filter" | "error" | "unknown";
  raw?: unknown;
  sources?: readonly LlmSource[];
  structuredOutput?: JsonValue;
  toolCalls?: readonly LlmToolCall[];
  usage?: LlmUsage;
};

export type LlmToolCall = {
  input: unknown;
  toolCallId: string;
  toolName: string;
};

export type LlmStreamEvent =
  | {
      text: string;
      type: "text-delta";
    }
  | {
      toolCall: LlmToolCall;
      type: "tool-call";
    }
  | {
      type: "usage";
      usage: LlmUsage;
    }
  | {
      result: LlmResult;
      type: "done";
    }
  | {
      error: Error;
      type: "error";
    };

export type LlmAdapter = {
  generate(request: LlmRequest): Promise<LlmResult>;
  provider: LlmProvider;
  supports?(request: LlmRequest, requiredCapabilities: readonly LlmCapability[]): boolean;
  stream?(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
};
