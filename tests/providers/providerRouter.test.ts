import { describe, expect, it } from "vite-plus/test";

import type { ConversationHistory } from "../../src/domain/messageHistory.js";
import type { LlmAdapter, LlmRequest } from "../../src/providers/contracts.js";
import {
  MissingProviderAdapterError,
  ModelResolutionError,
  ProviderRouter,
} from "../../src/providers/providerRouter.js";
import { MissingModelCapabilityError, ModelRegistry } from "../../src/providers/modelRegistry.js";

const emptyHistory: ConversationHistory = {
  messages: [],
};

const imageHistory: ConversationHistory = {
  messages: [
    {
      author: { id: "U1", kind: "user" },
      content: [
        {
          id: "image-1",
          mediaType: "image/png",
          source: { type: "url", url: "https://example.com/image.png" },
          type: "image",
        },
      ],
      id: "message-1",
      role: "user",
    },
  ],
};

describe("ProviderRouter", () => {
  it("resolves configured models with thread, channel, then workspace precedence", () => {
    const router = new ProviderRouter([], registry());

    expect(
      router.resolveModel({
        channelModelId: "example:channel",
        threadModelId: "example:thread",
        workspaceModelId: "example:workspace",
      }),
    ).toMatchObject({
      model: { id: "example:thread" },
      source: "thread",
    });

    expect(
      router.resolveModel({
        channelModelId: "example:channel",
        workspaceModelId: "example:workspace",
      }),
    ).toMatchObject({
      model: { id: "example:channel" },
      source: "channel",
    });

    expect(router.resolveModel({ workspaceModelId: "example:workspace" })).toMatchObject({
      model: { id: "example:workspace" },
      source: "workspace",
    });
  });

  it("requires an explicit configured model", () => {
    const router = new ProviderRouter([], registry());

    expect(() => router.resolveModel({})).toThrow(ModelResolutionError);
  });

  it("checks requested capabilities before invoking the adapter", async () => {
    const adapter = recordingAdapter();
    const router = new ProviderRouter([adapter], registry());
    const model = router.resolveModel({ workspaceModelId: "example:text-only" }).model;

    await expect(
      router.generate({
        history: imageHistory,
        model,
      }),
    ).rejects.toThrow(MissingModelCapabilityError);
    expect(adapter.requests).toHaveLength(0);
  });

  it("routes generation to the provider adapter after capability checks", async () => {
    const adapter = recordingAdapter();
    const router = new ProviderRouter([adapter], registry());
    const model = router.resolveModel(
      {
        workspaceModelId: "example:multimodal",
      },
      ["tool_calling"],
    ).model;

    const result = await router.generate({
      history: emptyHistory,
      model,
      tools: [{ name: "search" }],
    });

    expect(result.content).toBe("ok");
    expect(adapter.requests).toHaveLength(1);
  });

  it("fails when a model provider has no adapter", async () => {
    const router = new ProviderRouter([], registry());
    const model = router.resolveModel({ workspaceModelId: "example:multimodal" }).model;

    await expect(
      router.generate({
        history: emptyHistory,
        model,
      }),
    ).rejects.toThrow(MissingProviderAdapterError);
  });
});

function registry(): ModelRegistry {
  return new ModelRegistry([
    {
      capabilities: ["text"],
      id: "example:text-only",
      provider: "openai",
      providerModelId: "text-only",
    },
    {
      capabilities: ["text", "streaming", "image_input", "tool_calling"],
      id: "example:workspace",
      provider: "openai",
      providerModelId: "workspace",
    },
    {
      capabilities: ["text", "streaming", "image_input", "tool_calling"],
      id: "example:channel",
      provider: "openai",
      providerModelId: "channel",
    },
    {
      capabilities: ["text", "streaming", "image_input", "tool_calling"],
      id: "example:thread",
      provider: "openai",
      providerModelId: "thread",
    },
    {
      capabilities: ["text", "streaming", "image_input", "tool_calling"],
      id: "example:multimodal",
      provider: "openai",
      providerModelId: "multimodal",
    },
  ]);
}

function recordingAdapter(): LlmAdapter & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    async generate(request: LlmRequest) {
      requests.push(request);
      return { content: "ok" };
    },
    provider: "openai",
    requests,
  };
}
