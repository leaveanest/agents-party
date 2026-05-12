import type { StringIndexed } from "@slack/bolt";

import type { TranscriptionGateway } from "../providers/transcriptionGateway.js";

export const SLACK_AUDIO_MAX_BYTES = 10 * 1024 * 1024;

export type SlackTransientAudioAttachment = {
  filename?: string;
  id: string;
  kind: "audio";
  mediaType: string;
  messageTs?: string;
  transcript?: string;
};

export type SlackAudioMetadata = {
  downloadUrl: string;
  filename?: string;
  id: string;
  mediaType: string;
  messageTs?: string;
  sizeBytes?: number;
};

export class SlackAudioProcessingError extends Error {
  constructor(
    readonly code: "download_failed" | "oversized" | "transcription_failed" | "unsupported",
  ) {
    super(userMessageForCode(code));
    this.name = "SlackAudioProcessingError";
  }
}

export type ResolveSlackAudioAttachmentsInput = {
  clientToken?: string;
  fetchFn?: typeof fetch;
  messages: readonly StringIndexed[];
  teamId: string;
  transcriptionGateway?: TranscriptionGateway;
};

export async function resolveSlackAudioAttachments(
  input: ResolveSlackAudioAttachmentsInput,
): Promise<SlackTransientAudioAttachment[]> {
  const attachments = collectSlackAudioMetadata(input.messages);
  if (attachments.length === 0) {
    if (hasUnsupportedSlackAudioFiles(input.messages)) {
      throw new SlackAudioProcessingError("unsupported");
    }
    return [];
  }
  if (input.transcriptionGateway === undefined) {
    throw new SlackAudioProcessingError("transcription_failed");
  }
  if (input.clientToken === undefined || input.clientToken.trim() === "") {
    throw new SlackAudioProcessingError("download_failed");
  }
  const resolved: SlackTransientAudioAttachment[] = [];
  for (const attachment of attachments) {
    assertAudioSize(attachment);
    const audio = await downloadSlackAudio({
      attachment,
      fetchFn: input.fetchFn,
      token: input.clientToken,
    });
    const result = await input.transcriptionGateway
      .transcribe({
        audio,
        context: { workspaceId: input.teamId },
        filename: attachment.filename,
        mediaType: attachment.mediaType,
      })
      .catch((error: unknown) => {
        if (error instanceof SlackAudioProcessingError) {
          throw error;
        }
        throw new SlackAudioProcessingError("transcription_failed");
      });
    resolved.push({
      filename: attachment.filename,
      id: attachment.id,
      kind: "audio",
      mediaType: attachment.mediaType,
      messageTs: attachment.messageTs,
      transcript: result.text,
    });
  }
  return resolved;
}

export function collectSlackAudioMetadata(
  messages: readonly StringIndexed[],
): SlackAudioMetadata[] {
  const attachments: SlackAudioMetadata[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const messageTs = readString(message, "ts");
    const files = Array.isArray(message.files) ? message.files : [];
    for (const file of files) {
      if (!isRecord(file)) {
        continue;
      }
      const metadata = normalizeSlackAudioFile(file, messageTs);
      if (metadata === undefined) {
        continue;
      }
      const dedupeKey = `${metadata.id}:${metadata.messageTs ?? ""}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      attachments.push(metadata);
    }
  }
  return attachments;
}

export function hasSlackAudioFiles(message: StringIndexed): boolean {
  return (
    collectSlackAudioMetadata([message]).length > 0 || hasUnsupportedSlackAudioFiles([message])
  );
}

async function downloadSlackAudio(input: {
  attachment: SlackAudioMetadata;
  fetchFn?: typeof fetch;
  token: string;
}): Promise<Uint8Array> {
  const fetchFn = input.fetchFn ?? fetch;
  const response = await fetchFn(input.attachment.downloadUrl, {
    headers: {
      authorization: `Bearer ${input.token}`,
    },
  }).catch(() => {
    throw new SlackAudioProcessingError("download_failed");
  });
  if (!response.ok) {
    throw new SlackAudioProcessingError("download_failed");
  }
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > SLACK_AUDIO_MAX_BYTES) {
    throw new SlackAudioProcessingError("oversized");
  }
  return data;
}

function assertAudioSize(attachment: SlackAudioMetadata): void {
  if (attachment.sizeBytes !== undefined && attachment.sizeBytes > SLACK_AUDIO_MAX_BYTES) {
    throw new SlackAudioProcessingError("oversized");
  }
}

function normalizeSlackAudioFile(
  file: Record<string, unknown>,
  messageTs: string | undefined,
): SlackAudioMetadata | undefined {
  const mediaType = readString(file, "mimetype") ?? mediaTypeFromSlackFiletype(file);
  if (mediaType === undefined || !allowedAudioMediaTypes.has(mediaType)) {
    return undefined;
  }
  const downloadUrl = readString(file, "url_private_download") ?? readString(file, "url_private");
  const id = readString(file, "id");
  if (downloadUrl === undefined || id === undefined) {
    return undefined;
  }
  return {
    downloadUrl,
    filename: readString(file, "name") ?? readString(file, "title"),
    id,
    mediaType,
    messageTs,
    sizeBytes: readNumber(file, "size"),
  };
}

function hasUnsupportedSlackAudioFiles(messages: readonly StringIndexed[]): boolean {
  for (const message of messages) {
    const messageTs = readString(message, "ts");
    const files = Array.isArray(message.files) ? message.files : [];
    for (const file of files) {
      if (!isRecord(file) || !isAudioLikeSlackFile(file)) {
        continue;
      }
      if (normalizeSlackAudioFile(file, messageTs) === undefined) {
        return true;
      }
    }
  }
  return false;
}

function isAudioLikeSlackFile(file: Record<string, unknown>): boolean {
  const mediaType = readString(file, "mimetype")?.toLocaleLowerCase();
  if (mediaType?.startsWith("audio/") === true) {
    return true;
  }
  return ["flac", "m4a", "mp3", "wav"].includes(
    readString(file, "filetype")?.toLocaleLowerCase() ?? "",
  );
}

function mediaTypeFromSlackFiletype(file: Record<string, unknown>): string | undefined {
  const filetype = readString(file, "filetype")?.toLocaleLowerCase();
  switch (filetype) {
    case "flac":
      return "audio/flac";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    default:
      return undefined;
  }
}

function userMessageForCode(code: SlackAudioProcessingError["code"]): string {
  switch (code) {
    case "download_failed":
      return "I couldn't read the audio attachment from Slack.";
    case "oversized":
      return "I couldn't read the audio attachment because it is too large.";
    case "unsupported":
      return "I couldn't read the audio attachment because its file type is not supported.";
    case "transcription_failed":
      return "I couldn't transcribe the audio attachment.";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const allowedAudioMediaTypes = new Set([
  "audio/flac",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
]);
