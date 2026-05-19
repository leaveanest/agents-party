import { describe, expect, it } from "vite-plus/test";

import {
  createDefaultModelRegistry,
  DuplicateModelAliasError,
  ModelAliasCollisionError,
  MissingModelCapabilityError,
  ModelRegistry,
  UnknownModelError,
} from "../../src/providers/modelRegistry.js";

describe("ModelRegistry", () => {
  it("registers active default provider entries", () => {
    const registry = createDefaultModelRegistry();

    expect(registry.list("openai")).not.toHaveLength(0);
    expect(registry.list("azure_openai")).not.toHaveLength(0);
    expect(registry.list("google")).not.toHaveLength(0);
    expect(registry.list("groq")).not.toHaveLength(0);
  });

  it("resolves legacy model aliases to explicit provider records", () => {
    const registry = createDefaultModelRegistry();

    expect(registry.get("gpt-4o")).toMatchObject({
      id: "openai:gpt-4o",
      provider: "openai",
      providerModelId: "gpt-4o",
    });
    expect(registry.get("gpt-5.5")).toMatchObject({
      capabilities: expect.arrayContaining(["structured_output", "tool_calling"]),
      id: "openai:gpt-5.5",
      provider: "openai",
      providerModelId: "gpt-5.5",
    });
    expect(registry.get("gpt-image-1.5")).toMatchObject({
      capabilities: ["image_generation"],
      id: "openai:gpt-image-1.5",
      provider: "openai",
      providerModelId: "gpt-image-1.5",
    });
    expect(registry.get("google.speech-to-text")).toMatchObject({
      capabilities: ["transcription"],
      id: "google:speech-to-text-latest-long",
      provider: "google",
      providerModelId: "latest_long",
    });
    expect(registry.get("openai.gpt-4o-mini-transcribe")).toMatchObject({
      capabilities: ["transcription"],
      id: "openai:gpt-4o-mini-transcribe",
      provider: "openai",
      providerModelId: "gpt-4o-mini-transcribe",
    });
    expect(registry.get("azure.whisper-1")).toMatchObject({
      capabilities: ["transcription"],
      id: "azure_openai:whisper-1",
      provider: "azure_openai",
      providerModelId: "whisper-1",
    });
    expect(registry.get("groq.whisper-large-v3")).toMatchObject({
      capabilities: ["transcription"],
      id: "groq:whisper-large-v3",
      provider: "groq",
      providerModelId: "whisper-large-v3",
    });
  });

  it("does not register deprecated or unsupported chat model entries", () => {
    const registry = createDefaultModelRegistry();

    for (const modelId of [
      "azure_openai:gpt-4o",
      "azure.gpt-4o",
      "anthropic:claude-3-5-sonnet-latest",
      "claude-3-5-sonnet-latest",
      "bedrock:anthropic.claude-3-5-sonnet-20240620",
      "anthropic.claude-3-5-sonnet-20240620",
      "groq:llama-3.1-70b-versatile",
      "groq.llama-3.1-70b-versatile",
      "nvidia:meta/llama-3.1-70b-instruct",
      "nvidia.meta/llama-3.1-70b-instruct",
      "plamo:plamo-beta",
      "plamo-beta",
      "xai:grok-2-latest",
      "grok-2-latest",
      "dify:chatflow",
      "dify.chatflow",
      "litellm:proxy",
      "litellm.proxy",
    ]) {
      expect(() => registry.get(modelId)).toThrow(UnknownModelError);
    }
  });

  it("does not advertise text models as direct image generation models", () => {
    const registry = createDefaultModelRegistry();

    expect(registry.get("openai:gpt-5.5").capabilities).not.toContain("image_generation");
    expect(registry.get("openai:gpt-4o").capabilities).not.toContain("image_generation");
  });

  it("rejects unknown model names instead of inferring provider from strings", () => {
    const registry = createDefaultModelRegistry();

    expect(() => registry.get("some-brand-new-model")).toThrow(UnknownModelError);
  });

  it("checks model capabilities using registry records", () => {
    const registry = new ModelRegistry([
      {
        capabilities: ["text"],
        id: "example:text-only",
        provider: "openai",
        providerModelId: "text-only",
      },
    ]);
    const model = registry.get("example:text-only");

    expect(() => registry.assertCapabilities(model, ["text"])).not.toThrow();
    expect(() => registry.assertCapabilities(model, ["image_input"])).toThrow(
      MissingModelCapabilityError,
    );
  });

  it("rejects duplicate aliases", () => {
    expect(
      () =>
        new ModelRegistry([
          {
            aliases: ["shared"],
            capabilities: ["text"],
            id: "example:first",
            provider: "openai",
            providerModelId: "first",
          },
          {
            aliases: ["shared"],
            capabilities: ["text"],
            id: "example:second",
            provider: "anthropic",
            providerModelId: "second",
          },
        ]),
    ).toThrow(DuplicateModelAliasError);
  });

  it("rejects aliases that collide with registered model ids", () => {
    const registry = new ModelRegistry([
      {
        capabilities: ["text"],
        id: "example:first",
        provider: "openai",
        providerModelId: "first",
      },
    ]);

    expect(() =>
      registry.register({
        aliases: ["example:first"],
        capabilities: ["text"],
        id: "example:second",
        provider: "anthropic",
        providerModelId: "second",
      }),
    ).toThrow(ModelAliasCollisionError);
  });

  it("rejects model ids that collide with registered aliases", () => {
    const registry = new ModelRegistry([
      {
        aliases: ["example:second"],
        capabilities: ["text"],
        id: "example:first",
        provider: "openai",
        providerModelId: "first",
      },
    ]);

    expect(() =>
      registry.register({
        capabilities: ["text"],
        id: "example:second",
        provider: "anthropic",
        providerModelId: "second",
      }),
    ).toThrow(ModelAliasCollisionError);
  });
});
