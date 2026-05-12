import { describe, expect, it } from "vite-plus/test";

import { AgentRunner, AgentRunnerExecutionError } from "../../src/agents/runner.js";
import {
  createGoogleMapsRuntime,
  createImageGenerationRuntime,
  createVideoGenerationRuntime,
  createWebResearchRuntime,
} from "../../src/agents/specialistRuntimes.js";
import type { LlmRequest, LlmResult, ModelInfo } from "../../src/providers/contracts.js";
import { ModelRegistry } from "../../src/providers/modelRegistry.js";

const model: ModelInfo = {
  capabilities: ["text", "web_search"],
  id: "google:gemini-2.5-flash",
  provider: "google",
  providerModelId: "gemini-2.5-flash",
};
const imageModel: ModelInfo = {
  capabilities: ["image_generation"],
  id: "google:gemini-2.5-flash-image",
  provider: "google",
  providerModelId: "gemini-2.5-flash-image",
};
const videoModel: ModelInfo = {
  capabilities: ["video_generation"],
  id: "google:veo-3.1-fast-generate-001",
  provider: "google",
  providerModelId: "veo-3.1-fast-generate-001",
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
    expect(router.requests[0]?.context).toEqual({ workspaceId: "T1" });
    expect(result.message).toContain("Official: https://example.com/source");
    expect(result.structuredResult).toMatchObject({
      action: "answered",
      answer: "Verified answer",
    });
  });

  it("returns typed Google Maps results from the maps gateway", async () => {
    const runtime = createGoogleMapsRuntime({
      async computeRoute() {
        throw new Error("Unexpected route call.");
      },
      async searchNearby() {
        throw new Error("Unexpected nearby call.");
      },
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

  it("returns typed route results from the maps gateway for route requests", async () => {
    const runtime = createGoogleMapsRuntime({
      async computeRoute(input) {
        return {
          destination: input.destination,
          durationSeconds: 900,
          googleMapsUri: "https://www.google.com/maps/dir/?api=1",
          origin: input.origin,
          travelMode: input.travelMode ?? "driving",
        };
      },
      async searchNearby() {
        throw new Error("Unexpected nearby call.");
      },
      async searchPlaces() {
        throw new Error("Unexpected place call.");
      },
    });

    const result = await runtime({
      invocation: invocation("route from Tokyo Station to Osaka Station"),
      model,
      providerRouter: new FakeProviderRouter({ content: "" }),
    });

    expect(result.structuredResult).toMatchObject({
      action: "answered",
      route: { destination: "Osaka Station", origin: "Tokyo Station" },
    });
  });

  it("returns typed media handoffs for image and video generation", async () => {
    const mediaGateway = {
      async generateImage() {
        return { dataBase64: "aW1hZ2U=", mimeType: "image/png" };
      },
      async generateVideo() {
        return { operationName: "operations/video-1", status: "in_progress" as const };
      },
    };
    const image = await createImageGenerationRuntime(
      imageModel.id,
      mediaGateway,
    )({
      invocation: invocation("draw a product sketch"),
      model,
      providerRouter: new FakeProviderRouter({ content: "" }),
    });
    const video = await createVideoGenerationRuntime(
      videoModel.id,
      mediaGateway,
    )({
      invocation: invocation("make a vertical video"),
      model,
      providerRouter: new FakeProviderRouter({ content: "" }),
    });

    expect(image.structuredResult).toMatchObject({
      action: "generated",
      media: { dataBase64: "aW1hZ2U=", kind: "image", status: "generated" },
    });
    expect(image.model).toEqual({ id: "google:gemini-2.5-flash-image", provider: "google" });
    expect(video.structuredResult).toMatchObject({
      action: "in_progress",
      media: {
        aspectRatio: "9:16",
        kind: "video",
        operationName: "operations/video-1",
        status: "in_progress",
      },
    });
    expect(video.model).toEqual({ id: "google:veo-3.1-fast-generate-001", provider: "google" });
  });

  it("resolves native specialist gateways from the Slack team context", async () => {
    const teams: string[] = [];
    const runtime = createImageGenerationRuntime(imageModel.id, async ({ teamId }) => {
      teams.push(teamId);
      return {
        async generateImage() {
          return { dataBase64: "aW1hZ2U=", mimeType: "image/png" };
        },
        async generateVideo() {
          throw new Error("Unexpected video generation call.");
        },
      };
    });

    const result = await runtime({
      invocation: invocation("draw an image"),
      model,
      providerRouter: new FakeProviderRouter({ content: "" }),
    });

    expect(teams).toEqual(["T1"]);
    expect(result.structuredResult).toMatchObject({
      action: "generated",
      media: { dataBase64: "aW1hZ2U=", kind: "image" },
    });
  });

  it("parses Japanese route requests into Google Maps route calls", async () => {
    const calls: unknown[] = [];
    const runtime = createGoogleMapsRuntime({
      async computeRoute(input) {
        calls.push(input);
        return {
          destination: input.destination,
          origin: input.origin,
          travelMode: input.travelMode ?? "driving",
        };
      },
      async searchNearby() {
        throw new Error("Unexpected nearby call.");
      },
      async searchPlaces() {
        throw new Error("Unexpected place call.");
      },
    });

    await runtime({
      invocation: invocation("東京駅から大阪駅への経路"),
      model,
      providerRouter: new FakeProviderRouter({ content: "" }),
    });

    expect(calls).toEqual([expect.objectContaining({ destination: "大阪駅", origin: "東京駅" })]);
  });

  it("AgentRunner dispatches configured native specialist runtimes before generic prompts", async () => {
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: new FakeProviderRouter({ content: "generic should not run" }),
      specialistRuntimes: {
        google_maps: createGoogleMapsRuntime({
          async computeRoute() {
            throw new Error("Unexpected route call.");
          },
          async searchNearby() {
            throw new Error("Unexpected nearby call.");
          },
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
    expect(result.model).toBeUndefined();
  });

  it("AgentRunner reports the actual model used by native media runtimes", async () => {
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: new FakeProviderRouter({ content: "generic should not run" }),
      specialistRuntimes: {
        image_generation: createImageGenerationRuntime(imageModel.id, {
          async generateImage() {
            return { dataBase64: "aW1hZ2U=", mimeType: "image/png" };
          },
          async generateVideo() {
            throw new Error("Unexpected video generation call.");
          },
        }),
      },
    });

    const result = await runner.run({
      channelId: "C1",
      messageTs: "1.0",
      teamId: "T1",
      text: "draw an image",
      userId: "U1",
    });

    expect(result.model).toEqual({ id: "google:gemini-2.5-flash-image", provider: "google" });
  });

  it("AgentRunner wraps native media failures with attempted specialist and model context", async () => {
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: new FakeProviderRouter({ content: "generic should not run" }),
      specialistRuntimes: {
        image_generation: createImageGenerationRuntime(imageModel.id, {
          async generateImage() {
            throw new Error("provider failed");
          },
          async generateVideo() {
            throw new Error("Unexpected video generation call.");
          },
        }),
      },
    });

    await expect(
      runner.run({
        channelId: "C1",
        messageTs: "1.0",
        teamId: "T1",
        text: "draw an image",
        userId: "U1",
      }),
    ).rejects.toMatchObject({
      model: { id: "google:gemini-2.5-flash-image", provider: "google" },
      specialist: "image_generation",
    });
    await expect(
      runner.run({
        channelId: "C1",
        messageTs: "1.0",
        teamId: "T1",
        text: "draw an image",
        userId: "U1",
      }),
    ).rejects.toBeInstanceOf(AgentRunnerExecutionError);
  });

  it("AgentRunner wraps native structured-result failures with attempted model context", async () => {
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: new FakeProviderRouter({
        content: JSON.stringify({ action: "invalid", answer: "bad" }),
      }),
      specialistRuntimes: {
        web_research: createWebResearchRuntime(),
      },
    });

    await expect(
      runner.run({
        channelId: "C1",
        messageTs: "1.0",
        teamId: "T1",
        text: "research this",
        userId: "U1",
      }),
    ).rejects.toMatchObject({
      model: { id: "google:gemini-2.5-flash", provider: "google" },
      specialist: "web_research",
    });
  });

  it("AgentRunner wraps native media capability failures with attempted model context", async () => {
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: new FakeProviderRouter({ content: "generic should not run" }),
      specialistRuntimes: {
        image_generation: createImageGenerationRuntime(model.id, {
          async generateImage() {
            throw new Error("Unexpected generation call.");
          },
          async generateVideo() {
            throw new Error("Unexpected video generation call.");
          },
        }),
      },
    });

    await expect(
      runner.run({
        channelId: "C1",
        messageTs: "1.0",
        teamId: "T1",
        text: "draw an image",
        userId: "U1",
      }),
    ).rejects.toMatchObject({
      model: { id: "google:gemini-2.5-flash", provider: "google" },
      specialist: "image_generation",
    });
  });

  it("AgentRunner wraps missing native media model failures with attempted model id", async () => {
    const runner = new AgentRunner({
      defaultModelId: model.id,
      providerRouter: new FakeProviderRouter({ content: "generic should not run" }),
      specialistRuntimes: {
        image_generation: createImageGenerationRuntime("missing:image-model", {
          async generateImage() {
            throw new Error("Unexpected generation call.");
          },
          async generateVideo() {
            throw new Error("Unexpected video generation call.");
          },
        }),
      },
    });

    await expect(
      runner.run({
        channelId: "C1",
        messageTs: "1.0",
        teamId: "T1",
        text: "draw an image",
        userId: "U1",
      }),
    ).rejects.toMatchObject({
      model: { id: "missing:image-model" },
      specialist: "image_generation",
    });
  });
});

class FakeProviderRouter {
  readonly registry = new ModelRegistry([model, imageModel, videoModel]);
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
