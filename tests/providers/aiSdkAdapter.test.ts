import { describe, expect, it } from "vite-plus/test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

import type { ConversationHistory } from "../../src/domain/messageHistory.js";
import {
  AiSdkLlmAdapter,
  createAiSdkAdapters,
  createAiSdkModelResolver,
  createAiSdkProviderToolResolver,
  LlmProviderError,
} from "../../src/providers/aiSdkAdapter.js";
import {
  MissingWorkspaceContextError,
  MissingWorkspaceCredentialError,
} from "../../src/providers/credentials.js";
import { LlmReasoningEffortId, type ModelInfo } from "../../src/providers/contracts.js";

const model: ModelInfo = {
  capabilities: ["text", "streaming", "tool_calling"],
  id: "openai:test-model",
  provider: "openai",
  providerModelId: "test-model",
};

const googleModel: ModelInfo = {
  capabilities: ["text", "streaming", "tool_calling"],
  id: "google:gemini-test",
  provider: "google",
  providerModelId: "gemini-test",
};

const history: ConversationHistory = {
  messages: [
    {
      author: { id: "U1", kind: "user" },
      content: [{ text: "Hello", type: "text" }],
      id: "message-1",
      role: "user",
    },
  ],
};

describe("AiSdkLlmAdapter", () => {
  it("maps AI SDK text generation results into repository LLM results", async () => {
    const languageModel = new MockLanguageModelV3({
      doGenerate: {
        content: [
          {
            text: "Hello from AI SDK",
            type: "text",
          },
        ],
        finishReason: { raw: "stop", unified: "stop" },
        usage: usage(3, 4),
        warnings: [],
      },
      modelId: "test-model",
      provider: "openai",
    });
    const adapter = new AiSdkLlmAdapter("openai", () => languageModel);

    const result = await adapter.generate({
      history,
      model,
      system: "Reply as a concise Slack assistant.",
      tools: [
        {
          name: "search",
          parameters: {
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
            type: "object",
          },
        },
      ],
    });

    expect(languageModel.doGenerateCalls[0]?.prompt.at(0)).toEqual({
      content: "Reply as a concise Slack assistant.",
      role: "system",
    });
    expect(languageModel.doGenerateCalls[0]?.prompt.at(1)).toMatchObject({
      role: "user",
    });
    expect(result).toMatchObject({
      content: "Hello from AI SDK",
      finishReason: "stop",
      usage: {
        inputTokens: 3,
        outputTokens: 4,
        totalTokens: 7,
      },
    });
    expect(languageModel.doGenerateCalls[0]?.tools).toHaveLength(1);
  });

  it("enables provider web search tools by default for web-search capable models", async () => {
    const languageModel = new MockLanguageModelV3({
      doGenerate: {
        content: [
          {
            text: "Searched answer",
            type: "text",
          },
        ],
        finishReason: { raw: "stop", unified: "stop" },
        usage: usage(3, 4),
        warnings: [],
      },
      modelId: "test-model",
      provider: "openai",
    });
    const adapter = new AiSdkLlmAdapter("openai", () => languageModel);

    await adapter.generate({
      history,
      model: {
        ...model,
        capabilities: [...model.capabilities, "web_search"],
      },
    });

    expect(languageModel.doGenerateCalls[0]?.tools?.map((candidate) => candidate.name)).toContain(
      "web_search",
    );
  });

  it("passes reasoning effort through provider options for thinking-capable models", async () => {
    const languageModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ text: "Reasoned answer", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: usage(3, 4, 2),
        warnings: [],
      },
      modelId: "test-model",
      provider: "openai",
    });
    const adapter = new AiSdkLlmAdapter("openai", () => languageModel);

    const result = await adapter.generate({
      history,
      model: {
        ...model,
        capabilities: [...model.capabilities, "thinking"],
      },
      reasoningEffort: LlmReasoningEffortId.Medium,
    });

    expect(languageModel.doGenerateCalls[0]?.providerOptions).toEqual({
      openai: { reasoningEffort: "medium" },
    });
    expect(result.usage).toMatchObject({
      reasoningTokens: 2,
    });
  });

  it("omits reasoning provider options for models without thinking capability", async () => {
    const languageModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ text: "Plain answer", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: usage(3, 4),
        warnings: [],
      },
      modelId: "test-model",
      provider: "openai",
    });
    const adapter = new AiSdkLlmAdapter("openai", () => languageModel);

    await adapter.generate({
      history,
      model,
      reasoningEffort: LlmReasoningEffortId.Medium,
    });

    expect(languageModel.doGenerateCalls[0]?.providerOptions).toBeUndefined();
  });

  it("uses the OpenAI providerOptions key for Azure OpenAI reasoning settings", async () => {
    const languageModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ text: "Azure reasoned answer", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: usage(3, 4),
        warnings: [],
      },
      modelId: "test-model",
      provider: "azure_openai",
    });
    const adapter = new AiSdkLlmAdapter("azure_openai", () => languageModel);

    await adapter.generate({
      history,
      model: {
        capabilities: ["text", "thinking"],
        id: "azure_openai:test-model",
        provider: "azure_openai",
        providerModelId: "test-model",
      },
      reasoningEffort: LlmReasoningEffortId.Low,
    });

    expect(languageModel.doGenerateCalls[0]?.providerOptions).toEqual({
      openai: { reasoningEffort: "low" },
    });
  });

  it("passes reasoning effort through Anthropic effort provider option", async () => {
    const languageModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ text: "Anthropic answer", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: usage(3, 4),
        warnings: [],
      },
      modelId: "test-model",
      provider: "anthropic",
    });
    const adapter = new AiSdkLlmAdapter("anthropic", () => languageModel);

    await adapter.generate({
      history,
      model: {
        capabilities: ["text", "thinking"],
        id: "anthropic:test-model",
        provider: "anthropic",
        providerModelId: "test-model",
      },
      reasoningEffort: LlmReasoningEffortId.High,
    });

    expect(languageModel.doGenerateCalls[0]?.providerOptions).toEqual({
      anthropic: { effort: "high" },
    });
  });

  it("passes xhigh reasoning effort through for OpenAI Codex Max models", async () => {
    const languageModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ text: "OpenAI answer", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: usage(3, 4),
        warnings: [],
      },
      modelId: "test-model",
      provider: "openai",
    });
    const adapter = new AiSdkLlmAdapter("openai", () => languageModel);

    await adapter.generate({
      history,
      model: {
        capabilities: ["text", "thinking"],
        id: "openai:gpt-5.1-codex-max",
        provider: "openai",
        providerModelId: "gpt-5.1-codex-max",
      },
      reasoningEffort: LlmReasoningEffortId.XHigh,
    });

    expect(languageModel.doGenerateCalls[0]?.providerOptions).toEqual({
      openai: { reasoningEffort: "xhigh" },
    });
  });

  it("passes minimal reasoning effort through for OpenAI models", async () => {
    const languageModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ text: "OpenAI answer", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: usage(3, 4),
        warnings: [],
      },
      modelId: "test-model",
      provider: "openai",
    });
    const adapter = new AiSdkLlmAdapter("openai", () => languageModel);

    await adapter.generate({
      history,
      model: {
        capabilities: ["text", "thinking"],
        id: "openai:gpt-5.2",
        provider: "openai",
        providerModelId: "gpt-5.2",
      },
      reasoningEffort: LlmReasoningEffortId.Minimal,
    });

    expect(languageModel.doGenerateCalls[0]?.providerOptions).toEqual({
      openai: { reasoningEffort: "minimal" },
    });
  });

  it("passes minimal reasoning effort through Google thinking level", async () => {
    const languageModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ text: "Google answer", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: usage(3, 4),
        warnings: [],
      },
      modelId: "gemini-test",
      provider: "google",
    });
    const adapter = new AiSdkLlmAdapter("google", () => languageModel);

    await adapter.generate({
      history,
      model: {
        capabilities: ["text", "thinking"],
        id: "google:gemini-3.1-flash-lite-preview",
        provider: "google",
        providerModelId: "gemini-3.1-flash-lite-preview",
      },
      reasoningEffort: LlmReasoningEffortId.Minimal,
    });

    expect(languageModel.doGenerateCalls[0]?.providerOptions).toEqual({
      google: { thinkingConfig: { thinkingLevel: "minimal" } },
    });
  });

  it("omits unsupported Google thinking levels for specific Gemini models", async () => {
    const languageModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ text: "Google answer", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: usage(3, 4),
        warnings: [],
      },
      modelId: "gemini-test",
      provider: "google",
    });
    const adapter = new AiSdkLlmAdapter("google", () => languageModel);

    await adapter.generate({
      history,
      model: {
        capabilities: ["text", "thinking"],
        id: "google:gemini-3.1-pro-preview",
        provider: "google",
        providerModelId: "gemini-3.1-pro-preview",
      },
      reasoningEffort: LlmReasoningEffortId.Medium,
    });

    expect(languageModel.doGenerateCalls[0]?.providerOptions).toBeUndefined();
  });

  it("omits Google thinking level for Gemini 2.5 models", async () => {
    const languageModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ text: "Google answer", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: usage(3, 4),
        warnings: [],
      },
      modelId: "gemini-test",
      provider: "google",
    });
    const adapter = new AiSdkLlmAdapter("google", () => languageModel);

    await adapter.generate({
      history,
      model: {
        capabilities: ["text", "thinking"],
        id: "google:gemini-2.5-pro",
        provider: "google",
        providerModelId: "gemini-2.5-pro",
      },
      reasoningEffort: LlmReasoningEffortId.High,
    });

    expect(languageModel.doGenerateCalls[0]?.providerOptions).toBeUndefined();
  });

  it("omits OpenAI xhigh reasoning effort for models that do not support it", async () => {
    const languageModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ text: "OpenAI answer", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: usage(3, 4),
        warnings: [],
      },
      modelId: "test-model",
      provider: "openai",
    });
    const adapter = new AiSdkLlmAdapter("openai", () => languageModel);

    await adapter.generate({
      history,
      model: {
        capabilities: ["text", "thinking"],
        id: "openai:gpt-5",
        provider: "openai",
        providerModelId: "gpt-5",
      },
      reasoningEffort: LlmReasoningEffortId.XHigh,
    });

    expect(languageModel.doGenerateCalls[0]?.providerOptions).toBeUndefined();
  });

  it("ignores reasoning effort for thinking models on unsupported providers", async () => {
    const languageModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ text: "Together answer", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: usage(3, 4),
        warnings: [],
      },
      modelId: "test-model",
      provider: "togetherai",
    });
    const adapter = new AiSdkLlmAdapter("togetherai", () => languageModel);

    await adapter.generate({
      history,
      model: {
        capabilities: ["text", "thinking"],
        id: "togetherai:test-model",
        provider: "togetherai",
        providerModelId: "test-model",
      },
      reasoningEffort: LlmReasoningEffortId.Medium,
    });

    expect(languageModel.doGenerateCalls[0]?.providerOptions).toBeUndefined();
  });

  it("omits unsupported reasoning efforts for providers with narrower effort sets", async () => {
    const languageModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ text: "xAI answer", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: usage(3, 4),
        warnings: [],
      },
      modelId: "test-model",
      provider: "xai",
    });
    const adapter = new AiSdkLlmAdapter("xai", () => languageModel);

    await adapter.generate({
      history,
      model: {
        capabilities: ["text", "thinking"],
        id: "xai:test-model",
        provider: "xai",
        providerModelId: "test-model",
      },
      reasoningEffort: LlmReasoningEffortId.Medium,
    });

    expect(languageModel.doGenerateCalls[0]?.providerOptions).toBeUndefined();
  });

  it("does not expose provider-executed web search calls as repository agent tools", async () => {
    const languageModel = new MockLanguageModelV3({
      doGenerate: {
        content: [
          {
            providerExecuted: true,
            toolCallId: "search-1",
            toolName: "web_search",
            input: JSON.stringify({ query: "latest AI SDK web search" }),
            type: "tool-call",
          },
          {
            text: "Searched answer",
            type: "text",
          },
        ],
        finishReason: { raw: "stop", unified: "stop" },
        usage: usage(3, 4),
        warnings: [],
      },
      modelId: "test-model",
      provider: "openai",
    });
    const adapter = new AiSdkLlmAdapter("openai", () => languageModel);

    const result = await adapter.generate({
      history,
      model: {
        ...model,
        capabilities: [...model.capabilities, "web_search"],
      },
    });

    expect(result.toolCalls).toEqual([]);
  });

  it("uses AI SDK provider-specific web search tool names", () => {
    const resolveTools = createAiSdkProviderToolResolver();
    const providers = [
      ["openai", "web_search"],
      ["azure_openai", "web_search_preview"],
      ["anthropic", "web_search"],
      ["google", "google_search"],
    ] as const;

    for (const [provider, toolName] of providers) {
      expect(
        Object.keys(
          resolveTools({
            capabilities: ["text", "web_search"],
            id: `${provider}:test-model`,
            provider,
            providerModelId: "test-model",
          }) ?? {},
        ),
      ).toEqual([toolName]);
    }
  });

  it("passes workspace credentials into the model resolver", async () => {
    const languageModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ text: "credential ok", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: usage(1, 1),
        warnings: [],
      },
      modelId: "test-model",
      provider: "openai",
    });
    const adapter = new AiSdkLlmAdapter(
      "openai",
      (_model, credential) => {
        expect(credential).toEqual({
          apiKey: "workspace-key",
          baseURL: "https://proxy.example",
          credentialName: "api_key",
        });
        return languageModel;
      },
      {
        async resolveProviderCredential(input) {
          expect(input).toEqual({
            credentialName: "api_key",
            provider: "openai",
            workspaceId: "T1",
          });
          return { apiKey: "workspace-key", baseURL: "https://proxy.example" };
        },
      },
    );

    await expect(
      adapter.generate({
        context: { workspaceId: "T1" },
        history,
        model,
      }),
    ).resolves.toMatchObject({ content: "credential ok" });
  });

  it("prefers Google service account credentials before API keys", async () => {
    const languageModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ text: "vertex credential ok", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: usage(1, 1),
        warnings: [],
      },
      modelId: "gemini-test",
      provider: "google",
    });
    const credential = {
      apiKey: JSON.stringify({
        client_email: "agent@project.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----\\n",
        project_id: "vertex-project",
      }),
      payload: { project_id: "vertex-project" },
    };
    const lookups: unknown[] = [];
    const adapter = new AiSdkLlmAdapter(
      "google",
      (_model, resolvedCredential) => {
        expect(resolvedCredential).toEqual({
          ...credential,
          credentialName: "service_account_json",
        });
        return languageModel;
      },
      {
        async resolveProviderCredential(input) {
          lookups.push(input);
          return credential;
        },
      },
    );

    await expect(
      adapter.generate({
        context: { workspaceId: "T1" },
        history,
        model: googleModel,
      }),
    ).resolves.toMatchObject({ content: "vertex credential ok" });

    expect(lookups).toEqual([
      {
        credentialName: "service_account_json",
        provider: "google",
        workspaceId: "T1",
      },
    ]);
  });

  it("falls back to Google API keys when service account credentials are absent", async () => {
    const languageModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ text: "google api key ok", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: usage(1, 1),
        warnings: [],
      },
      modelId: "gemini-test",
      provider: "google",
    });
    const credential = { apiKey: "workspace-google-key" };
    const lookups: unknown[] = [];
    const adapter = new AiSdkLlmAdapter(
      "google",
      (_model, resolvedCredential) => {
        expect(resolvedCredential).toEqual({
          ...credential,
          credentialName: "api_key",
        });
        return languageModel;
      },
      {
        async resolveProviderCredential(input) {
          lookups.push(input);
          return input.credentialName === "service_account_json" ? undefined : credential;
        },
      },
    );

    await expect(
      adapter.generate({
        context: { workspaceId: "T1" },
        history,
        model: googleModel,
      }),
    ).resolves.toMatchObject({ content: "google api key ok" });

    expect(lookups).toEqual([
      {
        credentialName: "service_account_json",
        provider: "google",
        workspaceId: "T1",
      },
      {
        credentialName: "api_key",
        provider: "google",
        workspaceId: "T1",
      },
    ]);
  });

  it("rejects invalid Google service account credentials before provider invocation", async () => {
    const adapter = new AiSdkLlmAdapter("google", createAiSdkModelResolver(), {
      async resolveProviderCredential(input) {
        expect(input).toEqual({
          credentialName: "service_account_json",
          provider: "google",
          workspaceId: "T1",
        });
        return { apiKey: '{"type":"service_account"}' };
      },
    });

    await expect(
      adapter.generate({
        context: { workspaceId: "T1" },
        history,
        model: googleModel,
      }),
    ).rejects.toThrow(
      "Google service account credential must be valid JSON with client_email and private_key.",
    );
  });

  it("fails clearly when a workspace credential resolver is configured but missing", async () => {
    const adapter = new AiSdkLlmAdapter(
      "openai",
      () => {
        throw new Error("resolver should fail before model creation");
      },
      {
        async resolveProviderCredential() {
          return undefined;
        },
      },
    );

    await expect(
      adapter.generate({
        context: { workspaceId: "T1" },
        history,
        model,
      }),
    ).rejects.toThrow(MissingWorkspaceCredentialError);
  });

  it("fails closed when credential resolution is configured without workspace context", async () => {
    const adapter = new AiSdkLlmAdapter(
      "openai",
      () => {
        throw new Error("resolver should fail before model creation");
      },
      {
        async resolveProviderCredential() {
          return { apiKey: "workspace-key" };
        },
      },
    );

    await expect(adapter.generate({ history, model })).rejects.toThrow(
      MissingWorkspaceContextError,
    );
  });

  it("streams text deltas and final usage through repository stream events", async () => {
    const languageModel = new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { id: "text-1", type: "text-start" },
            { delta: "Hel", id: "text-1", type: "text-delta" },
            { delta: "lo", id: "text-1", type: "text-delta" },
            { id: "text-1", type: "text-end" },
            {
              finishReason: { raw: "stop", unified: "stop" },
              type: "finish",
              usage: usage(1, 2),
            },
          ],
        }),
      },
      modelId: "test-model",
      provider: "openai",
    });
    const adapter = new AiSdkLlmAdapter("openai", () => languageModel);

    const events = [];
    for await (const event of adapter.stream({ history, model, system: "Stream concisely." })) {
      events.push(event);
    }

    expect(languageModel.doStreamCalls[0]?.prompt.at(0)).toEqual({
      content: "Stream concisely.",
      role: "system",
    });
    expect(languageModel.doStreamCalls[0]?.prompt.at(1)).toMatchObject({
      role: "user",
    });
    expect(events).toEqual([
      { text: "Hel", type: "text-delta" },
      { text: "lo", type: "text-delta" },
      {
        type: "usage",
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
        },
      },
      {
        result: {
          content: "Hello",
          finishReason: "stop",
          toolCalls: [],
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            totalTokens: 3,
          },
        },
        type: "done",
      },
    ]);
  });

  it("emits streaming errors without a successful done event", async () => {
    const languageModel = new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { id: "text-1", type: "text-start" },
            { delta: "Partial", id: "text-1", type: "text-delta" },
            { error: new Error("stream failed"), type: "error" },
            { id: "text-1", type: "text-end" },
            {
              finishReason: { raw: "stop", unified: "stop" },
              type: "finish",
              usage: usage(1, 2),
            },
          ],
        }),
      },
      modelId: "test-model",
      provider: "openai",
    });
    const adapter = new AiSdkLlmAdapter("openai", () => languageModel);

    const events = [];
    for await (const event of adapter.stream({ history, model })) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ text: "Partial", type: "text-delta" });
    expect(events[1]).toMatchObject({
      error: {
        message: "stream failed",
        name: "LlmProviderError",
      },
      type: "error",
    });
  });

  it("rejects structured response formats until the adapter enforces them", async () => {
    const languageModel = new MockLanguageModelV3({
      doGenerate: {
        content: [{ text: "{}", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: usage(1, 1),
        warnings: [],
      },
      modelId: "test-model",
      provider: "openai",
    });
    const adapter = new AiSdkLlmAdapter("openai", () => languageModel);

    await expect(
      adapter.generate({
        history,
        model,
        responseFormat: {
          type: "json",
        },
      }),
    ).rejects.toThrow("supports text response format only");
    expect(languageModel.doGenerateCalls).toHaveLength(0);
  });

  it("normalizes provider errors", async () => {
    const languageModel = new MockLanguageModelV3({
      async doGenerate() {
        throw new Error("provider failed");
      },
      modelId: "test-model",
      provider: "openai",
    });
    const adapter = new AiSdkLlmAdapter("openai", () => languageModel);

    await expect(adapter.generate({ history, model })).rejects.toMatchObject({
      modelId: "openai:test-model",
      name: "LlmProviderError",
      provider: "openai",
    });
    await expect(adapter.generate({ history, model })).rejects.toThrow("provider failed");
  });

  it("creates common-lane adapters for AI SDK and OpenAI-compatible providers", () => {
    expect(createAiSdkAdapters().map((adapter) => adapter.provider)).toEqual([
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
    ]);
  });

  it("does not read OpenAI-compatible provider settings from process environment", async () => {
    const previousApiKey = process.env.NVIDIA_API_KEY;
    const previousBaseUrl = process.env.NVIDIA_BASE_URL;
    process.env.NVIDIA_API_KEY = "env-key";
    process.env.NVIDIA_BASE_URL = "https://env.example/v1";
    const requests: Array<{ authorization: string | null; url: string }> = [];
    try {
      const adapter = createAiSdkAdapters({
        openAICompatible: {
          nvidia: {
            fetch: async (input, init) => {
              const headers = new Headers(init?.headers);
              requests.push({
                authorization: headers.get("authorization"),
                url: String(input),
              });
              return openAICompatibleChatResponse("configured path");
            },
          },
        },
      }).find((candidate) => candidate.provider === "nvidia");
      if (adapter === undefined) {
        throw new Error("NVIDIA adapter was not registered.");
      }

      await expect(
        adapter.generate({
          history,
          model: {
            capabilities: ["text"],
            id: "nvidia:meta/llama-3.1-70b-instruct",
            provider: "nvidia",
            providerModelId: "meta/llama-3.1-70b-instruct",
          },
        }),
      ).resolves.toMatchObject({ content: "configured path" });

      expect(requests).toEqual([
        {
          authorization: null,
          url: "https://integrate.api.nvidia.com/v1/chat/completions",
        },
      ]);
    } finally {
      restoreEnv("NVIDIA_API_KEY", previousApiKey);
      restoreEnv("NVIDIA_BASE_URL", previousBaseUrl);
    }
  });

  it("uses workspace credential base URLs for OpenAI-compatible providers", async () => {
    const requests: Array<{ authorization: string | null; url: string }> = [];
    const adapter = createAiSdkAdapters(
      {
        openAICompatible: {
          nvidia: {
            baseURL: "https://configured.example/v1",
            fetch: async (input, init) => {
              const headers = new Headers(init?.headers);
              requests.push({
                authorization: headers.get("authorization"),
                url: String(input),
              });
              return openAICompatibleChatResponse("workspace credential path");
            },
          },
        },
      },
      {
        credentialResolver: {
          async resolveProviderCredential(input) {
            expect(input).toEqual({
              credentialName: "api_key",
              provider: "nvidia",
              workspaceId: "T1",
            });
            return {
              apiKey: "workspace-key",
              baseURL: "https://workspace.example/v1",
            };
          },
        },
      },
    ).find((candidate) => candidate.provider === "nvidia");
    if (adapter === undefined) {
      throw new Error("NVIDIA adapter was not registered.");
    }

    await expect(
      adapter.generate({
        context: { workspaceId: "T1" },
        history,
        model: {
          capabilities: ["text"],
          id: "nvidia:meta/llama-3.1-70b-instruct",
          provider: "nvidia",
          providerModelId: "meta/llama-3.1-70b-instruct",
        },
      }),
    ).resolves.toMatchObject({ content: "workspace credential path" });

    expect(requests).toEqual([
      {
        authorization: "Bearer workspace-key",
        url: "https://workspace.example/v1/chat/completions",
      },
    ]);
  });

  it("declines capabilities reserved for native provider lanes", () => {
    const adapter = new AiSdkLlmAdapter("openai", () => {
      throw new Error("not used");
    });

    expect(adapter.supports({ history, model }, ["text"])).toBe(true);
    expect(adapter.supports({ history, model }, ["text", "web_search"])).toBe(true);
    expect(adapter.supports({ history, model }, ["image_generation"])).toBe(false);
  });

  it("rejects providers owned by native adapter lanes", () => {
    const resolveModel = createAiSdkModelResolver();

    expect(() =>
      resolveModel({
        capabilities: ["text"],
        id: "dify:test-model",
        provider: "dify",
        providerModelId: "test-model",
      }),
    ).toThrow(LlmProviderError);
  });
});

function usage(inputTokens: number, outputTokens: number, reasoningTokens?: number) {
  return {
    inputTokens: {
      cacheRead: undefined,
      cacheWrite: undefined,
      noCache: inputTokens,
      total: inputTokens,
    },
    outputTokens: {
      reasoning: reasoningTokens,
      text: outputTokens,
      total: outputTokens,
    },
  };
}

function openAICompatibleChatResponse(content: string): Response {
  return Response.json({
    choices: [
      {
        finish_reason: "stop",
        message: {
          content,
          role: "assistant",
        },
      },
    ],
    usage: {
      completion_tokens: 1,
      prompt_tokens: 1,
      total_tokens: 2,
    },
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
