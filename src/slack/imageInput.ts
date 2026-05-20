import type { StringIndexed } from "@slack/bolt";
import sharp, { type Metadata } from "sharp";

import type { SlackAgentInvocation } from "../agents/schemas.js";

export const SLACK_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const SLACK_IMAGE_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
const SLACK_IMAGE_RESIZE_MAX_DIMENSION = 2048;
const SLACK_IMAGE_RESIZE_QUALITIES = [82, 72, 62] as const;
const SLACK_IMAGE_PROCESSING_TIMEOUT_SECONDS = 5;
const SLACK_IMAGE_MAX_INPUT_PIXELS = 50_000_000;

export type SlackReferenceImage = SlackAgentInvocation["referenceImages"][number];
type SlackReferenceImageData = NonNullable<SlackReferenceImage["data"]>;

export type SlackImageMetadata = {
  downloadUrl: string;
  filename?: string;
  id: string;
  mediaType: string;
  messageTs?: string;
  sizeBytes?: number;
};

export class SlackImageProcessingError extends Error {
  constructor(readonly code: "download_failed" | "oversized" | "unsupported") {
    super(userMessageForCode(code));
    this.name = "SlackImageProcessingError";
  }
}

export type ResolveSlackImageAttachmentsInput = {
  clientToken?: string;
  fetchFn?: typeof fetch;
  messages: readonly StringIndexed[];
};

export async function resolveSlackImageAttachments(
  input: ResolveSlackImageAttachmentsInput,
): Promise<SlackReferenceImage[]> {
  const attachments = collectSlackImageMetadata(input.messages);
  validateSlackImageAttachments(input.messages, attachments);
  if (attachments.length === 0) {
    return [];
  }
  if (input.clientToken === undefined || input.clientToken.trim() === "") {
    throw new SlackImageProcessingError("download_failed");
  }
  const resolved: SlackReferenceImage[] = [];
  for (const attachment of attachments) {
    const data = await downloadSlackImage({
      attachment,
      fetchFn: input.fetchFn,
      token: input.clientToken,
    });
    const processed = await processSlackImageForProvider(data, attachment.mediaType);
    resolved.push({
      data: processed.data,
      identifier: attachment.id,
      mediaType: processed.mediaType,
      messageTs: attachment.messageTs,
    });
  }
  return resolved;
}

export function validateSlackImageAttachments(
  messages: readonly StringIndexed[],
  attachments: readonly SlackImageMetadata[] = collectSlackImageMetadata(messages),
): void {
  if (hasUnsupportedSlackImageFiles(messages)) {
    throw new SlackImageProcessingError("unsupported");
  }
  for (const attachment of attachments) {
    assertImageDownloadSize(attachment);
  }
}

