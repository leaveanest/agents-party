import type {
  LlmAdapter,
  LlmCapability,
  LlmRequest,
  LlmStreamEvent,
  ModelInfo,
} from "./contracts.js";
import { ModelRegistry, createDefaultModelRegistry } from "./modelRegistry.js";

export type ModelSelectionConfig = {
  channelModelId?: string | null;
  threadModelId?: string | null;
  workspaceModelId?: string | null;
};

export type ResolvedModelSelection = {
  model: ModelInfo;
  source: "thread" | "channel" | "workspace";
};

export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelResolutionError";
  }
}

export class MissingProviderAdapterError extends Error {
  constructor(readonly provider: string) {
    super(`No LLM adapter registered for provider '${provider}'.`);
    this.name = "MissingProviderAdapterError";
  }
}

export class ProviderRouter {
  private readonly adapters = new Map<string, LlmAdapter>();

  constructor(
    adapters: readonly LlmAdapter[] = [],
    readonly registry: ModelRegistry = createDefaultModelRegistry(),
  ) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.provider, adapter);
    }
  }

  registerAdapter(adapter: LlmAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  resolveModel(
    config: ModelSelectionConfig,
    requiredCapabilities: readonly LlmCapability[] = [],
  ): ResolvedModelSelection {
    const candidate = firstConfiguredModel(config);
    if (candidate === undefined) {
      throw new ModelResolutionError(
        "No LLM model configured. Set a thread, channel, or workspace model before routing.",
      );
    }

    const model = this.registry.get(candidate.modelId);
    this.registry.assertCapabilities(model, requiredCapabilities);
    return {
      model,
      source: candidate.source,
    };
  }

  async generate(request: LlmRequest) {
    const canonicalRequest = this.canonicalRequest(request);
    const requiredCapabilities = requiredCapabilitiesForRequest(request);
    this.registry.assertCapabilities(canonicalRequest.model, requiredCapabilities);
    return this.adapterFor(canonicalRequest).generate(canonicalRequest);
  }

  stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const canonicalRequest = this.canonicalRequest(request);
    const requiredCapabilities = [...requiredCapabilitiesForRequest(request), "streaming"] as const;
    this.registry.assertCapabilities(canonicalRequest.model, requiredCapabilities);
    const adapter = this.adapterFor(canonicalRequest);
    if (adapter.stream === undefined) {
      throw new MissingProviderAdapterError(`${canonicalRequest.model.provider} streaming`);
    }
    return adapter.stream(canonicalRequest);
  }

  private adapterFor(request: LlmRequest): LlmAdapter {
    const adapter = this.adapters.get(request.model.provider);
    if (adapter === undefined) {
      throw new MissingProviderAdapterError(request.model.provider);
    }
    return adapter;
  }

  private canonicalRequest(request: LlmRequest): LlmRequest {
    return {
      ...request,
      model: this.registry.get(request.model.id),
    };
  }
}

function firstConfiguredModel(config: ModelSelectionConfig) {
  if (config.threadModelId != null && config.threadModelId.trim().length > 0) {
    return {
      modelId: config.threadModelId,
      source: "thread" as const,
    };
  }
  if (config.channelModelId != null && config.channelModelId.trim().length > 0) {
    return {
      modelId: config.channelModelId,
      source: "channel" as const,
    };
  }
  if (config.workspaceModelId != null && config.workspaceModelId.trim().length > 0) {
    return {
      modelId: config.workspaceModelId,
      source: "workspace" as const,
    };
  }
  return undefined;
}

function requiredCapabilitiesForRequest(request: LlmRequest): readonly LlmCapability[] {
  const capabilities = new Set<LlmCapability>(["text", ...(request.requiredCapabilities ?? [])]);
  if ((request.tools?.length ?? 0) > 0) {
    capabilities.add("tool_calling");
  }
  if (request.responseFormat?.type === "json") {
    capabilities.add("structured_output");
  }
  for (const message of request.history.messages) {
    if (message.role !== "user") {
      continue;
    }
    for (const part of message.content) {
      switch (part.type) {
        case "image":
          capabilities.add("image_input");
          break;
        case "file":
          capabilities.add("file_input");
          break;
        case "audio":
          capabilities.add("audio_input");
          break;
        case "text":
          break;
      }
    }
  }
  return [...capabilities];
}
