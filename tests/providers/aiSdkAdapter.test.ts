import { describe, expect, it } from "vite-plus/test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

import type { ConversationHistory } from "../../src/domain/messageHistory.js";
import {
  AiSdkLlmAdapter,
  createAiSdkAdapters,
  createAiSdkModelResolver,
  LlmProviderError,
} from "../../src/providers/aiSdkAdapter.js";
import {
  MissingWorkspaceContextError,
  MissingWorkspaceCredentialError,
} from "../../src/providers/credentials.js";
import type { ModelInfo } from "../../src/providers/contracts.js";

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
    for await (const event of adapter.stream({ history, model })) {
      events.push(event);
    }

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
      "groq",
      "xai",
      "plamo",
      "nvidia",
      "litellm",
    ]);
  });

  it("does not read OpenAI-compatible provider settings from process environment", async () => {
    const previousApiKey = process.env.XAI_API_KEY;
    const previousBaseUrl = process.env.XAI_BASE_URL;
    process.env.XAI_API_KEY = "env-key";
    process.env.XAI_BASE_URL = "https://env.example/v1";
    const requests: Array<{ authorization: string | null; url: string }> = [];
    try {
      const adapter = createAiSdkAdapters({
        openAICompatible: {
          xai: {
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
      }).find((candidate) => candidate.provider === "xai");
      if (adapter === undefined) {
        throw new Error("xAI adapter was not registered.");
      }

      await expect(
        adapter.generate({
          history,
          model: {
            capabilities: ["text"],
            id: "xai:grok-2-latest",
            provider: "xai",
            providerModelId: "grok-2-latest",
          },
        }),
      ).resolves.toMatchObject({ content: "configured path" });

      expect(requests).toEqual([
        {
          authorization: null,
          url: "https://api.x.ai/v1/chat/completions",
        },
      ]);
    } finally {
      restoreEnv("XAI_API_KEY", previousApiKey);
      restoreEnv("XAI_BASE_URL", previousBaseUrl);
    }
  });

  it("uses workspace credential base URLs for OpenAI-compatible providers", async () => {
    const requests: Array<{ authorization: string | null; url: string }> = [];
    const adapter = createAiSdkAdapters(
      {
        openAICompatible: {
          xai: {
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
              provider: "xai",
              workspaceId: "T1",
            });
            return {
              apiKey: "workspace-key",
              baseURL: "https://workspace.example/v1",
            };
          },
        },
      },
    ).find((candidate) => candidate.provider === "xai");
    if (adapter === undefined) {
      throw new Error("xAI adapter was not registered.");
    }

    await expect(
      adapter.generate({
        context: { workspaceId: "T1" },
        history,
        model: {
          capabilities: ["text"],
          id: "xai:grok-2-latest",
          provider: "xai",
          providerModelId: "grok-2-latest",
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
    expect(adapter.supports({ history, model }, ["text", "web_search"])).toBe(false);
    expect(adapter.supports({ history, model }, ["image_generation"])).toBe(false);
  });

  it("rejects providers owned by native adapter lanes", () => {
    const resolveModel = createAiSdkModelResolver();

    expect(() =>
      resolveModel({
        capabilities: ["text"],
        id: "bedrock:test-model",
        provider: "bedrock",
        providerModelId: "test-model",
      }),
    ).toThrow(LlmProviderError);
  });
});

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: {
      cacheRead: undefined,
      cacheWrite: undefined,
      noCache: inputTokens,
      total: inputTokens,
    },
    outputTokens: {
      reasoning: undefined,
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
