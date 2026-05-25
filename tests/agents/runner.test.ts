import { jsonSchema, type ToolSet } from "ai";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  AgentRunner,
  selectAgentAction,
  shouldUseFocusedImageGenerationInvocation,
  shouldUseFocusedImageGenerationTools,
  type AgentRunnerAiSdkToolSetHandle,
} from "../../src/agents/runner.js";
import { AgentToolRegistry } from "../../src/agents/toolContracts.js";
import type { JsonValue } from "../../src/domain/messageHistory.js";
import type {
  LlmRequest,
  LlmResult,
  LlmStreamEvent,
  ModelInfo,
} from "../../src/providers/contracts.js";
import { ModelRegistry } from "../../src/providers/modelRegistry.js";

const model: ModelInfo = {
  capabilities: ["text", "tool_calling"],
  id: "google:gemini-2.5-flash",
  provider: "google",
  providerModelId: "gemini-2.5-flash",
};
const explicitModel: ModelInfo = {
  capabilities: ["text", "tool_calling"],
  id: "anthropic:claude-3-5-sonnet-latest",
  provider: "anthropic",
  providerModelId: "claude-3-5-sonnet-latest",
};
const textOnlyModel: ModelInfo = {
  capabilities: ["text"],
  id: "plamo:plamo-2.0-mini",
  provider: "plamo",
  providerModelId: "plamo-2.0-mini",
};
const thinkingModel: ModelInfo = {
  capabilities: ["text", "thinking"],
  id: "openai:gpt-5",
  provider: "openai",
  providerModelId: "gpt-5",
};

