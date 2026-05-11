import { describe, expect, it } from "vite-plus/test";

import { AgentRunner } from "../../src/agents/runner.js";
import {
  createGoogleMapsRuntime,
  createImageGenerationRuntime,
  createVideoGenerationRuntime,
  createWebResearchRuntime,
} from "../../src/agents/specialistRuntimes.js";
import type { LlmRequest, LlmResult, ModelInfo } from "../../src/providers/contracts.js";
import { ModelRegistry } from "../../src/providers/modelRegistry.js";

const model: ModelInfo = {
  capabilities: ["text", "web_search", "image_generation"],
  id: "google:gemini-2.5-flash",
  provider: "google",
  providerModelId: "gemini-2.5-flash",
};

describe("specialist runtimes", () => {
  it("runs web research with explicit web_search capability and typed sources", async () => {
    const router = new FakeProviderRouter({
      content: JSON.stringify({
        action: "answered",
        answer: "Verified answer",
        sources: [{ title: "Official", url: "https://example.com/source" }],
      }),
    });
    const runtime = createWebResearchRuntime();

    const result = await runtime({
      invocation: invocation("research current docs"),
      model,
      providerRouter: router,
    });

    expect(router.requests[0]?.requiredCapabilities).toEqual(["web_search"]);
    expect(result.message).toContain("Official: https://example.com/source");
    expect(result.structuredResult).toMatchObject({
      action: "answered",
      answer: "Verified answer",
    });
  });

  it("returns typed Google Maps results from the maps gateway", async () => {
    const runtime = createGoogleMapsRuntime({
      async searchPlaces() {
        return [
          {
            address: "Tokyo, Japan",
            googleMapsUri: "https://maps.google.com/?cid=1",
            name: "Tokyo Station",
            placeId: "place-1",
          },
        ];
      },
    });

    const result = await runtime({
      invocation: invocation("Tokyo Station"),
      model,
      providerRouter: new FakeProviderRouter({ content: "" }),
    });

    expect(result.message).toContain("Tokyo Station");
    expect(result.structuredResult).toMatchObject({
      action: "answered",
      places: [expect.objectContaining({ name: "Tokyo Station" })],
    });
  });

  it("returns typed media handoffs for image and video generation", async () => {
    const image = await createImageGenerationRuntime()({
      invocation: invocation("draw a product sketch"),
      model,
      providerRouter: new FakeProviderRouter({ content: "" }),
    });
    const video = await createVideoGenerationRuntime()({
      invocation: invocation("make a vertical video"),
      model,
      providerRouter: new FakeProviderRouter({ content: "" }),
    });

    expect(image.structuredResult).toMatchObject({
      action: "media_handoff",
      media: { kind: "image", status: "ready_for_native_generation" },
    });
    expect(video.structuredResult).toMatchObject({
      action: "media_handoff",
      media: { aspectRatio: "9:16", kind: "video", status: "ready_for_native_generation" },
    });
  });

  it("AgentRunner dispatches configured native specialist runtimes before generic prompts", async () => {
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: new FakeProviderRouter({ content: "generic should not run" }),
      specialistRuntimes: {
        google_maps: createGoogleMapsRuntime({
          async searchPlaces() {
            return [{ name: "Osaka Station" }];
          },
        }),
      },
    });

    const result = await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      teamId: "T1",
      text: "map Osaka Station",
      userId: "U1",
    });

    expect(result.structuredResult).toMatchObject({
      places: [expect.objectContaining({ name: "Osaka Station" })],
    });
  });
});

class FakeProviderRouter {
  readonly registry = new ModelRegistry([model]);
  readonly requests: LlmRequest[] = [];

  constructor(private readonly result: LlmResult) {}

  async generate(request: LlmRequest): Promise<LlmResult> {
    this.requests.push(request);
    return this.result;
  }
}

function invocation(text: string) {
  return {
    channelId: "C1",
    messageTs: "1.0",
    referenceImages: [],
    teamId: "T1",
    text,
    threadMessages: [],
    userId: "U1",
    viewerContextChannelIds: ["C1"],
  };
}
