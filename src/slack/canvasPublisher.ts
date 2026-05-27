import { ErrorCode } from "@slack/web-api";
import type { WebClient } from "@slack/web-api";

export type SlackCanvasPublisherClient = Pick<WebClient, "canvases">;

export type GeneratedCanvas = {
  markdown: string;
  title: string;
};

export type PublishedCanvas = {
  canvasId: string;
};

export class SlackCanvasPublishError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "SlackCanvasPublishError";
  }
}

export async function publishGeneratedCanvas(input: {
  canvas: GeneratedCanvas;
  channelId: string;
  client: SlackCanvasPublisherClient;
  teamId: string;
  threadTs: string;
}): Promise<PublishedCanvas> {
  try {
    const response = await input.client.canvases.create({
      channel_id: input.channelId,
      document_content: {
        markdown: input.canvas.markdown,
        type: "markdown",
      },
      title: input.canvas.title,
    });
    const canvasId = readCanvasId(response);
    if (canvasId === undefined) {
      throw new SlackCanvasPublishError(
        "missing_canvas_id",
        "Slack created the Canvas but did not return a Canvas id.",
      );
    }
    return { canvasId };
  } catch (error) {
    if (error instanceof SlackCanvasPublishError) {
      throw error;
    }
    const code = slackWebApiErrorCode(error) ?? "canvas_publish_failed";
    throw new SlackCanvasPublishError(code, "Slack Canvas publish failed.", {
      cause: error,
    });
  }
}

function readCanvasId(response: { canvas_id?: unknown }): string | undefined {
  const canvasId = response.canvas_id;
  return typeof canvasId === "string" && canvasId.length > 0 ? canvasId : undefined;
}

function slackWebApiErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  if (error.code === ErrorCode.PlatformError && isRecord(error.data)) {
    const code = error.data.error;
    return typeof code === "string" && code.length > 0 ? code : undefined;
  }
  if (error.code === ErrorCode.RateLimitedError) {
    return "rate_limited";
  }
  const code = error.code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
