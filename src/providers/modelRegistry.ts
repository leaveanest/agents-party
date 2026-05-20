import {
  type LlmCapability,
  type LlmProvider,
  type ModelInfo,
  llmCapabilities,
  llmProviders,
} from "./contracts.js";

export class UnknownModelError extends Error {
  constructor(readonly modelId: string) {
    super(`Unknown LLM model '${modelId}'. Register the model and its capabilities before use.`);
    this.name = "UnknownModelError";
  }
}

export class MissingModelCapabilityError extends Error {
  constructor(
    readonly model: ModelInfo,
    readonly missingCapabilities: readonly LlmCapability[],
  ) {
    super(
      `Model '${model.id}' is missing required capabilities: ${missingCapabilities.join(", ")}.`,
    );
    this.name = "MissingModelCapabilityError";
  }
}

export class DuplicateModelError extends Error {
  constructor(readonly modelId: string) {
    super(`Model '${modelId}' is already registered.`);
    this.name = "DuplicateModelError";
  }
}

export class DuplicateModelAliasError extends Error {
  constructor(
    readonly alias: string,
    readonly existingModelId: string,
  ) {
    super(`Model alias '${alias}' is already registered for '${existingModelId}'.`);
    this.name = "DuplicateModelAliasError";
  }
}

export class ModelAliasCollisionError extends Error {
  constructor(readonly alias: string) {
    super(`Model alias '${alias}' collides with a registered model id.`);
    this.name = "ModelAliasCollisionError";
  }
}

export class InvalidModelInfoError extends Error {
  constructor(
    readonly modelId: string,
    message: string,
  ) {
    super(`Invalid model '${modelId}': ${message}`);
    this.name = "InvalidModelInfoError";
  }
}

export class ModelRegistry {
  private readonly aliases = new Map<string, string>();
  private readonly models = new Map<string, ModelInfo>();

  constructor(models: readonly ModelInfo[] = []) {
    for (const model of models) {
      this.register(model);
    }
  }

  register(model: ModelInfo): void {
    validateModelInfo(model);
    if (this.models.has(model.id)) {
      throw new DuplicateModelError(model.id);
    }
    if (this.aliases.has(model.id)) {
      throw new ModelAliasCollisionError(model.id);
    }
    for (const alias of model.aliases ?? []) {
      const existingModelId = this.aliases.get(alias);
      if (existingModelId !== undefined) {
        throw new DuplicateModelAliasError(alias, existingModelId);
      }
      if (this.models.has(alias)) {
        throw new ModelAliasCollisionError(alias);
      }
    }
    this.models.set(model.id, freezeModel(model));
    for (const alias of model.aliases ?? []) {
      this.aliases.set(alias, model.id);
    }
  }

  get(modelId: string): ModelInfo {
    const model = this.models.get(modelId) ?? this.models.get(this.aliases.get(modelId) ?? "");
    if (model === undefined) {
      throw new UnknownModelError(modelId);
    }
    return model;
  }

  has(modelId: string): boolean {
    return this.models.has(this.aliases.get(modelId) ?? modelId);
  }

  list(provider?: LlmProvider): ModelInfo[] {
    const models = [...this.models.values()];
    if (provider === undefined) {
      return models;
    }
    return models.filter((model) => model.provider === provider);
  }

  assertCapabilities(model: ModelInfo, requiredCapabilities: readonly LlmCapability[]): void {
    const capabilitySet = new Set(model.capabilities);
    const missingCapabilities = requiredCapabilities.filter(
      (capability) => !capabilitySet.has(capability),
    );
    if (missingCapabilities.length > 0) {
      throw new MissingModelCapabilityError(model, missingCapabilities);
    }
  }
}

export function createDefaultModelRegistry(): ModelRegistry {
  return new ModelRegistry(defaultModelRegistryEntries);
}

