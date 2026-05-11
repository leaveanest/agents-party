import type { ConversationHistory, JsonValue } from "../domain/messageHistory.js";

export const LlmProviderId = {
  Anthropic: "anthropic",
  AzureOpenAI: "azure_openai",
  Bedrock: "bedrock",
  Dify: "dify",
  Google: "google",
  Groq: "groq",
  LiteLLM: "litellm",
  Nvidia: "nvidia",
  OpenAI: "openai",
  PLaMo: "plamo",
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
  Thinking: "thinking",
  ToolCalling: "tool_calling",
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
      jsonSchema?: JsonValue;
      type: "json";
    };

export type LlmRequest = {
  history: ConversationHistory;
  maxOutputTokens?: number;
  metadata?: Record<string, JsonValue>;
  model: ModelInfo;
  providerOptions?: Record<string, Record<string, JsonValue>>;
  requiredCapabilities?: readonly LlmCapability[];
  responseFormat?: LlmResponseFormat;
  temperature?: number;
  tools?: readonly LlmToolDefinition[];
};

export type LlmUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type LlmResult = {
  content: string;
  finishReason?: "stop" | "length" | "tool_call" | "content_filter" | "error" | "unknown";
  raw?: unknown;
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
  stream?(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
};
