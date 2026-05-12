import { describe, expect, it } from "vite-plus/test";

import {
  SLACK_AUDIO_MAX_BYTES,
  SlackAudioProcessingError,
  collectSlackAudioMetadata,
  hasSlackAudioFiles,
  resolveSlackAudioAttachments,
} from "../../src/slack/audioTranscription.js";

describe("Slack audio transcription helpers", () => {
  it("discovers minimal audio metadata from Slack messages", () => {
    const messages = [
      {
        files: [
          {
            id: "F1",
            mimetype: "audio/mpeg",
            name: "voice.mp3",
            size: 12,
            url_private_download: "https://files.slack.com/files-pri/T-F1/download/voice.mp3",
          },
          {
            id: "F2",
            mimetype: "image/png",
            url_private_download: "https://files.slack.com/files-pri/T-F2/download/image.png",
          },
        ],
        ts: "1712345678.000100",
      },
    ];

    expect(collectSlackAudioMetadata(messages)).toEqual([
      {
        downloadUrl: "https://files.slack.com/files-pri/T-F1/download/voice.mp3",
        filename: "voice.mp3",
        id: "F1",
        mediaType: "audio/mpeg",
        messageTs: "1712345678.000100",
        sizeBytes: 12,
      },
    ]);
    expect(hasSlackAudioFiles(messages[0] ?? {})).toBe(true);
  });

  it("downloads bytes and returns only transient transcript context", async () => {
    const attachments = await resolveSlackAudioAttachments({
      clientToken: "xoxb-token",
      fetchFn: async (_url, init) => {
        expect(init?.headers).toEqual({ authorization: "Bearer xoxb-token" });
        return new Response(new Uint8Array([1, 2, 3]));
      },
      messages: [
        {
          files: [
            {
              id: "F1",
              mimetype: "audio/mpeg",
              name: "voice.mp3",
              size: 3,
              url_private_download: "https://files.slack.com/files-pri/T-F1/download/voice.mp3",
            },
          ],
          ts: "1712345678.000100",
        },
      ],
      teamId: "T1",
      transcriptionGateway: {
        async transcribe(request) {
          expect(request.audio).toEqual(new Uint8Array([1, 2, 3]));
          expect(request.context).toEqual({ workspaceId: "T1" });
          return { provider: "google", text: "transcript text" };
        },
      },
    });

    expect(attachments).toEqual([
      {
        filename: "voice.mp3",
        id: "F1",
        kind: "audio",
        mediaType: "audio/mpeg",
        messageTs: "1712345678.000100",
        transcript: "transcript text",
      },
    ]);
  });

  it("rejects oversized audio before downloading", async () => {
    await expect(
      resolveSlackAudioAttachments({
        clientToken: "xoxb-token",
        fetchFn: async () => {
          throw new Error("Unexpected download.");
        },
        messages: [
          {
            files: [
              {
                id: "F1",
                mimetype: "audio/mpeg",
                size: SLACK_AUDIO_MAX_BYTES + 1,
                url_private_download: "https://files.slack.com/files-pri/T-F1/download/voice.mp3",
              },
            ],
            ts: "1712345678.000100",
          },
        ],
        teamId: "T1",
        transcriptionGateway: {
          async transcribe() {
            throw new Error("Unexpected transcription.");
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "oversized",
      name: "SlackAudioProcessingError",
    } satisfies Partial<SlackAudioProcessingError>);
  });

  it("rejects unsupported audio MIME types", async () => {
    await expect(
      resolveSlackAudioAttachments({
        clientToken: "xoxb-token",
        messages: [
          {
            files: [
              {
                id: "F1",
                mimetype: "audio/mp4",
                size: 12,
                url_private_download: "https://files.slack.com/files-pri/T-F1/download/voice.m4a",
              },
            ],
            ts: "1712345678.000100",
          },
        ],
        teamId: "T1",
        transcriptionGateway: {
          async transcribe() {
            throw new Error("Unexpected transcription.");
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "unsupported",
      name: "SlackAudioProcessingError",
    } satisfies Partial<SlackAudioProcessingError>);
  });
});
