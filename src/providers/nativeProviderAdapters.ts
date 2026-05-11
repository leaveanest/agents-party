import type {
  LlmAdapter,
  LlmCapability,
  LlmProvider,
  LlmRequest,
  LlmResult,
  LlmStreamEvent,
} from "./contracts.js";

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

export function createNativeProviderAdapters(): UnsupportedNativeProviderAdapter[] {
  return nativeProviderAdapterSpecs.map((spec) => new UnsupportedNativeProviderAdapter(spec));
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
    capabilities: ["file_input", "web_search"],
    provider: "google",
    reason: "Use a future Gemini native adapter for grounding and file APIs.",
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
