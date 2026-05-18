import { anthropic, createAnthropic, type AnthropicProviderSettings } from "@ai-sdk/anthropic";
import {
  bedrock,
  createAmazonBedrock,
  type AmazonBedrockProviderSettings,
} from "@ai-sdk/amazon-bedrock";
import { azure, createAzure, type AzureOpenAIProviderSettings } from "@ai-sdk/azure";
import { baseten, createBaseten, type BasetenProviderSettings } from "@ai-sdk/baseten";
import { cerebras, createCerebras, type CerebrasProviderSettings } from "@ai-sdk/cerebras";
import { cohere, createCohere, type CohereProviderSettings } from "@ai-sdk/cohere";
import { deepinfra, createDeepInfra, type DeepInfraProviderSettings } from "@ai-sdk/deepinfra";
import { deepseek, createDeepSeek, type DeepSeekProviderSettings } from "@ai-sdk/deepseek";
import { fireworks, createFireworks, type FireworksProviderSettings } from "@ai-sdk/fireworks";
import {
  createGoogleGenerativeAI,
  google,
  type GoogleGenerativeAIProviderSettings,
} from "@ai-sdk/google";
import { createVertex, type GoogleVertexProviderSettings } from "@ai-sdk/google-vertex";
import { createGroq, groq, type GroqProviderSettings } from "@ai-sdk/groq";
import { createMistral, mistral, type MistralProviderSettings } from "@ai-sdk/mistral";
import { createOpenAI, openai, type OpenAIProviderSettings } from "@ai-sdk/openai";
import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from "@ai-sdk/openai-compatible";
import { createPerplexity, perplexity, type PerplexityProviderSettings } from "@ai-sdk/perplexity";
import { createTogetherAI, togetherai, type TogetherAIProviderSettings } from "@ai-sdk/togetherai";
import { createXai, xai, type XaiProviderSettings } from "@ai-sdk/xai";
import {
  generateText,
  jsonSchema,
  stepCountIs,
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
import {
  MissingWorkspaceContextError,
  MissingWorkspaceCredentialError,
  type ProviderCredential,
  type ProviderCredentialResolver,
  stringPayloadField,
} from "./credentials.js";

export type AiSdkModelResolver = (
  model: ModelInfo,
  credential?: ProviderCredential,
) => LanguageModel;

export type AiSdkProviderToolResolver = (
  model: ModelInfo,
  credential?: ProviderCredential,
) => ToolSet | undefined;

export type AiSdkAdapterSettings = {
  anthropic?: AnthropicProviderSettings;
  baseten?: BasetenProviderSettings;
  bedrock?: AmazonBedrockProviderSettings;
  cerebras?: CerebrasProviderSettings;
  cohere?: CohereProviderSettings;
  deepinfra?: DeepInfraProviderSettings;
  deepseek?: DeepSeekProviderSettings;
  azureOpenAI?: AzureOpenAIProviderSettings;
  fireworks?: FireworksProviderSettings;
  google?: GoogleGenerativeAIProviderSettings;
  googleVertex?: GoogleVertexProviderSettings;
  groq?: GroqProviderSettings;
  mistral?: MistralProviderSettings;
  openAI?: OpenAIProviderSettings;
  openAICompatible?: Partial<Record<OpenAICompatibleProvider, OpenAICompatibleProviderConfig>>;
  perplexity?: PerplexityProviderSettings;
  togetherai?: TogetherAIProviderSettings;
  xai?: XaiProviderSettings;
};

export type AiSdkAdapterOptions = {
  credentialResolver?: ProviderCredentialResolver;
};

export type OpenAICompatibleProvider = "litellm" | "nvidia" | "plamo";

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
  private readonly credentialResolver?: ProviderCredentialResolver;
  private readonly resolveProviderTools: AiSdkProviderToolResolver;

  constructor(
    readonly provider: LlmProvider,
    private readonly resolveModel: AiSdkModelResolver,
    resolveProviderToolsOrCredentialResolver:
      | AiSdkProviderToolResolver
      | ProviderCredentialResolver
      | undefined = createAiSdkProviderToolResolver(),
    credentialResolver?: ProviderCredentialResolver,
  ) {
    if (typeof resolveProviderToolsOrCredentialResolver === "function") {
      this.resolveProviderTools = resolveProviderToolsOrCredentialResolver;
      this.credentialResolver = credentialResolver;
      return;
    }
    this.resolveProviderTools = createAiSdkProviderToolResolver();
    this.credentialResolver = resolveProviderToolsOrCredentialResolver;
  }

  async generate(request: LlmRequest): Promise<LlmResult> {
    try {
      assertSupportedResponseFormat(request);
      const credential = await this.resolveCredential(request);
      const providerTools = this.resolveProviderTools(request.model, credential);
      const providerToolNames = providerToolNamesForRequest(request, providerTools);
      const tools = toolsForRequest(request, providerTools);
      const result = await generateText({
        maxOutputTokens: request.maxOutputTokens,
        messages: convertHistoryToAiSdkMessages(
          request.history,
          aiSdkMessageConversionCapabilitiesForModel(request.model),
        ),
        model: this.resolveModel(request.model, credential),
        providerOptions: request.providerOptions,
        stopWhen: providerTools === undefined ? undefined : stepCountIs(10),
        system: request.system,
        temperature: request.temperature,
        tools,
      });

      return {
        content: result.text,
        finishReason: mapFinishReason(result.finishReason),
        raw: result,
        sources: mapSources(result.sources),
        toolCalls: result.toolCalls
          .filter((toolCall) => !isProviderToolCall(toolCall, providerToolNames))
          .map(mapToolCall),
        usage: mapUsage(result.usage),
      };
    } catch (error) {
      if (
        error instanceof MissingWorkspaceCredentialError ||
        error instanceof MissingWorkspaceContextError
      ) {
        throw error;
      }
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
      const credential = await this.resolveCredential(request);
      const providerTools = this.resolveProviderTools(request.model, credential);
      const providerToolNames = providerToolNamesForRequest(request, providerTools);
      const tools = toolsForRequest(request, providerTools);
      const result = streamText({
        maxOutputTokens: request.maxOutputTokens,
        messages: convertHistoryToAiSdkMessages(
          request.history,
          aiSdkMessageConversionCapabilitiesForModel(request.model),
        ),
        model: this.resolveModel(request.model, credential),
        providerOptions: request.providerOptions,
        stopWhen: providerTools === undefined ? undefined : stepCountIs(10),
        system: request.system,
        temperature: request.temperature,
        tools,
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
            if (isProviderToolCall(part, providerToolNames)) {
              break;
            }
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
        error:
          error instanceof MissingWorkspaceCredentialError ||
          error instanceof MissingWorkspaceContextError
            ? error
            : normalizeProviderError(request.model, error),
        type: "error",
      };
    }
  }

  private async resolveCredential(request: LlmRequest): Promise<ProviderCredential | undefined> {
    if (this.credentialResolver === undefined) {
      return undefined;
    }
    if (request.context?.workspaceId === undefined) {
      throw new MissingWorkspaceContextError(request.model.provider);
    }

    if (request.model.provider === "google") {
      const serviceAccountCredential = await this.credentialResolver.resolveProviderCredential({
        credentialName: "service_account_json",
        provider: "google",
        workspaceId: request.context.workspaceId,
      });
      if (serviceAccountCredential !== undefined) {
        return { ...serviceAccountCredential, credentialName: "service_account_json" };
      }
    }

    const credential = await this.credentialResolver.resolveProviderCredential({
      credentialName: "api_key",
      provider: request.model.provider,
      workspaceId: request.context.workspaceId,
    });
    if (credential === undefined) {
      throw new MissingWorkspaceCredentialError(
        request.context.workspaceId,
        request.model.provider,
      );
    }
    return { ...credential, credentialName: "api_key" };
  }
}

const nativeOnlyCapabilities = new Set<LlmCapability>([
  "embeddings",
  "image_generation",
  "thinking",
]);

const googleNativeOnlyCapabilities = new Set<LlmCapability>(["file_input"]);

const OPENAI_COMPATIBLE_DEFAULT_BASE_URLS = {
  litellm: "http://localhost:4000/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  plamo: "https://api.platform.preferredai.jp/v1",
} as const satisfies Record<OpenAICompatibleProvider, string>;

function assertSupportedResponseFormat(request: LlmRequest): void {
  if (request.responseFormat !== undefined && request.responseFormat.type !== "text") {
    throw new LlmProviderError(
      request.model.provider,
      request.model.id,
      "AI SDK common adapter currently supports text response format only.",
    );
  }
}

export function createAiSdkAdapters(
  settings: AiSdkAdapterSettings = {},
  options: AiSdkAdapterOptions = {},
): AiSdkLlmAdapter[] {
  const resolveModel = createAiSdkModelResolver(settings);
  const resolveProviderTools = createAiSdkProviderToolResolver(settings);
  const commonLaneProviders = [
    "openai",
    "azure_openai",
    "anthropic",
    "google",
    "bedrock",
    "groq",
    "xai",
    "mistral",
    "togetherai",
    "cohere",
    "fireworks",
    "deepinfra",
    "deepseek",
    "cerebras",
    "perplexity",
    "baseten",
    "plamo",
    "nvidia",
    "litellm",
  ] as const satisfies readonly LlmProvider[];

  return commonLaneProviders.map(
    (provider) =>
      new AiSdkLlmAdapter(provider, resolveModel, resolveProviderTools, options.credentialResolver),
  );
}

export function createAiSdkModelResolver(settings: AiSdkAdapterSettings = {}): AiSdkModelResolver {
  const configuredOpenAI = settings.openAI === undefined ? openai : createOpenAI(settings.openAI);
  const configuredAzure =
    settings.azureOpenAI === undefined ? azure : createAzure(settings.azureOpenAI);
  const configuredAnthropic =
    settings.anthropic === undefined ? anthropic : createAnthropic(settings.anthropic);
  const configuredBaseten =
    settings.baseten === undefined ? baseten : createBaseten(settings.baseten);
  const configuredBedrock =
    settings.bedrock === undefined ? bedrock : createAmazonBedrock(settings.bedrock);
  const configuredCerebras =
    settings.cerebras === undefined ? cerebras : createCerebras(settings.cerebras);
  const configuredCohere = settings.cohere === undefined ? cohere : createCohere(settings.cohere);
  const configuredDeepInfra =
    settings.deepinfra === undefined ? deepinfra : createDeepInfra(settings.deepinfra);
  const configuredDeepSeek =
    settings.deepseek === undefined ? deepseek : createDeepSeek(settings.deepseek);
  const configuredFireworks =
    settings.fireworks === undefined ? fireworks : createFireworks(settings.fireworks);
  const configuredGoogle =
    settings.google === undefined ? google : createGoogleGenerativeAI(settings.google);
  const configuredGroq = settings.groq === undefined ? groq : createGroq(settings.groq);
  const configuredMistral =
    settings.mistral === undefined ? mistral : createMistral(settings.mistral);
  const openAICompatibleProviders = createOpenAICompatibleProviders(settings.openAICompatible);
  const configuredPerplexity =
    settings.perplexity === undefined ? perplexity : createPerplexity(settings.perplexity);
  const configuredTogetherAI =
    settings.togetherai === undefined ? togetherai : createTogetherAI(settings.togetherai);
  const configuredXAI = settings.xai === undefined ? xai : createXai(settings.xai);

  return (model: ModelInfo, credential?: ProviderCredential): LanguageModel => {
    switch (model.provider) {
      case "openai":
        return (
          credential === undefined
            ? configuredOpenAI
            : createOpenAI({
                ...settings.openAI,
                apiKey: credential.apiKey,
                baseURL: credential.baseURL ?? settings.openAI?.baseURL,
              })
        )(model.providerModelId);
      case "azure_openai":
        return (
          credential === undefined
            ? configuredAzure
            : createAzure({
                ...settings.azureOpenAI,
                apiKey: credential.apiKey,
                baseURL: credential.baseURL ?? settings.azureOpenAI?.baseURL,
              })
        )(model.providerModelId);
      case "anthropic":
        return (
          credential === undefined
            ? configuredAnthropic
            : createAnthropic({
                ...settings.anthropic,
                apiKey: credential.apiKey,
                baseURL: credential.baseURL ?? settings.anthropic?.baseURL,
              })
        )(model.providerModelId);
      case "google":
        if (credential !== undefined) {
          const serviceAccountCredential = parseGoogleServiceAccountCredential(credential);
          if (
            credential.credentialName === "service_account_json" &&
            serviceAccountCredential === undefined
          ) {
            throw new LlmProviderError(
              model.provider,
              model.id,
              "Google service account credential must be valid JSON with client_email and private_key.",
            );
          }
          if (serviceAccountCredential !== undefined) {
            return createVertexForServiceAccount(
              settings.googleVertex,
              credential,
              serviceAccountCredential,
            )(model.providerModelId);
          }
        }
        return (
          credential === undefined
            ? configuredGoogle
            : createGoogleGenerativeAI({
                ...settings.google,
                apiKey: credential.apiKey,
                baseURL: credential.baseURL ?? settings.google?.baseURL,
              })
        )(model.providerModelId);
      case "groq":
        return (
          credential === undefined
            ? configuredGroq
            : createGroq({
                ...settings.groq,
                apiKey: credential.apiKey,
                baseURL: credential.baseURL ?? settings.groq?.baseURL,
              })
        )(model.providerModelId);
      case "xai":
        return (
          credential === undefined
            ? configuredXAI
            : createXai({
                ...settings.xai,
                apiKey: credential.apiKey,
                baseURL: credential.baseURL ?? settings.xai?.baseURL,
              })
        )(model.providerModelId);
      case "bedrock":
        return (
          credential === undefined
            ? configuredBedrock
            : createAmazonBedrock({
                ...settings.bedrock,
                apiKey: credential.apiKey,
                baseURL: credential.baseURL ?? settings.bedrock?.baseURL,
              })
        )(model.providerModelId);
      case "mistral":
        return (
          credential === undefined
            ? configuredMistral
            : createMistral({
                ...settings.mistral,
                apiKey: credential.apiKey,
                baseURL: credential.baseURL ?? settings.mistral?.baseURL,
              })
        )(model.providerModelId);
      case "togetherai":
        return (
          credential === undefined
            ? configuredTogetherAI
            : createTogetherAI({
                ...settings.togetherai,
                apiKey: credential.apiKey,
                baseURL: credential.baseURL ?? settings.togetherai?.baseURL,
              })
        )(model.providerModelId);
      case "cohere":
        return (
          credential === undefined
            ? configuredCohere
            : createCohere({
                ...settings.cohere,
                apiKey: credential.apiKey,
                baseURL: credential.baseURL ?? settings.cohere?.baseURL,
              })
        )(model.providerModelId);
      case "fireworks":
        return (
          credential === undefined
            ? configuredFireworks
            : createFireworks({
                ...settings.fireworks,
                apiKey: credential.apiKey,
                baseURL: credential.baseURL ?? settings.fireworks?.baseURL,
              })
        )(model.providerModelId);
      case "deepinfra":
        return (
          credential === undefined
            ? configuredDeepInfra
            : createDeepInfra({
                ...settings.deepinfra,
                apiKey: credential.apiKey,
                baseURL: credential.baseURL ?? settings.deepinfra?.baseURL,
              })
        )(model.providerModelId);
      case "deepseek":
        return (
          credential === undefined
            ? configuredDeepSeek
            : createDeepSeek({
                ...settings.deepseek,
                apiKey: credential.apiKey,
                baseURL: credential.baseURL ?? settings.deepseek?.baseURL,
              })
        )(model.providerModelId);
      case "cerebras":
        return (
          credential === undefined
            ? configuredCerebras
            : createCerebras({
                ...settings.cerebras,
                apiKey: credential.apiKey,
                baseURL: credential.baseURL ?? settings.cerebras?.baseURL,
              })
        )(model.providerModelId);
      case "perplexity":
        return (
          credential === undefined
            ? configuredPerplexity
            : createPerplexity({
                ...settings.perplexity,
                apiKey: credential.apiKey,
                baseURL: credential.baseURL ?? settings.perplexity?.baseURL,
              })
        )(model.providerModelId);
      case "baseten":
        return (
          credential === undefined
            ? configuredBaseten
            : createBaseten({
                ...settings.baseten,
                apiKey: credential.apiKey,
                baseURL: credential.baseURL ?? settings.baseten?.baseURL,
              })
        )(model.providerModelId);
      case "plamo":
      case "nvidia":
      case "litellm":
        return (
          credential === undefined
            ? openAICompatibleProviders[model.provider]
            : createOpenAICompatible(
                openAICompatibleSettings(model.provider, {
                  ...settings.openAICompatible?.[model.provider],
                  apiKey: credential.apiKey,
                  baseURL:
                    credential.baseURL ?? settings.openAICompatible?.[model.provider]?.baseURL,
                }),
              )
        )(model.providerModelId);
      case "dify":
        throw new LlmProviderError(
          model.provider,
          model.id,
          `Provider '${model.provider}' is not handled by the AI SDK common adapter lane.`,
        );
    }
  };
}

export function createAiSdkProviderToolResolver(
  settings: AiSdkAdapterSettings = {},
): AiSdkProviderToolResolver {
  const configuredOpenAI = settings.openAI === undefined ? openai : createOpenAI(settings.openAI);
  const configuredAzure =
    settings.azureOpenAI === undefined ? azure : createAzure(settings.azureOpenAI);
  const configuredAnthropic =
    settings.anthropic === undefined ? anthropic : createAnthropic(settings.anthropic);
  const configuredGoogle =
    settings.google === undefined ? google : createGoogleGenerativeAI(settings.google);

  return (model: ModelInfo, credential?: ProviderCredential): ToolSet | undefined => {
    if (!model.capabilities.includes("web_search")) {
      return undefined;
    }

    switch (model.provider) {
      case "openai": {
        const provider =
          credential === undefined
            ? configuredOpenAI
            : createOpenAI({
                ...settings.openAI,
                apiKey: credential.apiKey,
                baseURL: credential.baseURL ?? settings.openAI?.baseURL,
              });
        return {
          web_search: provider.tools.webSearch({}),
        };
      }
      case "azure_openai": {
        const provider =
          credential === undefined
            ? configuredAzure
            : createAzure({
                ...settings.azureOpenAI,
                apiKey: credential.apiKey,
                baseURL: credential.baseURL ?? settings.azureOpenAI?.baseURL,
              });
        return {
          web_search_preview: provider.tools.webSearchPreview({}),
        };
      }
      case "anthropic": {
        const provider =
          credential === undefined
            ? configuredAnthropic
            : createAnthropic({
                ...settings.anthropic,
                apiKey: credential.apiKey,
                baseURL: credential.baseURL ?? settings.anthropic?.baseURL,
              });
        return {
          web_search: provider.tools.webSearch_20250305({}),
        };
      }
      case "google": {
        if (credential?.credentialName === "service_account_json") {
          const serviceAccountCredential = parseGoogleServiceAccountCredential(credential);
          if (serviceAccountCredential === undefined) {
            return undefined;
          }
          const vertexProvider = createVertexForServiceAccount(
            settings.googleVertex,
            credential,
            serviceAccountCredential,
          );
          return {
            google_search: vertexProvider.tools.googleSearch({}),
          };
        }
        const provider =
          credential === undefined
            ? configuredGoogle
            : createGoogleGenerativeAI({
                ...settings.google,
                apiKey: credential.apiKey,
                baseURL: credential.baseURL ?? settings.google?.baseURL,
              });
        return {
          google_search: provider.tools.googleSearch({}),
        };
      }
      default:
        return undefined;
    }
  };
}

type GoogleServiceAccountCredential = {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  project_id?: string;
};

function createVertexForServiceAccount(
  settings: GoogleVertexProviderSettings | undefined,
  credential: ProviderCredential,
  serviceAccountCredential: GoogleServiceAccountCredential,
) {
  const project =
    stringPayloadField(credential.payload, "project_id") ?? serviceAccountCredential.project_id;
  const location =
    stringPayloadField(credential.payload, "location") ?? settings?.location ?? "us-central1";
  return createVertex({
    ...settings,
    googleAuthOptions: {
      ...settings?.googleAuthOptions,
      credentials: {
        client_email: serviceAccountCredential.client_email,
        private_key: serviceAccountCredential.private_key,
        ...(serviceAccountCredential.private_key_id === undefined
          ? {}
          : { private_key_id: serviceAccountCredential.private_key_id }),
      },
    },
    location,
    project,
  });
}

function parseGoogleServiceAccountCredential(
  credential: ProviderCredential,
): GoogleServiceAccountCredential | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credential.apiKey);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const clientEmail = readString(parsed, "client_email");
  const privateKey = readString(parsed, "private_key");
  if (clientEmail === undefined || privateKey === undefined) {
    return undefined;
  }
  return {
    client_email: clientEmail,
    private_key: privateKey,
    private_key_id: readString(parsed, "private_key_id"),
    project_id: readString(parsed, "project_id"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
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
  };
}

