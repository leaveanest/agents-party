import { describe, expect, it } from "vite-plus/test";

import type { ConversationHistory } from "../../src/domain/messageHistory.js";
import type { LlmAdapter } from "../../src/providers/contracts.js";
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
        return !requiredCapabilities.includes("web_search");
      },
    };
    const nativeAdapter = new UnsupportedNativeProviderAdapter({
      capabilities: ["web_search"],
      provider: "openai",
      reason: "Native web search is not implemented in this test.",
    });
    const router = new ProviderRouter([commonAdapter, nativeAdapter], registry());
    const model = router.resolveModel({ workspaceModelId: "openai:gpt-4o" }, ["web_search"]).model;

    await expect(
      router.generate({
        history,
        model,
        requiredCapabilities: ["web_search"],
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
        return !requiredCapabilities.includes("web_search");
      },
    };
    const router = new ProviderRouter([commonAdapter], registry());
    const model = router.resolveModel({ workspaceModelId: "openai:gpt-4o" }, ["web_search"]).model;

    await expect(
      router.generate({
        history,
        model,
        requiredCapabilities: ["web_search"],
      }),
    ).rejects.toThrow(NoProviderAdapterForCapabilitiesError);
  });

  it("creates explicit native stubs for provider-specific escape hatches", () => {
    const adapters = createNativeProviderAdapters();

    expect(adapters.map((adapter) => adapter.provider)).toEqual([
      "openai",
      "anthropic",
      "google",
      "bedrock",
      "dify",
    ]);
  });
});

function registry(): ModelRegistry {
  return new ModelRegistry([
    {
      capabilities: ["text", "streaming", "web_search"],
      id: "openai:gpt-4o",
      provider: "openai",
      providerModelId: "gpt-4o",
    },
  ]);
}
