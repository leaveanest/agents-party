import type { JsonValue } from "../domain/messageHistory.js";
import {
  LlmCapabilityId,
  LlmProviderId,
  LlmReasoningEffortId,
  type LlmReasoningEffort,
  type ModelInfo,
} from "./contracts.js";

type ProviderOptions = Record<string, Record<string, JsonValue>>;

const OPENAI_REASONING_EFFORTS = new Set<LlmReasoningEffort>([
  LlmReasoningEffortId.None,
  LlmReasoningEffortId.Minimal,
  LlmReasoningEffortId.Low,
  LlmReasoningEffortId.Medium,
  LlmReasoningEffortId.High,
  LlmReasoningEffortId.XHigh,
]);

const GROQ_REASONING_EFFORTS = new Set<LlmReasoningEffort>([
  LlmReasoningEffortId.None,
  LlmReasoningEffortId.Low,
  LlmReasoningEffortId.Medium,
  LlmReasoningEffortId.High,
]);

const DEEPSEEK_REASONING_EFFORTS = new Set<LlmReasoningEffort>([
  LlmReasoningEffortId.Low,
  LlmReasoningEffortId.Medium,
  LlmReasoningEffortId.High,
  LlmReasoningEffortId.XHigh,
]);

const THINKING_LEVEL_EFFORTS = new Set<LlmReasoningEffort>([
  LlmReasoningEffortId.Minimal,
  LlmReasoningEffortId.Low,
  LlmReasoningEffortId.Medium,
  LlmReasoningEffortId.High,
]);

const BEDROCK_REASONING_EFFORTS = new Set<LlmReasoningEffort>([
  LlmReasoningEffortId.Low,
  LlmReasoningEffortId.Medium,
  LlmReasoningEffortId.High,
  LlmReasoningEffortId.XHigh,
]);

const MISTRAL_REASONING_EFFORTS = new Set<LlmReasoningEffort>([
  LlmReasoningEffortId.None,
  LlmReasoningEffortId.High,
]);

const XAI_REASONING_EFFORTS = new Set<LlmReasoningEffort>([
  LlmReasoningEffortId.Low,
  LlmReasoningEffortId.High,
]);

export function modelDefaultReasoningEffort(model: ModelInfo): LlmReasoningEffort | undefined {
  return model.capabilities.includes(LlmCapabilityId.Thinking)
    ? LlmReasoningEffortId.ProviderDefault
    : undefined;
}

export function normalizeReasoningEffort(value: unknown): LlmReasoningEffort | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return isLlmReasoningEffort(trimmed) ? trimmed : undefined;
}

export function mergeReasoningProviderOptions(input: {
  model: ModelInfo;
  providerOptions?: ProviderOptions;
  reasoningEffort?: LlmReasoningEffort;
}): ProviderOptions | undefined {
  const effort = supportedReasoningEffort(input.model, input.reasoningEffort);
  if (effort === undefined) {
    return input.providerOptions;
  }
  const providerOptions = { ...input.providerOptions };
  const provider = input.model.provider;
  const providerOptionsKey = providerOptionsKeyForReasoning(provider);
  const currentOptions = { ...providerOptions[providerOptionsKey] };
  const nextOptions = reasoningOptionsForProvider(provider, effort, currentOptions);
  if (nextOptions === undefined) {
    return input.providerOptions;
  }
  providerOptions[providerOptionsKey] = nextOptions;
  return providerOptions;
}

function supportedReasoningEffort(
  model: ModelInfo,
  effort: LlmReasoningEffort | undefined,
): LlmReasoningEffort | undefined {
  if (
    effort === undefined ||
    effort === LlmReasoningEffortId.ProviderDefault ||
    !model.capabilities.includes(LlmCapabilityId.Thinking)
  ) {
    return undefined;
  }
  return isModelReasoningEffortSupported(model, effort) ? effort : undefined;
}

function isProviderReasoningEffortSupported(
  provider: ModelInfo["provider"],
  effort: LlmReasoningEffort,
): boolean {
  switch (provider) {
    case LlmProviderId.OpenAI:
    case LlmProviderId.AzureOpenAI:
      return OPENAI_REASONING_EFFORTS.has(effort);
    case LlmProviderId.Groq:
      return GROQ_REASONING_EFFORTS.has(effort);
    case LlmProviderId.DeepSeek:
      return DEEPSEEK_REASONING_EFFORTS.has(effort);
    case LlmProviderId.Google:
      return THINKING_LEVEL_EFFORTS.has(effort);
    case LlmProviderId.Bedrock:
    case LlmProviderId.Anthropic:
      return BEDROCK_REASONING_EFFORTS.has(effort);
    case LlmProviderId.Mistral:
      return MISTRAL_REASONING_EFFORTS.has(effort);
    case LlmProviderId.XAI:
      return XAI_REASONING_EFFORTS.has(effort);
    default:
      return false;
  }
}

function isModelReasoningEffortSupported(model: ModelInfo, effort: LlmReasoningEffort): boolean {
  if (!isProviderReasoningEffortSupported(model.provider, effort)) {
    return false;
  }
  if (model.provider === LlmProviderId.OpenAI || model.provider === LlmProviderId.AzureOpenAI) {
    if (effort === LlmReasoningEffortId.None) {
      return model.providerModelId.startsWith("gpt-5.1");
    }
    if (effort === LlmReasoningEffortId.XHigh) {
      return model.providerModelId.startsWith("gpt-5.1-codex-max");
    }
  }
  if (model.provider === LlmProviderId.Google) {
    if (model.providerModelId.startsWith("gemini-3.1-pro")) {
      return effort === LlmReasoningEffortId.Low || effort === LlmReasoningEffortId.High;
    }
    if (model.providerModelId.startsWith("gemini-3-pro")) {
      return effort === LlmReasoningEffortId.Low || effort === LlmReasoningEffortId.High;
    }
    return (
      model.providerModelId.startsWith("gemini-3-flash") ||
      model.providerModelId.startsWith("gemini-3.1-flash")
    );
  }
  return true;
}

function reasoningOptionsForProvider(
  provider: ModelInfo["provider"],
  effort: LlmReasoningEffort,
  currentOptions: Record<string, JsonValue>,
): Record<string, JsonValue> | undefined {
  switch (provider) {
    case LlmProviderId.OpenAI:
    case LlmProviderId.AzureOpenAI:
    case LlmProviderId.Groq:
    case LlmProviderId.DeepSeek:
    case LlmProviderId.Mistral:
    case LlmProviderId.XAI:
      return currentOptions.reasoningEffort === undefined
        ? { ...currentOptions, reasoningEffort: effort }
        : currentOptions;
    case LlmProviderId.Google:
      return currentOptions.thinkingConfig === undefined
        ? { ...currentOptions, thinkingConfig: { thinkingLevel: effort } }
        : currentOptions;
    case LlmProviderId.Bedrock:
      return currentOptions.reasoningConfig === undefined
        ? { ...currentOptions, reasoningConfig: { maxReasoningEffort: effort } }
        : currentOptions;
    case LlmProviderId.Anthropic:
      return currentOptions.effort === undefined ? { ...currentOptions, effort } : currentOptions;
    default:
      return undefined;
  }
}

function providerOptionsKeyForReasoning(provider: ModelInfo["provider"]): string {
  return provider === LlmProviderId.AzureOpenAI ? LlmProviderId.OpenAI : provider;
}

function isLlmReasoningEffort(value: string): value is LlmReasoningEffort {
  return Object.values(LlmReasoningEffortId).some((effort) => effort === value);
}