const textCapabilities = ["text", "streaming"] as const satisfies readonly LlmCapability[];
const structuredTextCapabilities = [
  "text",
  "streaming",
  "tool_calling",
  "structured_output",
] as const satisfies readonly LlmCapability[];
const visionStructuredTextCapabilities = [
  "text",
  "streaming",
  "image_input",
  "tool_calling",
  "structured_output",
] as const satisfies readonly LlmCapability[];
const reasoningTextCapabilities = [
  "text",
  "streaming",
  "tool_calling",
  "structured_output",
  "thinking",
] as const satisfies readonly LlmCapability[];
const webSearchStructuredTextCapabilities = [
  ...structuredTextCapabilities,
  "web_search",
] as const satisfies readonly LlmCapability[];
const webSearchVisionStructuredTextCapabilities = [
  ...visionStructuredTextCapabilities,
  "web_search",
] as const satisfies readonly LlmCapability[];
const webSearchVisionReasoningTextCapabilities = [
  ...reasoningTextCapabilities,
  "image_input",
  "web_search",
] as const satisfies readonly LlmCapability[];
const webSearchReasoningTextCapabilities = [
  ...reasoningTextCapabilities,
  "web_search",
] as const satisfies readonly LlmCapability[];

type TextModelEntry = readonly [
  provider: LlmProvider,
  providerModelId: string,
  displayName: string,
  capabilities?: readonly LlmCapability[],
  aliases?: readonly string[],
];

function textModelEntry(entry: TextModelEntry): ModelInfo {
  const [provider, providerModelId, displayName, capabilities = textCapabilities, aliases] = entry;
  return {
    ...(aliases === undefined ? {} : { aliases }),
    capabilities,
    displayName,
    id: `${provider}:${providerModelId}`,
    provider,
    providerModelId,
  };
}

