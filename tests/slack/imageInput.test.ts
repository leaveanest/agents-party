import { describe, expect, it } from "vite-plus/test";
import sharp from "sharp";

import {
  SLACK_IMAGE_DOWNLOAD_MAX_BYTES,
  SLACK_IMAGE_MAX_BYTES,
  SlackImageProcessingError,
  collectSlackImageMetadata,
  hasSlackImageFiles,
  resolveSlackImageAttachments,
} from "../../src/slack/imageInput.js";

const SMALL_PNG_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  ),
);

describe("Slack image input helpers", () => {
  it("discovers minimal image metadata from Slack messages", () => {
    const messages = [
      {
        files: [
          {
            id: "F1",
            mimetype: "image/png",
            name: "chart.png",
            size: 12,
            url_private_download: "https://files.slack.com/files-pri/T-F1/download/chart.png",
          },
          {
            id: "F2",
            mimetype: "application/pdf",
            url_private_download: "https://files.slack.com/files-pri/T-F2/download/brief.pdf",
          },
        ],
        ts: "1712345678.000100",
      },
    ];

    expect(collectSlackImageMetadata(messages)).toEqual([
      {
        downloadUrl: "https://files.slack.com/files-pri/T-F1/download/chart.png",
        filename: "chart.png",
        id: "F1",
        mediaType: "image/png",
        messageTs: "1712345678.000100",
        sizeBytes: 12,
      },
    ]);
    expect(hasSlackImageFiles(messages[0] ?? {})).toBe(true);
  });

  it("downloads Slack private images into transient reference image bytes", async () => {
    const attachments = await resolveSlackImageAttachments({
      clientToken: "xoxb-token",
      fetchFn: async (_url, init) => {
        expect(init?.headers).toEqual({ authorization: "Bearer xoxb-token" });
        return new Response(SMALL_PNG_BYTES);
      },
      messages: [
        {
          files: [
            {
              id: "F1",
              mimetype: "image/png",
              name: "chart.png",
              size: 3,
              url_private_download: "https://files.slack.com/files-pri/T-F1/download/chart.png",
            },
          ],
          ts: "1712345678.000100",
        },
      ],
    });

    expect(attachments).toEqual([
      {
        data: SMALL_PNG_BYTES,
        identifier: "F1",
        mediaType: "image/png",
        messageTs: "1712345678.000100",
      },
    ]);
  });

  it("normalizes Slack jpg image MIME types to provider-safe jpeg", () => {
    expect(
      collectSlackImageMetadata([
        {
          files: [
            {
              id: "F1",
              mimetype: "image/jpg",
              url_private_download: "https://files.slack.com/files-pri/T-F1/download/photo.jpg",
            },
          ],
          ts: "1712345678.000100",
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: "F1",
        mediaType: "image/jpeg",
      }),
    ]);
  });

  it("does not reject provider-oversized image metadata before downloading", async () => {
    const png = await sharp({
      create: {
        background: "#ffffff",
        channels: 3,
        height: 1,
        width: 1,
      },
    })
      .png()
      .toBuffer();
    let downloads = 0;
    const attachments = await resolveSlackImageAttachments({
      clientToken: "xoxb-token",
      fetchFn: async () => {
        downloads += 1;
        return new Response(png);
      },
      messages: [
        {
          files: [
            {
              id: "F1",
              mimetype: "image/png",
              size: SLACK_IMAGE_MAX_BYTES + 1,
              url_private_download: "https://files.slack.com/files-pri/T-F1/download/chart.png",
            },
          ],
          ts: "1712345678.000100",
        },
      ],
    });

    expect(downloads).toBe(1);
    expect(attachments).toEqual([
      expect.objectContaining({
        data: new Uint8Array(png),
        mediaType: "image/png",
      }),
    ]);
  });

  it("resizes downloaded images that exceed the provider byte limit", async () => {
    const imageBytes = await createNoisyPng(2048, 2048);
    expect(imageBytes.byteLength).toBeGreaterThan(SLACK_IMAGE_MAX_BYTES);

    const attachments = await resolveSlackImageAttachments({
      clientToken: "xoxb-token",
      fetchFn: async () => new Response(imageBytes),
      messages: [
        {
          files: [
            {
              id: "F1",
              mimetype: "image/png",
              size: imageBytes.byteLength,
              url_private_download: "https://files.slack.com/files-pri/T-F1/download/chart.png",
            },
          ],
          ts: "1712345678.000100",
        },
      ],
    });

    expect(attachments).toEqual([
      expect.objectContaining({
        identifier: "F1",
        mediaType: "image/jpeg",
        messageTs: "1712345678.000100",
      }),
    ]);
    expect(attachments[0]?.data?.byteLength).toBeLessThanOrEqual(SLACK_IMAGE_MAX_BYTES);
  });

  it("resizes downloaded images that exceed the provider dimension target", async () => {
    const imageBytes = await sharp({
      create: {
        background: "#ffffff",
        channels: 3,
        height: 3000,
        width: 3000,
      },
    })
      .png()
      .toBuffer();
    expect(imageBytes.byteLength).toBeLessThan(SLACK_IMAGE_MAX_BYTES);

    const attachments = await resolveSlackImageAttachments({
      clientToken: "xoxb-token",
      fetchFn: async () => new Response(imageBytes),
      messages: [
        {
          files: [
            {
              id: "F1",
              mimetype: "image/png",
              size: imageBytes.byteLength,
              url_private_download: "https://files.slack.com/files-pri/T-F1/download/chart.png",
            },
          ],
          ts: "1712345678.000100",
        },
      ],
    });

    const resizedData = attachments[0]?.data;
    expect(resizedData).toBeDefined();
    if (resizedData === undefined) {
      throw new Error("Expected resized image data.");
    }
    const metadata = await sharp(resizedData).metadata();
    expect(attachments).toEqual([
      expect.objectContaining({
        identifier: "F1",
        mediaType: "image/jpeg",
      }),
    ]);
    expect(metadata.width).toBeLessThanOrEqual(2048);
    expect(metadata.height).toBeLessThanOrEqual(2048);
  });

  it("rejects images above the download hard cap before downloading", async () => {
    await expect(
      resolveSlackImageAttachments({
        clientToken: "xoxb-token",
        fetchFn: async () => {
          throw new Error("Unexpected download.");
        },
        messages: [
          {
            files: [
              {
                id: "F1",
                mimetype: "image/png",
                size: SLACK_IMAGE_DOWNLOAD_MAX_BYTES + 1,
                url_private_download: "https://files.slack.com/files-pri/T-F1/download/chart.png",
              },
            ],
            ts: "1712345678.000100",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "oversized",
      name: "SlackImageProcessingError",
    } satisfies Partial<SlackImageProcessingError>);
  });

  it("rejects images above the download hard cap from response headers", async () => {
    await expect(
      resolveSlackImageAttachments({
        clientToken: "xoxb-token",
        fetchFn: async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-length": String(SLACK_IMAGE_DOWNLOAD_MAX_BYTES + 1) },
          }),
        messages: [
          {
            files: [
              {
                id: "F1",
                mimetype: "image/png",
                url_private_download: "https://files.slack.com/files-pri/T-F1/download/chart.png",
              },
            ],
            ts: "1712345678.000100",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "oversized",
      name: "SlackImageProcessingError",
    } satisfies Partial<SlackImageProcessingError>);
  });

  it("stops reading streamed image responses above the download hard cap", async () => {
    let pulls = 0;
    await expect(
      resolveSlackImageAttachments({
        clientToken: "xoxb-token",
        fetchFn: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                pulls += 1;
                controller.enqueue(new Uint8Array(1024 * 1024));
              },
            }),
          ),
        messages: [
          {
            files: [
              {
                id: "F1",
                mimetype: "image/png",
                url_private_download: "https://files.slack.com/files-pri/T-F1/download/chart.png",
              },
            ],
            ts: "1712345678.000100",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "oversized",
      name: "SlackImageProcessingError",
    } satisfies Partial<SlackImageProcessingError>);
    expect(pulls).toBeLessThan(40);
  });

  it("rejects unsupported image MIME types", async () => {
    await expect(
      resolveSlackImageAttachments({
        clientToken: "xoxb-token",
        messages: [
          {
            files: [
              {
                id: "F1",
                mimetype: "image/svg+xml",
                size: 12,
                url_private_download: "https://files.slack.com/files-pri/T-F1/download/chart.svg",
              },
            ],
            ts: "1712345678.000100",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "unsupported",
      name: "SlackImageProcessingError",
    } satisfies Partial<SlackImageProcessingError>);
  });

  it("rejects image formats outside the cross-provider allowlist", async () => {
    await expect(
      resolveSlackImageAttachments({
        clientToken: "xoxb-token",
        messages: [
          {
            files: [
              {
                filetype: "gif",
                id: "F1",
                size: 12,
                url_private_download: "https://files.slack.com/files-pri/T-F1/download/chart.gif",
              },
            ],
            ts: "1712345678.000100",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "unsupported",
      name: "SlackImageProcessingError",
    } satisfies Partial<SlackImageProcessingError>);
  });

  it("rejects mixed supported and unsupported image inputs instead of dropping one", async () => {
    await expect(
      resolveSlackImageAttachments({
        clientToken: "xoxb-token",
        fetchFn: async () => new Response(new Uint8Array([1, 2, 3])),
        messages: [
          {
            files: [
              {
                id: "F-png",
                mimetype: "image/png",
                size: 3,
                url_private_download:
                  "https://files.slack.com/files-pri/T-F-png/download/chart.png",
              },
              {
                filetype: "gif",
                id: "F-gif",
                size: 3,
                url_private_download:
                  "https://files.slack.com/files-pri/T-F-gif/download/chart.gif",
              },
            ],
            ts: "1712345678.000100",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "unsupported",
      name: "SlackImageProcessingError",
    } satisfies Partial<SlackImageProcessingError>);
  });
});

async function createNoisyPng(width: number, height: number): Promise<Buffer> {
  const raw = new Uint8Array(width * height * 3);
  let value = 17;
  for (let index = 0; index < raw.length; index += 1) {
    value = (value * 1664525 + 1013904223) >>> 0;
    raw[index] = value >>> 24;
  }
  return sharp(raw, { raw: { channels: 3, height, width } })
    .png()
    .toBuffer();
}