function openAICompatibleSettings(
  provider: OpenAICompatibleProvider,
  config: OpenAICompatibleProviderConfig = {},
): OpenAICompatibleProviderSettings {
  return {
    ...config,
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? OPENAI_COMPATIBLE_DEFAULT_BASE_URLS[provider],
    name: config.name ?? provider,
  };
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

function toolsForRequest(
  request: LlmRequest,
  providerTools: ToolSet | undefined,
): ToolSet | undefined {
  const requestTools = toAiSdkTools(request.tools);
  if (providerTools === undefined) {
    return requestTools;
  }
  if (requestTools === undefined) {
    return providerTools;
  }
  return {
    ...providerTools,
    ...requestTools,
  };
}

function providerToolNamesForRequest(
  request: LlmRequest,
  providerTools: ToolSet | undefined,
): ReadonlySet<string> {
  const requestToolNames = new Set((request.tools ?? []).map((definition) => definition.name));
  return new Set(
    Object.keys(providerTools ?? {}).filter((toolName) => !requestToolNames.has(toolName)),
  );
}

function isProviderToolCall(
  toolCall: { providerExecuted?: boolean; toolName: string },
  providerToolNames: ReadonlySet<string>,
): boolean {
  return toolCall.providerExecuted === true || providerToolNames.has(toolCall.toolName);
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

function mapSources(
  sources: readonly { sourceType?: string; title?: string; url?: string }[] | undefined,
): LlmResult["sources"] {
  const mappedSources = (sources ?? [])
    .filter((source) => source.sourceType === "url" && source.url !== undefined)
    .map((source) => ({
      title: source.title,
      url: source.url as string,
    }));
  return mappedSources.length === 0 ? undefined : mappedSources;
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