export const defaultModelRegistryEntries: readonly ModelInfo[] = [
  ...(
    [
      ["openai", "gpt-5.5", "GPT-5.5", webSearchVisionReasoningTextCapabilities],
      ["openai", "gpt-5.4-pro", "GPT-5.4 Pro", webSearchVisionReasoningTextCapabilities],
      ["openai", "gpt-5.4", "GPT-5.4", webSearchVisionReasoningTextCapabilities],
      ["openai", "gpt-5.4-mini", "GPT-5.4 Mini", webSearchVisionReasoningTextCapabilities],
      ["openai", "gpt-5.4-nano", "GPT-5.4 Nano", webSearchVisionReasoningTextCapabilities],
      ["openai", "gpt-5.3-chat-latest", "GPT-5.3 Chat Latest", webSearchStructuredTextCapabilities],
      ["openai", "gpt-5.2-pro", "GPT-5.2 Pro", webSearchVisionReasoningTextCapabilities],
      ["openai", "gpt-5.2-chat-latest", "GPT-5.2 Chat Latest", webSearchStructuredTextCapabilities],
      ["openai", "gpt-5.1", "GPT-5.1", webSearchVisionReasoningTextCapabilities],
      ["openai", "gpt-5.1-chat-latest", "GPT-5.1 Chat Latest", webSearchStructuredTextCapabilities],
      ["openai", "gpt-5", "GPT-5", webSearchVisionReasoningTextCapabilities],
      ["openai", "gpt-5-nano", "GPT-5 Nano", webSearchVisionReasoningTextCapabilities],
      ["openai", "gpt-4.1", "GPT-4.1", webSearchVisionStructuredTextCapabilities],
      ["openai", "gpt-4.1-mini", "GPT-4.1 Mini", webSearchVisionStructuredTextCapabilities],
      ["openai", "gpt-4.1-nano", "GPT-4.1 Nano", webSearchVisionStructuredTextCapabilities],
      ["anthropic", "claude-opus-4-7", "Claude Opus 4.7", webSearchReasoningTextCapabilities],
      ["anthropic", "claude-opus-4-6", "Claude Opus 4.6", webSearchReasoningTextCapabilities],
      ["anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.6", webSearchReasoningTextCapabilities],
      ["anthropic", "claude-opus-4-5", "Claude Opus 4.5", webSearchReasoningTextCapabilities],
      ["anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5", webSearchReasoningTextCapabilities],
      ["anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", webSearchReasoningTextCapabilities],
      [
        "google",
        "gemini-3.1-pro-preview",
        "Gemini 3.1 Pro Preview",
        webSearchReasoningTextCapabilities,
      ],
      [
        "google",
        "gemini-3.1-flash-lite-preview",
        "Gemini 3.1 Flash Lite Preview",
        webSearchReasoningTextCapabilities,
      ],
      ["google", "gemini-2.5-pro", "Gemini 2.5 Pro", webSearchReasoningTextCapabilities],
      [
        "google",
        "gemini-2.5-flash-lite",
        "Gemini 2.5 Flash Lite",
        webSearchReasoningTextCapabilities,
      ],
      [
        "bedrock",
        "anthropic.claude-opus-4-7",
        "Bedrock Claude Opus 4.7",
        reasoningTextCapabilities,
      ],
      [
        "bedrock",
        "anthropic.claude-opus-4-6-v1",
        "Bedrock Claude Opus 4.6",
        reasoningTextCapabilities,
      ],
      [
        "bedrock",
        "anthropic.claude-sonnet-4-6-v1",
        "Bedrock Claude Sonnet 4.6",
        reasoningTextCapabilities,
      ],
      [
        "bedrock",
        "anthropic.claude-sonnet-4-20250514-v1:0",
        "Bedrock Claude Sonnet 4",
        reasoningTextCapabilities,
      ],
      ["bedrock", "openai.gpt-oss-120b-1:0", "Bedrock GPT-OSS 120B", reasoningTextCapabilities],
      ["bedrock", "openai.gpt-oss-20b-1:0", "Bedrock GPT-OSS 20B", reasoningTextCapabilities],
      [
        "bedrock",
        "us.amazon.nova-premier-v1:0",
        "Bedrock Nova Premier",
        structuredTextCapabilities,
      ],
      ["bedrock", "us.amazon.nova-pro-v1:0", "Bedrock Nova Pro", structuredTextCapabilities],
      [
        "bedrock",
        "us.meta.llama4-maverick-17b-instruct-v1:0",
        "Bedrock Llama 4 Maverick",
        visionStructuredTextCapabilities,
      ],
      [
        "groq",
        "meta-llama/llama-4-maverick-17b-128e-instruct",
        "Groq Llama 4 Maverick",
        visionStructuredTextCapabilities,
      ],
      [
        "groq",
        "meta-llama/llama-4-scout-17b-16e-instruct",
        "Groq Llama 4 Scout",
        visionStructuredTextCapabilities,
      ],
      ["groq", "openai/gpt-oss-20b", "Groq GPT-OSS 20B", reasoningTextCapabilities],
      [
        "groq",
        "moonshotai/kimi-k2-instruct-0905",
        "Groq Kimi K2 Instruct",
        structuredTextCapabilities,
      ],
      ["groq", "qwen/qwen3-32b", "Groq Qwen3 32B", reasoningTextCapabilities],
      ["xai", "grok-4-1-fast-reasoning", "Grok 4.1 Fast Reasoning", reasoningTextCapabilities],
      ["xai", "grok-4-1-fast-non-reasoning", "Grok 4.1 Fast", structuredTextCapabilities],
      ["xai", "grok-4-latest", "Grok 4 Latest", structuredTextCapabilities],
      ["xai", "grok-3-latest", "Grok 3 Latest", structuredTextCapabilities],
      ["xai", "grok-3-mini-latest", "Grok 3 Mini Latest", reasoningTextCapabilities],
      ["mistral", "mistral-large-latest", "Mistral Large Latest", structuredTextCapabilities],
      ["mistral", "mistral-medium-latest", "Mistral Medium Latest", structuredTextCapabilities],
      ["mistral", "mistral-small-latest", "Mistral Small Latest", structuredTextCapabilities],
      ["mistral", "pixtral-large-latest", "Pixtral Large Latest", visionStructuredTextCapabilities],
      ["mistral", "magistral-medium-latest", "Magistral Medium Latest", reasoningTextCapabilities],
      ["mistral", "ministral-14b-latest", "Ministral 14B Latest", structuredTextCapabilities],
      ["togetherai", "deepseek-ai/DeepSeek-V3", "Together DeepSeek V3", structuredTextCapabilities],
      ["togetherai", "deepseek-ai/DeepSeek-R1", "Together DeepSeek R1", reasoningTextCapabilities],
      [
        "togetherai",
        "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        "Together Llama 3.3 70B Turbo",
        structuredTextCapabilities,
      ],
      [
        "togetherai",
        "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo",
        "Together Llama 3.1 405B Turbo",
        structuredTextCapabilities,
      ],
      [
        "cohere",
        "command-a-reasoning-08-2025",
        "Cohere Command A Reasoning",
        reasoningTextCapabilities,
      ],
      ["cohere", "command-a-03-2025", "Cohere Command A", structuredTextCapabilities],
      ["cohere", "command-r-plus", "Cohere Command R+", structuredTextCapabilities],
      ["cohere", "command-r-08-2024", "Cohere Command R", structuredTextCapabilities],
      [
        "fireworks",
        "accounts/fireworks/models/kimi-k2p5",
        "Fireworks Kimi K2.5",
        reasoningTextCapabilities,
      ],
      [
        "fireworks",
        "accounts/fireworks/models/kimi-k2-thinking",
        "Fireworks Kimi K2 Thinking",
        reasoningTextCapabilities,
      ],
      [
        "fireworks",
        "accounts/fireworks/models/deepseek-v3",
        "Fireworks DeepSeek V3",
        structuredTextCapabilities,
      ],
      [
        "fireworks",
        "accounts/fireworks/models/llama-v3p3-70b-instruct",
        "Fireworks Llama 3.3 70B",
        structuredTextCapabilities,
      ],
      [
        "deepinfra",
        "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
        "DeepInfra Llama 4 Maverick",
        visionStructuredTextCapabilities,
      ],
      [
        "deepinfra",
        "meta-llama/Llama-4-Scout-17B-16E-Instruct",
        "DeepInfra Llama 4 Scout",
        visionStructuredTextCapabilities,
      ],
      ["deepinfra", "deepseek-ai/DeepSeek-V3", "DeepInfra DeepSeek V3", structuredTextCapabilities],
      [
        "deepinfra",
        "meta-llama/Llama-3.3-70B-Instruct",
        "DeepInfra Llama 3.3 70B",
        structuredTextCapabilities,
      ],
      ["deepseek", "deepseek-chat", "DeepSeek Chat", structuredTextCapabilities],
      ["deepseek", "deepseek-reasoner", "DeepSeek Reasoner", reasoningTextCapabilities],
      ["cerebras", "zai-glm-4.7", "Cerebras Z.AI GLM 4.7", structuredTextCapabilities],
      ["cerebras", "zai-glm-4.6", "Cerebras Z.AI GLM 4.6", structuredTextCapabilities],
      [
        "cerebras",
        "qwen-3-235b-a22b-thinking-2507",
        "Cerebras Qwen3 235B Thinking",
        reasoningTextCapabilities,
      ],
      ["cerebras", "gpt-oss-120b", "Cerebras GPT-OSS 120B", reasoningTextCapabilities],
      [
        "perplexity",
        "sonar-deep-research",
        "Perplexity Sonar Deep Research",
        webSearchReasoningTextCapabilities,
      ],
      [
        "perplexity",
        "sonar-reasoning-pro",
        "Perplexity Sonar Reasoning Pro",
        webSearchReasoningTextCapabilities,
      ],
      ["perplexity", "sonar-pro", "Perplexity Sonar Pro", webSearchStructuredTextCapabilities],
      ["perplexity", "sonar", "Perplexity Sonar", webSearchStructuredTextCapabilities],
      [
        "baseten",
        "moonshotai/Kimi-K2-Instruct-0905",
        "Baseten Kimi K2 Instruct",
        structuredTextCapabilities,
      ],
      ["baseten", "openai/gpt-oss-120b", "Baseten GPT-OSS 120B", reasoningTextCapabilities],
      ["baseten", "deepseek-ai/DeepSeek-V3.1", "Baseten DeepSeek V3.1", structuredTextCapabilities],
      [
        "baseten",
        "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        "Baseten Qwen3 Coder 480B",
        structuredTextCapabilities,
      ],
    ] as const satisfies readonly TextModelEntry[]
  ).map(textModelEntry),
  {
    aliases: ["gpt-5.2"],
    capabilities: [
      "text",
      "streaming",
      "image_input",
      "file_input",
      "tool_calling",
      "structured_output",
      "web_search",
      "thinking",
    ],
    displayName: "GPT-5.2",
    id: "openai:gpt-5.2",
    provider: "openai",
    providerModelId: "gpt-5.2",
  },
  {
    aliases: ["gpt-5-mini"],
    capabilities: [
      "text",
      "streaming",
      "image_input",
      "file_input",
      "tool_calling",
      "structured_output",
      "thinking",
    ],
    displayName: "GPT-5 mini",
    id: "openai:gpt-5-mini",
    provider: "openai",
    providerModelId: "gpt-5-mini",
  },
  {
    aliases: ["gpt-4o"],
    capabilities: [
      "text",
      "streaming",
      "image_input",
      "file_input",
      "tool_calling",
      "structured_output",
      "web_search",
    ],
    displayName: "GPT-4o",
    id: "openai:gpt-4o",
    provider: "openai",
    providerModelId: "gpt-4o",
  },
  {
    aliases: ["gpt-image-2"],
    capabilities: ["image_generation"],
    displayName: "GPT Image 2",
    id: "openai:gpt-image-2",
    provider: "openai",
    providerModelId: "gpt-image-2",
  },
  {
    aliases: ["gpt-image-1.5"],
    capabilities: ["image_generation"],
    displayName: "GPT Image 1.5",
    id: "openai:gpt-image-1.5",
    provider: "openai",
    providerModelId: "gpt-image-1.5",
  },
  {
    aliases: ["gpt-image-1-mini"],
    capabilities: ["image_generation"],
    displayName: "GPT Image 1 Mini",
    id: "openai:gpt-image-1-mini",
    provider: "openai",
    providerModelId: "gpt-image-1-mini",
  },
  {
    aliases: ["gpt-image-1"],
    capabilities: ["image_generation"],
    displayName: "GPT Image 1",
    id: "openai:gpt-image-1",
    provider: "openai",
    providerModelId: "gpt-image-1",
  },
  {
    aliases: ["openai.gpt-4o-mini-transcribe"],
    capabilities: ["transcription"],
    displayName: "OpenAI GPT-4o Mini Transcribe",
    id: "openai:gpt-4o-mini-transcribe",
    provider: "openai",
    providerModelId: "gpt-4o-mini-transcribe",
  },
  {
    aliases: ["azure.whisper-1"],
    capabilities: ["transcription"],
    displayName: "Azure OpenAI Whisper deployment",
    id: "azure_openai:whisper-1",
    provider: "azure_openai",
    providerModelId: "whisper-1",
  },
  {
    aliases: ["claude-opus-4-1-20250805"],
    capabilities: [
      "text",
      "streaming",
      "image_input",
      "file_input",
      "tool_calling",
      "structured_output",
      "web_search",
      "thinking",
    ],
    displayName: "Claude Opus 4.1",
    id: "anthropic:claude-opus-4-1-20250805",
    provider: "anthropic",
    providerModelId: "claude-opus-4-1-20250805",
  },
  {
    aliases: ["claude-sonnet-4-20250514"],
    capabilities: [
      "text",
      "streaming",
      "image_input",
      "file_input",
      "tool_calling",
      "structured_output",
      "web_search",
      "thinking",
    ],
    displayName: "Claude Sonnet 4",
    id: "anthropic:claude-sonnet-4-20250514",
    provider: "anthropic",
    providerModelId: "claude-sonnet-4-20250514",
  },
  {
    aliases: ["gemini-3-pro-preview"],
    capabilities: [
      "text",
      "streaming",
      "image_input",
      "file_input",
      "audio_input",
      "tool_calling",
      "structured_output",
      "web_search",
      "thinking",
    ],
    displayName: "Gemini 3 Pro Preview",
    id: "google:gemini-3-pro-preview",
    provider: "google",
    providerModelId: "gemini-3-pro-preview",
  },
  {
    aliases: ["gemini-3-flash-preview"],
    capabilities: [
      "text",
      "streaming",
      "image_input",
      "file_input",
      "audio_input",
      "tool_calling",
      "structured_output",
      "web_search",
      "thinking",
    ],
    displayName: "Gemini 3 Flash Preview",
    id: "google:gemini-3-flash-preview",
    provider: "google",
    providerModelId: "gemini-3-flash-preview",
  },
  {
    aliases: ["gemini-2.5-flash"],
    capabilities: [
      "text",
      "streaming",
      "image_input",
      "file_input",
      "audio_input",
      "tool_calling",
      "structured_output",
      "web_search",
      "thinking",
    ],
    displayName: "Gemini 2.5 Flash",
    id: "google:gemini-2.5-flash",
    provider: "google",
    providerModelId: "gemini-2.5-flash",
  },
  {
    aliases: ["gemini-2.5-flash-image"],
    capabilities: ["image_generation"],
    displayName: "Gemini 2.5 Flash Image",
    id: "google:gemini-2.5-flash-image",
    provider: "google",
    providerModelId: "gemini-2.5-flash-image",
  },
  {
    aliases: ["google.speech-to-text"],
    capabilities: ["transcription"],
    displayName: "Google Cloud Speech-to-Text latest long",
    id: "google:speech-to-text-latest-long",
    provider: "google",
    providerModelId: "latest_long",
  },
  {
    aliases: ["veo-3.1-fast-generate-001"],
    capabilities: ["video_generation"],
    displayName: "Veo 3.1 Fast",
    id: "google:veo-3.1-fast-generate-001",
    provider: "google",
    providerModelId: "veo-3.1-fast-generate-001",
  },
  {
    aliases: ["groq.openai/gpt-oss-120b"],
    capabilities: ["text", "streaming", "tool_calling", "structured_output", "thinking"],
    displayName: "Groq GPT-OSS 120B",
    id: "groq:openai/gpt-oss-120b",
    provider: "groq",
    providerModelId: "openai/gpt-oss-120b",
  },
  {
    aliases: ["llama-3.3-70b-versatile"],
    capabilities: ["text", "streaming", "tool_calling", "structured_output"],
    displayName: "Groq Llama 3.3 70B Versatile",
    id: "groq:llama-3.3-70b-versatile",
    provider: "groq",
    providerModelId: "llama-3.3-70b-versatile",
  },
  {
    aliases: ["groq.whisper-large-v3"],
    capabilities: ["transcription"],
    displayName: "Groq Whisper Large v3",
    id: "groq:whisper-large-v3",
    provider: "groq",
    providerModelId: "whisper-large-v3",
  },
  {
    aliases: ["nvidia.nemotron-3-super-120b-a12b"],
    capabilities: ["text", "streaming", "tool_calling", "structured_output"],
    displayName: "NVIDIA Nemotron 3 Super 120B",
    id: "nvidia:nvidia/nemotron-3-super-120b-a12b",
    provider: "nvidia",
    providerModelId: "nvidia/nemotron-3-super-120b-a12b",
  },
  {
    aliases: ["grok-4.3", "grok-4.3-latest"],
    capabilities: ["text", "streaming", "tool_calling", "structured_output", "thinking"],
    displayName: "Grok 4.3",
    id: "xai:grok-4.3",
    provider: "xai",
    providerModelId: "grok-4.3",
  },
];

function freezeModel(model: ModelInfo): ModelInfo {
  return {
    ...model,
    aliases: Object.freeze([...(model.aliases ?? [])]),
    capabilities: Object.freeze([...model.capabilities]),
  };
}

function validateModelInfo(model: ModelInfo): void {
  if (!llmProviders.includes(model.provider)) {
    throw new InvalidModelInfoError(model.id, `unknown provider '${model.provider}'.`);
  }
  for (const capability of model.capabilities) {
    if (!llmCapabilities.includes(capability)) {
      throw new InvalidModelInfoError(model.id, `unknown capability '${capability}'.`);
    }
  }
}