describe("AgentRunner", () => {
  it("uses a single agent action instead of specialist routing", () => {
    expect(selectAgentAction()).toEqual({
      action: "respond",
      reason: "agent_invocation",
    });
  });

  it("guides the model to use SORACOM discovery before asking for a generic SIM identifier", async () => {
    const router = new FakeProviderRouter({ content: "ok" });
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
    });

    await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      teamId: "T1",
      text: "ソラコムのSIM情報をくれ",
      userId: "U1",
    });

    expect(router.requests[0]?.system).toContain("call soracom_find_resources");
    expect(router.requests[0]?.system).toContain('query "sim"');
  });

  it("detects image generation requests for focused tool selection", () => {
    expect(shouldUseFocusedImageGenerationTools("野良犬の画像を生成して")).toBe(true);
    expect(shouldUseFocusedImageGenerationTools("draw a picture of a city")).toBe(true);
    expect(shouldUseFocusedImageGenerationTools("野良犬の画像を探して")).toBe(false);
    expect(shouldUseFocusedImageGenerationTools("render this markdown")).toBe(false);
    expect(shouldUseFocusedImageGenerationTools("summarize this thread")).toBe(false);
    expect(shouldUseFocusedImageGenerationTools("explain this drawing")).toBe(false);
    expect(shouldUseFocusedImageGenerationTools("what do you make of this picture?")).toBe(false);
  });

  it("detects image modification follow-ups for focused tool selection", () => {
    expect(
      shouldUseFocusedImageGenerationInvocation({
        channelId: "C1",
        messageTs: "2.0",
        referenceImages: [],
        teamId: "T1",
        text: "色を黒くして",
        threadHistory: [
          {
            messageTs: "1.0",
            role: "user",
            teamId: "T1",
            text: "野良犬の画像を生成して",
            userId: "U1",
          },
        ],
        threadMessages: [],
        transientAttachments: [],
        userId: "U1",
        viewerContextChannelIds: [],
      }),
    ).toBe(true);
  });

  it("does not route ordinary follow-ups after an image request to focused image generation", () => {
    const priorImageInvocation = {
      channelId: "C1",
      messageTs: "2.0",
      referenceImages: [],
      teamId: "T1",
      threadHistory: [
        {
          messageTs: "1.0",
          role: "user" as const,
          teamId: "T1",
          text: "野良犬の画像を生成して",
          userId: "U1",
        },
      ],
      threadMessages: [],
      transientAttachments: [],
      userId: "U1",
      viewerContextChannelIds: [],
    };

    expect(
      shouldUseFocusedImageGenerationInvocation({
        ...priorImageInvocation,
        text: "説明して",
      }),
    ).toBe(false);
    expect(
      shouldUseFocusedImageGenerationInvocation({
        ...priorImageInvocation,
        text: "確認して",
      }),
    ).toBe(false);
    expect(
      shouldUseFocusedImageGenerationInvocation({
        ...priorImageInvocation,
        text: "何色ですか？",
      }),
    ).toBe(false);
    expect(
      shouldUseFocusedImageGenerationInvocation({
        ...priorImageInvocation,
        text: "黒について説明して",
      }),
    ).toBe(false);
    expect(
      shouldUseFocusedImageGenerationInvocation({
        ...priorImageInvocation,
        text: "色は黒ですか？",
      }),
    ).toBe(false);
    expect(
      shouldUseFocusedImageGenerationInvocation({
        ...priorImageInvocation,
        text: "この画像の色は白っぽい？",
      }),
    ).toBe(false);
  });

  it("routes primary Slack mentions through the provider-backed agent runner", async () => {
    const router = new FakeProviderRouter({
      content: "Hello from TypeScript AgentRunner",
    });
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
    });

    const result = await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      teamId: "T1",
      text: "hello",
      userId: "U1",
    });

    expect(result).toMatchObject({
      decision: { action: "respond" },
      message: "Hello from TypeScript AgentRunner",
      model: { id: "google:gemini-2.5-flash", provider: "google" },
    });
    expect(router.requests[0]?.history.messages.at(-1)).toMatchObject({
      id: "1.0",
      role: "user",
    });
    expect(router.requests[0]?.context).toEqual({ workspaceId: "T1" });
    expect(router.requests[0]?.system).toContain(
      "You are the general Agents party assistant. Reply directly and concisely for Slack.",
    );
    expect(router.requests[0]?.system).toContain("slack_real_time_search");
    expect(router.requests[0]?.history.messages.map((message) => message.role)).not.toContain(
      "system",
    );
  });

  it("streams text deltas before returning the final runner result", async () => {
    const router = new FakeProviderRouter({
      content: "Hello streamed world",
    });
    router.streamEvents = [
      { text: "Hello ", type: "text-delta" },
      { text: "streamed world", type: "text-delta" },
      {
        result: {
          content: "Hello streamed world",
        },
        type: "done",
      },
    ];
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
    });

    const events = [];
    for await (const event of runner.runStream({
      channelId: "C1",
      messageTs: "1.0",
      teamId: "T1",
      text: "hello",
      userId: "U1",
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { text: "Hello ", type: "text-delta" },
      { text: "streamed world", type: "text-delta" },
      {
        result: expect.objectContaining({
          decision: { action: "respond", reason: "agent_invocation" },
          message: "Hello streamed world",
          model: { id: "google:gemini-2.5-flash", provider: "google" },
        }),
        type: "result",
      },
    ]);
    expect(router.requests[0]?.history.messages.at(-1)).toMatchObject({
      id: "1.0",
      role: "user",
    });
  });

  it("uses an explicit invocation model before the default model", async () => {
    const router = new FakeProviderRouter({
      content: "model override",
    });
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
    });

    const result = await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      modelId: explicitModel.id,
      teamId: "T1",
      text: "hello",
      userId: "U1",
    });

    expect(result.model).toEqual({
      id: "anthropic:claude-3-5-sonnet-latest",
      provider: "anthropic",
    });
    expect(router.requests[0]?.model.id).toBe(explicitModel.id);
  });

  it("leaves reasoning effort unset until routing settings choose one", async () => {
    const router = new FakeProviderRouter({
      content: "reasoned",
    });
    const runner = new AgentRunner({
      defaultModelId: thinkingModel.id,
      providerRouter: router,
    });

    await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      teamId: "T1",
      text: "think",
      userId: "U1",
    });

    expect(router.requests[0]?.reasoningEffort).toBeUndefined();
  });

  it("uses explicit invocation reasoning effort before the model default", async () => {
    const router = new FakeProviderRouter({
      content: "reasoned",
    });
    const runner = new AgentRunner({
      defaultModelId: thinkingModel.id,
      providerRouter: router,
    });

    await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      reasoningEffort: "provider_default",
      teamId: "T1",
      text: "think",
      userId: "U1",
    });

    expect(router.requests[0]?.reasoningEffort).toBe("provider_default");
  });

  it("runs structured agent requests without imposing an output token limit", async () => {
    const router = new FakeProviderRouter({
      content: "",
      structuredOutput: { translatedText: "こんにちは" },
    });
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
    });

    const result = await runner.runStructured(
      {
        channelId: "C1",
        messageTs: "1.0",
        teamId: "T1",
        text: "translate this",
        userId: "U1",
      },
      {
        jsonSchema: {
          additionalProperties: false,
          properties: { translatedText: { type: "string" } },
          required: ["translatedText"],
          type: "object",
        },
        type: "json",
      },
    );

    expect(result.structuredOutput).toEqual({ translatedText: "こんにちは" });
    expect(router.requests[0]?.maxOutputTokens).toBeUndefined();
    expect(router.requests[0]?.responseFormat).toEqual(expect.objectContaining({ type: "json" }));
  });

  it("returns a user-facing fallback when the provider returns no text after search", async () => {
    const router = new FakeProviderRouter({
      content: "",
      sources: [{ title: "Source", url: "https://example.com" }],
    });
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
    });

    const result = await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      teamId: "T1",
      text: "search",
      userId: "U1",
    });

    expect(result.message).toBe(
      "検索は実行されましたが、回答本文が返されませんでした。もう一度お試しください。",
    );
  });

  it("adds transient audio transcripts to provider history without persistence types", async () => {
    const router = new FakeProviderRouter({
      content: "heard it",
    });
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
    });

    await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      teamId: "T1",
      text: "summarize this",
      transientAttachments: [
        {
          filename: "voice.mp3",
          id: "F1",
          kind: "audio",
          mediaType: "audio/mpeg",
          messageTs: "1.0",
          transcript: "audio transcript",
        },
      ],
      userId: "U1",
    });

    expect(router.requests[0]?.history.messages.at(-1)).toMatchObject({
      content: [
        { text: "summarize this", type: "text" },
        { text: "[audio: voice.mp3]\naudio transcript", type: "text" },
      ],
      role: "user",
    });
  });

  it("adds reference image bytes to provider history", async () => {
    const router = new FakeProviderRouter({
      content: "saw it",
    });
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
    });

    await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      referenceImages: [
        {
          data: new Uint8Array([1, 2, 3]),
          identifier: "F1",
          mediaType: "image/png",
          messageTs: "1.0",
        },
      ],
      teamId: "T1",
      text: "what is in this image?",
      userId: "U1",
    });

    expect(router.requests[0]?.history.messages.at(-1)).toMatchObject({
      content: [
        { text: "what is in this image?", type: "text" },
        {
          filename: "F1",
          id: "F1",
          mediaType: "image/png",
          source: { data: new Uint8Array([1, 2, 3]), type: "bytes" },
          type: "image",
        },
      ],
      role: "user",
    });
  });

  it("ignores blank invocation model ids", async () => {
    const router = new FakeProviderRouter({
      content: "default model",
    });
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
    });

    const result = await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      modelId: "   ",
      teamId: "T1",
      text: "hello",
      userId: "U1",
    });

    expect(result.model).toEqual({ id: model.id, provider: "google" });
    expect(router.requests[0]?.model.id).toBe(model.id);
  });

  it("runs a final provider turn after typed tool calls", async () => {
    const registry = new AgentToolRegistry([
      {
        description: "Echo a string.",
        execute: async (input) => ({ echoed: readText(input) }),
        name: "echo",
        outputSchema: z.object({ echoed: z.string() }) as never,
        parameters: {
          additionalProperties: false,
          properties: { text: { type: "string" } },
          required: ["text"],
          type: "object",
        },
        schema: z.object({ text: z.string() }) as never,
      },
    ]);
    const router = new SequencedProviderRouter([
      {
        content: "",
        finishReason: "tool_call",
        toolCalls: [{ input: { text: "ok" }, toolCallId: "call-1", toolName: "echo" }],
      },
      {
        content: "final",
      },
    ]);
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
      toolRegistry: registry,
    });

    const result = await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      teamId: "T1",
      text: "echo",
      userId: "U1",
    });

    expect(result.message).toBe("final");
    expect(result.toolResults).toEqual([
      {
        input: { text: "ok" },
        output: { echoed: "ok" },
        toolCallId: "call-1",
        toolName: "echo",
      },
    ]);
    expect(router.requests[0]?.tools).toEqual([
      expect.objectContaining({
        name: "echo",
      }),
    ]);
    expect(router.requests).toHaveLength(2);
    expect(router.requests[1]?.history.messages.map((message) => message.role)).toContain("tool");
    expect(router.requests[1]?.history.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: [
            expect.objectContaining({
              input: { text: "ok" },
              toolCallId: "call-1",
              type: "tool-call",
            }),
          ],
          role: "assistant",
        }),
      ]),
    );
  });

  it("redacts generated media bytes from follow-up model history", async () => {
    const registry = new AgentToolRegistry([
      {
        description: "Generate an image.",
        execute: async () => ({
          media: {
            dataBase64: "raw-image-bytes",
            kind: "image",
            mimeType: "image/png",
            modelId: "openai:gpt-image-1.5",
            prompt: "draw",
            provider: "openai",
            status: "generated",
          },
          message: "Image generated.",
          ok: true,
        }),
        name: "generate_image",
        outputSchema: z.object({
          media: z.object({
            dataBase64: z.string(),
            kind: z.literal("image"),
            mimeType: z.string(),
            modelId: z.string(),
            prompt: z.string(),
            provider: z.string(),
            status: z.literal("generated"),
          }),
          message: z.string(),
          ok: z.boolean(),
        }) as never,
        parameters: { type: "object" },
        schema: z.object({ prompt: z.string() }) as never,
      },
    ]);
    const router = new SequencedProviderRouter([
      {
        content: "",
        finishReason: "tool_call",
        toolCalls: [
          { input: { prompt: "draw" }, toolCallId: "call-1", toolName: "generate_image" },
        ],
      },
      {
        content: "uploaded",
      },
    ]);
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
      toolRegistry: registry,
    });

    const result = await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      teamId: "T1",
      text: "draw",
      userId: "U1",
    });

    expect(result.structuredResult).toMatchObject({
      media: {
        dataBase64: "raw-image-bytes",
        kind: "image",
      },
    });
    expect(JSON.stringify(router.requests[1]?.history)).not.toContain("raw-image-bytes");
    expect(JSON.stringify(router.requests[1]?.history)).toContain("[redacted]");
  });

  it("uses AI SDK-executed tool results for generated media outputs", async () => {
    const router = new FakeProviderRouter({
      content: "",
      toolResults: [
        {
          input: { prompt: "draw" },
          output: {
            media: {
              dataBase64: "raw-image-bytes",
              kind: "image",
              mimeType: "image/png",
              modelId: "openai:gpt-image-1.5",
              prompt: "draw",
              provider: "openai",
              status: "generated",
            },
            message: "Image generated.",
            ok: true,
          },
          toolCallId: "call-1",
          toolName: "generate_image",
        },
      ],
    });
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
    });

    const result = await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      teamId: "T1",
      text: "draw",
      userId: "U1",
    });

    expect(result.message).toBe("Image generated.");
    expect(result.structuredResult).toMatchObject({
      media: {
        dataBase64: "raw-image-bytes",
        kind: "image",
      },
    });
    expect(result.toolResults).toHaveLength(1);
  });

  it("allows multiple tool rounds before the final provider response", async () => {
    const registry = new AgentToolRegistry([
      {
        description: "Echo a string.",
        execute: async (input) => ({ echoed: readText(input) }),
        name: "echo",
        outputSchema: z.object({ echoed: z.string() }) as never,
        parameters: {
          additionalProperties: false,
          properties: { text: { type: "string" } },
          required: ["text"],
          type: "object",
        },
        schema: z.object({ text: z.string() }) as never,
      },
    ]);
    const router = new SequencedProviderRouter([
      {
        content: "",
        finishReason: "tool_call",
        toolCalls: [{ input: { text: "first" }, toolCallId: "call-1", toolName: "echo" }],
      },
      {
        content: "",
        finishReason: "tool_call",
        toolCalls: [{ input: { text: "second" }, toolCallId: "call-2", toolName: "echo" }],
      },
      {
        content: "final",
      },
    ]);
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
      toolRegistry: registry,
    });

    const result = await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      teamId: "T1",
      text: "echo twice",
      userId: "U1",
    });

    expect(result.message).toBe("final");
    expect(result.toolResults.map((toolResult) => toolResult.toolCallId)).toEqual([
      "call-1",
      "call-2",
    ]);
    expect(router.requests).toHaveLength(3);
  });

  it("lets tool registry factories gate tools by resolved model capability", async () => {
    const router = new FakeProviderRouter({
      content: "text only",
    });
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
      toolRegistryFactory: (_invocation, resolvedModel) =>
        resolvedModel.capabilities.includes("tool_calling")
          ? new AgentToolRegistry([
              {
                description: "Echo a string.",
                execute: async (input) => ({ echoed: readText(input) }),
                name: "echo",
                outputSchema: z.object({ echoed: z.string() }) as never,
                parameters: { type: "object" },
                schema: z.object({ text: z.string() }) as never,
              },
            ])
          : new AgentToolRegistry(),
    });

    await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      modelId: textOnlyModel.id,
      teamId: "T1",
      text: "hello",
      userId: "U1",
    });

    expect(router.requests[0]?.tools).toEqual([]);
  });

  it("passes AI SDK toolsets directly to the provider request and closes them", async () => {
    const router = new FakeProviderRouter({
      content: "used mcp",
    });
    const closed: string[] = [];
    const mcpTools: ToolSet = {
      slack_search_public: {
        description: "Search Slack through MCP.",
        execute: async () => ({ content: [{ text: "result", type: "text" }] }),
        inputSchema: jsonSchema({ type: "object" }),
        type: "dynamic",
      } as ToolSet[string],
    };
    const runner = new AgentRunner({
      aiSdkToolSetFactory: () => ({
        async close() {
          closed.push("closed");
        },
        tools: mcpTools,
      }),
      defaultModelId: model.id,
      providerRouter: router,
    });

    await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      teamId: "T1",
      text: "search",
      userId: "U1",
    });

    expect(router.requests[0]?.aiSdkTools?.slack_search_public).toBe(mcpTools.slack_search_public);
    expect(closed).toEqual(["closed"]);
  });

  it("continues without AI SDK toolsets when preparing them fails", async () => {
    const router = new FakeProviderRouter({
      content: "without mcp",
    });
    const warnings: unknown[] = [];
    const runner = new AgentRunner({
      aiSdkToolSetFactory: async () => {
        throw new Error("MCP unavailable");
      },
      defaultModelId: model.id,
      logger: {
        warn(message: string, metadata: unknown) {
          warnings.push({ message, metadata });
        },
      },
      providerRouter: router,
    });

    const result = await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      teamId: "T1",
      text: "search",
      userId: "U1",
    });

    expect(result.message).toBe("without mcp");
    expect(router.requests[0]?.aiSdkTools).toBeUndefined();
    expect(warnings).toEqual([
      {
        message: "Failed to prepare AI SDK toolsets for agent invocation.",
        metadata: expect.objectContaining({
          channelId: "C1",
          modelId: model.id,
          provider: model.provider,
          teamId: "T1",
        }),
      },
    ]);
  });

  it("continues without AI SDK toolsets when preparing them times out", async () => {
    const router = new FakeProviderRouter({
      content: "without slow mcp",
    });
    const warnings: unknown[] = [];
    const closed: string[] = [];
    let resolveToolSet: (handle: AgentRunnerAiSdkToolSetHandle) => void = () => {};
    const slowToolSet = new Promise<AgentRunnerAiSdkToolSetHandle>((resolve) => {
      resolveToolSet = resolve;
    });
    const runner = new AgentRunner({
      aiSdkToolSetFactory: () => slowToolSet,
      aiSdkToolSetPreparationTimeoutMs: 1,
      defaultModelId: model.id,
      logger: {
        warn(message: string, metadata: unknown) {
          warnings.push({ message, metadata });
        },
      },
      providerRouter: router,
    });

    const result = await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      teamId: "T1",
      text: "search",
      userId: "U1",
    });
    resolveToolSet({
      async close() {
        closed.push("closed");
      },
      tools: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.message).toBe("without slow mcp");
    expect(router.requests[0]?.aiSdkTools).toBeUndefined();
    expect(closed).toEqual(["closed"]);
    expect(warnings).toEqual([
      {
        message: "Failed to prepare AI SDK toolsets for agent invocation.",
        metadata: expect.objectContaining({
          channelId: "C1",
          modelId: model.id,
          provider: model.provider,
          teamId: "T1",
          timeoutMs: 1,
        }),
      },
    ]);
  });

  it("rejects invalid tool output", async () => {
    const registry = new AgentToolRegistry([
      {
        description: "Return invalid data.",
        execute: async () => ({ echoed: 123 }),
        name: "echo",
        outputSchema: z.object({ echoed: z.string() }) as never,
        parameters: { type: "object" },
        schema: z.object({ text: z.string() }) as never,
      },
    ]);
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: new FakeProviderRouter({
        content: "done",
        toolCalls: [{ input: { text: "ok" }, toolCallId: "call-1", toolName: "echo" }],
      }),
      toolRegistry: registry,
    });

    await expect(
      runner.run({
        channelId: "C1",
        messageTs: "1.0",
        teamId: "T1",
        text: "echo",
        userId: "U1",
      }),
    ).rejects.toThrow("Invalid output from agent tool");
  });

  it("wraps default model lookup failures with attempted model id", async () => {
    const runner = new AgentRunner({
      defaultModelId: "missing:default-model",
      providerRouter: new FakeProviderRouter({ content: "will not run" }),
    });

    await expect(
      runner.run({
        channelId: "C1",
        messageTs: "1.0",
        teamId: "T1",
        text: "hello",
        userId: "U1",
      }),
    ).rejects.toMatchObject({
      model: { id: "missing:default-model" },
    });
  });

  it("preserves Slack thread history roles before provider invocation", async () => {
    const router = new FakeProviderRouter({
      content: "thread aware",
    });
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: router,
    });

    await runner.run({
      channelId: "C1",
      messageTs: "2.0",
      teamId: "T1",
      text: "continue",
      threadHistory: [
        {
          messageTs: "1.0",
          role: "user",
          teamId: "T1",
          text: "root question",
          userId: "U1",
        },
        {
          botId: "BAPP",
          messageTs: "1.1",
          role: "assistant",
          teamId: "T1",
          text: "previous answer",
        },
      ],
      userId: "U1",
    });

    expect(router.requests[0]?.history.messages.slice(0, 2)).toEqual([
      expect.objectContaining({
        author: { id: "slack:T1:U1", kind: "user" },
        role: "user",
        content: [{ text: "root question", type: "text" }],
      }),
      expect.objectContaining({
        role: "assistant",
        content: [{ text: "previous answer", type: "text" }],
      }),
    ]);
  });
});

class FakeProviderRouter {
  readonly registry = new ModelRegistry([model, explicitModel, textOnlyModel, thinkingModel]);
  readonly requests: LlmRequest[] = [];
  streamEvents: LlmStreamEvent[] = [];

  constructor(private readonly result: LlmResult) {}

  async generate(request: LlmRequest): Promise<LlmResult> {
    this.requests.push(request);
    return this.result;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    this.requests.push(request);
    for (const event of this.streamEvents) {
      yield event;
    }
  }
}

class SequencedProviderRouter {
  readonly registry = new ModelRegistry([model, explicitModel, textOnlyModel, thinkingModel]);
  readonly requests: LlmRequest[] = [];

  constructor(private readonly results: LlmResult[]) {}

  async generate(request: LlmRequest): Promise<LlmResult> {
    this.requests.push(request);
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error("No fake result configured.");
    }
    return result;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    this.requests.push(request);
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error("No fake result configured.");
    }
    yield { result, type: "done" };
  }
}

function readText(value: JsonValue): string {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const text = value.text;
    if (typeof text === "string") {
      return text;
    }
  }
  throw new Error("Expected text input.");
}
