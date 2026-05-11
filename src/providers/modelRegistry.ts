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

export const defaultModelRegistryEntries: readonly ModelInfo[] = [
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
      "image_generation",
    ],
    displayName: "GPT-4o",
    id: "openai:gpt-4o",
    provider: "openai",
    providerModelId: "gpt-4o",
  },
  {
    aliases: ["azure.gpt-4o"],
    capabilities: ["text", "streaming", "image_input", "tool_calling", "structured_output"],
    displayName: "Azure OpenAI GPT-4o deployment",
    id: "azure_openai:gpt-4o",
    provider: "azure_openai",
    providerModelId: "gpt-4o",
  },
  {
    aliases: ["claude-3-5-sonnet-latest"],
    capabilities: [
      "text",
      "streaming",
      "image_input",
      "file_input",
      "tool_calling",
      "structured_output",
      "web_search",
    ],
    displayName: "Claude 3.5 Sonnet",
    id: "anthropic:claude-3-5-sonnet-latest",
    provider: "anthropic",
    providerModelId: "claude-3-5-sonnet-latest",
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
    aliases: ["anthropic.claude-3-5-sonnet-20240620"],
    capabilities: ["text", "streaming", "image_input", "tool_calling", "thinking"],
    displayName: "Bedrock Claude 3.5 Sonnet",
    id: "bedrock:anthropic.claude-3-5-sonnet-20240620",
    provider: "bedrock",
    providerModelId: "anthropic.claude-3-5-sonnet-20240620",
  },
  {
    aliases: ["groq.llama-3.1-70b-versatile"],
    capabilities: ["text", "streaming", "tool_calling"],
    displayName: "Groq Llama 3.1 70B Versatile",
    id: "groq:llama-3.1-70b-versatile",
    provider: "groq",
    providerModelId: "llama-3.1-70b-versatile",
  },
  {
    aliases: ["nvidia.meta/llama-3.1-70b-instruct"],
    capabilities: ["text", "streaming"],
    displayName: "NVIDIA Llama 3.1 70B Instruct",
    id: "nvidia:meta/llama-3.1-70b-instruct",
    provider: "nvidia",
    providerModelId: "meta/llama-3.1-70b-instruct",
  },
  {
    aliases: ["plamo-beta"],
    capabilities: ["text", "streaming"],
    displayName: "PLaMo Beta",
    id: "plamo:plamo-beta",
    provider: "plamo",
    providerModelId: "plamo-beta",
  },
  {
    aliases: ["grok-2-latest"],
    capabilities: ["text", "streaming", "tool_calling"],
    displayName: "Grok 2",
    id: "xai:grok-2-latest",
    provider: "xai",
    providerModelId: "grok-2-latest",
  },
  {
    aliases: ["dify.chatflow"],
    capabilities: ["text", "streaming"],
    displayName: "Dify Chatflow",
    id: "dify:chatflow",
    provider: "dify",
    providerModelId: "chatflow",
  },
  {
    aliases: ["litellm.proxy"],
    capabilities: [
      "text",
      "streaming",
      "image_input",
      "file_input",
      "audio_input",
      "tool_calling",
      "structured_output",
      "web_search",
      "image_generation",
      "thinking",
      "embeddings",
    ],
    displayName: "LiteLLM proxy",
    id: "litellm:proxy",
    provider: "litellm",
    providerModelId: "proxy",
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