export function collectSlackImageMetadata(
  messages: readonly StringIndexed[],
): SlackImageMetadata[] {
  const attachments: SlackImageMetadata[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const messageTs = readString(message, "ts");
    const files = Array.isArray(message.files) ? message.files : [];
    for (const file of files) {
      if (!isRecord(file)) {
        continue;
      }
      const metadata = normalizeSlackImageFile(file, messageTs);
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

export function hasSlackImageFiles(message: StringIndexed): boolean {
  return (
    collectSlackImageMetadata([message]).length > 0 || hasUnsupportedSlackImageFiles([message])
  );
}

async function downloadSlackImage(input: {
  attachment: SlackImageMetadata;
  fetchFn?: typeof fetch;
  token: string;
}): Promise<SlackReferenceImageData> {
  const fetchFn = input.fetchFn ?? fetch;
  const response = await fetchFn(input.attachment.downloadUrl, {
    headers: {
      authorization: `Bearer ${input.token}`,
    },
  }).catch(() => {
    throw new SlackImageProcessingError("download_failed");
  });
  if (!response.ok) {
    throw new SlackImageProcessingError("download_failed");
  }
  const contentLength = readContentLength(response.headers);
  if (contentLength !== undefined && contentLength > SLACK_IMAGE_DOWNLOAD_MAX_BYTES) {
    throw new SlackImageProcessingError("oversized");
  }
  const data = await readResponseBytesWithLimit(response, SLACK_IMAGE_DOWNLOAD_MAX_BYTES);
  if (data.byteLength > SLACK_IMAGE_DOWNLOAD_MAX_BYTES) {
    throw new SlackImageProcessingError("oversized");
  }
  return data;
}

async function processSlackImageForProvider(
  data: SlackReferenceImageData,
  mediaType: string,
): Promise<{ data: SlackReferenceImageData; mediaType: string }> {
  const metadata = await readSharpMetadata(data);
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (
    data.byteLength <= SLACK_IMAGE_MAX_BYTES &&
    width <= SLACK_IMAGE_RESIZE_MAX_DIMENSION &&
    height <= SLACK_IMAGE_RESIZE_MAX_DIMENSION
  ) {
    return { data, mediaType };
  }
  for (const quality of SLACK_IMAGE_RESIZE_QUALITIES) {
    const resized = await resizeSlackImageToJpeg(data, quality);
    if (resized.byteLength <= SLACK_IMAGE_MAX_BYTES) {
      return { data: resized, mediaType: "image/jpeg" };
    }
  }
  throw new SlackImageProcessingError("oversized");
}

async function readSharpMetadata(data: SlackReferenceImageData): Promise<Metadata> {
  try {
    return await sharp(data, { limitInputPixels: SLACK_IMAGE_MAX_INPUT_PIXELS })
      .timeout({ seconds: SLACK_IMAGE_PROCESSING_TIMEOUT_SECONDS })
      .metadata();
  } catch {
    throw new SlackImageProcessingError("oversized");
  }
}

async function resizeSlackImageToJpeg(
  data: SlackReferenceImageData,
  quality: number,
): Promise<SlackReferenceImageData> {
  try {
    return (await sharp(data, { limitInputPixels: SLACK_IMAGE_MAX_INPUT_PIXELS })
      .rotate()
      .resize({
        fit: "inside",
        height: SLACK_IMAGE_RESIZE_MAX_DIMENSION,
        width: SLACK_IMAGE_RESIZE_MAX_DIMENSION,
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ mozjpeg: true, quality })
      .timeout({ seconds: SLACK_IMAGE_PROCESSING_TIMEOUT_SECONDS })
      .toBuffer()) as SlackReferenceImageData;
  } catch (error) {
    if (error instanceof SlackImageProcessingError) {
      throw error;
    }
    throw new SlackImageProcessingError("oversized");
  }
}

async function readResponseBytesWithLimit(
  response: Response,
  maxBytes: number,
): Promise<SlackReferenceImageData> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const data = new Uint8Array(await response.arrayBuffer()) as SlackReferenceImageData;
    if (data.byteLength > maxBytes) {
      throw new SlackImageProcessingError("oversized");
    }
    return data;
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done === true) {
        break;
      }
      const chunk = result.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new SlackImageProcessingError("oversized");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof SlackImageProcessingError) {
      throw error;
    }
    throw new SlackImageProcessingError("download_failed");
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data as SlackReferenceImageData;
}

function assertImageDownloadSize(attachment: SlackImageMetadata): void {
  if (attachment.sizeBytes !== undefined && attachment.sizeBytes > SLACK_IMAGE_DOWNLOAD_MAX_BYTES) {
    throw new SlackImageProcessingError("oversized");
  }
}

function normalizeSlackImageFile(
  file: Record<string, unknown>,
  messageTs: string | undefined,
): SlackImageMetadata | undefined {
  const mediaType = normalizeImageMediaType(
    readString(file, "mimetype") ?? mediaTypeFromSlackFiletype(file),
  );
  if (mediaType === undefined || !allowedImageMediaTypes.has(mediaType)) {
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

function hasUnsupportedSlackImageFiles(messages: readonly StringIndexed[]): boolean {
  for (const message of messages) {
    const files = Array.isArray(message.files) ? message.files : [];
    for (const file of files) {
      if (!isRecord(file) || !isImageLikeSlackFile(file)) {
        continue;
      }
      if (normalizeSlackImageFile(file, readString(message, "ts")) === undefined) {
        return true;
      }
    }
  }
  return false;
}

function isImageLikeSlackFile(file: Record<string, unknown>): boolean {
  const mediaType = readString(file, "mimetype")?.toLocaleLowerCase();
  if (mediaType?.startsWith("image/") === true) {
    return true;
  }
  return ["gif", "jpg", "jpeg", "png", "webp"].includes(
    readString(file, "filetype")?.toLocaleLowerCase() ?? "",
  );
}

function mediaTypeFromSlackFiletype(file: Record<string, unknown>): string | undefined {
  const filetype = readString(file, "filetype")?.toLocaleLowerCase();
  switch (filetype) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    default:
      return undefined;
  }
}

function normalizeImageMediaType(mediaType: string | undefined): string | undefined {
  const normalized = mediaType?.toLocaleLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function userMessageForCode(code: SlackImageProcessingError["code"]): string {
  switch (code) {
    case "download_failed":
      return "I couldn't read the image attachment from Slack.";
    case "oversized":
      return "I couldn't read the image attachment because it is too large. Please upload a PNG, JPEG, or WebP image no larger than 25 MB.";
    case "unsupported":
      return "I couldn't read the image attachment because its file type is not supported. Please upload a PNG, JPEG, or WebP image.";
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

function readContentLength(headers: Headers): number | undefined {
  const value = headers.get("content-length");
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const allowedImageMediaTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
