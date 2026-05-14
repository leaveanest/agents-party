# Provider Router

`src/providers/` owns the TypeScript LLM provider boundary. Slack handlers and agent runtimes choose a configured model, but they do not infer providers from model names or call provider SDKs directly.

## Contracts

- `LlmProvider` enumerates the target providers: OpenAI, Azure OpenAI, Anthropic, Google, Bedrock, Groq, NVIDIA, PLaMo, xAI, Dify, and LiteLLM.
- `ModelInfo` is the registry record for a model. It stores provider, provider-native model id, optional legacy aliases, and explicit capabilities.
- `LlmCapability` represents behavior the application must check before invocation: text, streaming, image input, file input, audio input, tool calling, structured output, web search, image generation, video generation, thinking, and embeddings.
- `LlmRequest`, `LlmResult`, `LlmStreamEvent`, and `LlmAdapter` are repository-owned contracts. They intentionally do not expose Slack SDK or AI SDK message history types.

The domain history remains `ConversationHistory`. AI SDK `ModelMessage[]` conversion happens only at provider invocation boundaries.

`LlmRequest.context.workspaceId` carries the Slack workspace identity into provider invocation boundaries. Workspace credentials are resolved by adapters from encrypted PostgreSQL rows; `metadata` remains logging and tracing context, not a credential transport.

## Model Resolution

`ProviderRouter.resolveModel` resolves configured model ids with this precedence:

1. thread model
2. channel model
3. workspace model

If no model is configured, resolution fails. The router does not default to OpenAI, Gemini, or any other provider.

Application bootstrap defaults are outside `ProviderRouter.resolveModel`. `loadSettings` may supply `AgentRunner` with a local/bootstrap `agentModelId` so a developer can run the app before workspace, channel, or thread routing records exist. Production-like runtimes must set `AGENT_MODEL`, `DATABASE_URL`, and `LLM_API_KEY_ENCRYPTION_KEY`; missing production configuration fails during settings loading instead of silently choosing a provider or falling back to process-level provider API keys.

Legacy Slack Timeline-style model ids can be registered as aliases, for example `azure.gpt-4o` or `groq.llama-3.1-70b-versatile`, but aliases resolve to explicit registry records. Unknown model names fail until a registry entry is added.

## Capability Gate

`ProviderRouter.generate` and `ProviderRouter.stream` derive required capabilities from the request before adapter invocation:

- image parts require `image_input`
- file parts require `file_input`
- audio parts require `audio_input`
- tools require `tool_calling`
- JSON response format requires `structured_output`
- streaming calls require `streaming`

Callers can also pass `requiredCapabilities` for provider-specific features such as web search, image generation, thinking, or embeddings. Missing capabilities are rejected before provider adapters run.

## Adding A Provider Or Model

To add a new model, add a `ModelInfo` registry entry with explicit capabilities and aliases if needed. To add a new provider implementation, add one `LlmAdapter` for that provider and register it with `ProviderRouter`.

This keeps provider expansion local to `src/providers/`: Slack handlers and agent orchestration should not need provider-specific branches.

## AI SDK Common Lane

`AiSdkLlmAdapter` is the common invocation lane for providers that fit AI SDK's language-model abstraction:

- OpenAI
- Azure OpenAI
- Anthropic
- Google Gemini
- Groq
- OpenAI-compatible providers for xAI, PLaMo, NVIDIA NIM, and LiteLLM

The adapter converts repository `ConversationHistory` to AI SDK `ModelMessage[]` only at invocation time, maps AI SDK generation and streaming results back to `LlmResult` and `LlmStreamEvent`, and wraps provider failures as `LlmProviderError`.

When a `ProviderCredentialResolver` is configured and the request has `context.workspaceId`, the adapter looks up `provider_kind=<model provider>` and `credential_name=api_key` before constructing the provider model. Missing workspace credentials fail before falling back to process-level provider keys.

OpenAI-compatible providers use repository-owned defaults only for non-secret base URLs. API keys must come from workspace credentials or explicit local adapter settings; `src/providers/aiSdkAdapter.ts` does not read provider API keys directly from `process.env`.

AWS Bedrock and Dify are intentionally left for native adapter lanes because their production integrations need provider-specific configuration and behavior outside this common path.

## Native Provider Escape Hatches

`createNativeProviderAdapters()` registers explicit native-provider paths under the same `LlmAdapter` interface. These adapters are selected by required capability, not model-name checks.

The first concrete native path is Gemini web search through AI SDK's Google native search tool. It is used when a request requires `web_search`, so web research does not fall back to the common text-only lane.

Unsupported native paths still return `NativeProviderUnsupportedError` until concrete provider SDK implementations are added. Media generation tools can use separate media gateways under `src/providers/`; OpenAI image generation is implemented there with AI SDK `generateImage()` instead of the common text-generation adapter.

Native stubs currently cover:

- OpenAI Responses/native tools for `web_search`
- Anthropic thinking and web search
- Gemini file APIs
- AWS Bedrock Claude
- Dify endpoint invocation

This makes unsupported combinations fail before Slack or agent runtimes need provider-specific branches. The error message names the provider, model, requested capability, and the missing native path.
