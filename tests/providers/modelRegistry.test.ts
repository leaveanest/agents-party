import { describe, expect, it } from "vite-plus/test";

import {
  createDefaultModelRegistry,
  MissingModelCapabilityError,
  ModelRegistry,
  UnknownModelError,
} from "../../src/providers/modelRegistry.js";

describe("ModelRegistry", () => {
  it("registers every target provider in the default capability matrix", () => {
    const registry = createDefaultModelRegistry();

    expect(registry.list("openai")).not.toHaveLength(0);
    expect(registry.list("azure_openai")).not.toHaveLength(0);
    expect(registry.list("anthropic")).not.toHaveLength(0);
    expect(registry.list("google")).not.toHaveLength(0);
    expect(registry.list("bedrock")).not.toHaveLength(0);
    expect(registry.list("groq")).not.toHaveLength(0);
    expect(registry.list("nvidia")).not.toHaveLength(0);
    expect(registry.list("plamo")).not.toHaveLength(0);
    expect(registry.list("xai")).not.toHaveLength(0);
    expect(registry.list("dify")).not.toHaveLength(0);
    expect(registry.list("litellm")).not.toHaveLength(0);
  });

  it("resolves legacy model aliases to explicit provider records", () => {
    const registry = createDefaultModelRegistry();

    expect(registry.get("gpt-4o")).toMatchObject({
      id: "openai:gpt-4o",
      provider: "openai",
      providerModelId: "gpt-4o",
    });
    expect(registry.get("azure.gpt-4o")).toMatchObject({
      id: "azure_openai:gpt-4o",
      provider: "azure_openai",
    });
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
});
