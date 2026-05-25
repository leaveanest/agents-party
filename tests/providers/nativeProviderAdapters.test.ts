import { describe, expect, it } from "vite-plus/test";

import type { ConversationHistory } from "../../src/domain/messageHistory.js";
import type { LlmAdapter } from "../../src/providers/contracts.js";
import { createAiSdkAdapters } from "../../src/providers/aiSdkAdapter.js";
import { ModelRegistry } from "../../src/providers/modelRegistry.js";
import {
  createNativeProviderAdapters,
  NativeProviderUnsupportedError,
  UnsupportedNativeProviderAdapter,
} from "../../src/providers/nativeProviderAdapters.js";
import {
  NoProviderAdapterForCapabilitiesError,
  ProviderRouter,
} from "../../src/providers/providerRouter.js";

const history: ConversationHistory = {
  messages: [],
};

const fileHistory: ConversationHistory = {
  messages: [
    {
      author: { id: "U1", kind: "user" },
      content: [
        {
          filename: "brief.pdf",
          id: "file-1",
          mediaType: "application/pdf",
          source: { data: new Uint8Array([1]), type: "bytes" },
          type: "file",
        },
      ],
      id: "message-1",
      role: "user",
    },
  ],
};

describe("native provider adapters", () => {
  it("routes native-only capabilities away from the common adapter", async () => {
    let commonAdapterCalled = false;
    const commonAdapter: LlmAdapter = {
      async generate() {
        commonAdapterCalled = true;
        return { content: "common" };
      },
      provider: "openai",
      supports(_request, requiredCapabilities) {
        return !requiredCapabilities.includes("image_generation");
      },
    };
    const nativeAdapter = new UnsupportedNativeProviderAdapter({
      capabilities: ["text", "image_generation"],
      provider: "openai",
      reason: "Native image generation is not implemented in this test.",
    });
    const router = new ProviderRouter([commonAdapter, nativeAdapter], registry());
    const model = router.resolveModel({ workspaceModelId: "openai:gpt-image-1.5" }, [
      "image_generation",
    ]).model;

    await expect(
      router.generate({
        history,
        model,
        requiredCapabilities: ["image_generation"],
      }),
    ).rejects.toThrow(NativeProviderUnsupportedError);
    expect(commonAdapterCalled).toBe(false);
  });

  it("fails clearly when capability routing has no matching adapter", async () => {
    const commonAdapter: LlmAdapter = {
      async generate() {
        return { content: "common" };
      },
      provider: "openai",
      supports(_request, requiredCapabilities) {
        return !requiredCapabilities.includes("image_generation");
      },
    };
    const router = new ProviderRouter([commonAdapter], registry());
    const model = router.resolveModel({ workspaceModelId: "openai:gpt-image-1.5" }, [
      "image_generation",
    ]).model;

    await expect(
      router.generate({
        history,
        model,
        requiredCapabilities: ["image_generation"],
      }),
    ).rejects.toThrow(NoProviderAdapterForCapabilitiesError);
  });

  it("creates explicit native stubs for provider-specific escape hatches", () => {
    const adapters = createNativeProviderAdapters();

    expect(adapters.map((adapter) => adapter.provider)).toEqual([
      "openai",
      "anthropic",
      "google",
      "dify",
    ]);
  });

  it("routes Gemini web search through the common adapter", async () => {
    let commonAdapterCalled = false;
    const commonAdapter: LlmAdapter = {
      async generate() {
        commonAdapterCalled = true;
        return { content: "common" };
      },
      provider: "google",
      supports(_request, requiredCapabilities) {
        return !requiredCapabilities.includes("file_input");
      },
    };
    const router = new ProviderRouter(
      [...createNativeProviderAdapters(), commonAdapter],
      new ModelRegistry([
        {
          capabilities: ["text", "streaming", "web_search"],
          id: "google:gemini-2.5-flash",
          provider: "google",
          providerModelId: "gemini-2.5-flash",
        },
      ]),
    );
    const model = router.resolveModel({ workspaceModelId: "google:gemini-2.5-flash" }, [
      "web_search",
    ]).model;

    await expect(
      router.generate({
        history,
        model,
        requiredCapabilities: ["web_search"],
      }),
    ).resolves.toEqual({ content: "common" });
    expect(commonAdapterCalled).toBe(true);
  });

  it("routes Gemini file input to the native stub with common adapters registered first", async () => {
    const router = new ProviderRouter(
      [...createAiSdkAdapters(), ...createNativeProviderAdapters()],
      new ModelRegistry([
        {
          capabilities: ["text", "streaming", "file_input"],
          id: "google:gemini-2.5-flash",
          provider: "google",
          providerModelId: "gemini-2.5-flash",
        },
      ]),
    );
    const model = router.resolveModel({ workspaceModelId: "google:gemini-2.5-flash" }).model;

    await expect(
      router.generate({
        history: fileHistory,
        model,
      }),
    ).rejects.toThrow(NativeProviderUnsupportedError);
  });
});

function registry(): ModelRegistry {
  return new ModelRegistry([
    {
      capabilities: ["text", "image_generation"],
      id: "openai:gpt-image-1.5",
      provider: "openai",
      providerModelId: "gpt-image-1.5",
    },
  ]);
}
