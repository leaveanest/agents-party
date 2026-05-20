# Message History Model

OSA-9 defines repository-owned conversation history for the TypeScript runtime. The application does not store AI SDK `ModelMessage[]` as domain history. AI SDK messages are produced only at provider invocation boundaries.

## Boundaries

- `src/domain/messageHistory.ts`: provider-agnostic conversation, attachment, assistant, tool-call, and tool-result models.
- `src/slack/messageHistory.ts`: Slack payload normalization into the domain model.
- `src/providers/aiSdkMessageConverter.ts`: conversion from domain history to AI SDK `ModelMessage[]`.

Slack handlers should normalize Slack thread messages before agent/provider code sees them. Provider code should receive domain history and model capability metadata, then convert to AI SDK messages immediately before invocation.

## Attachment Degradation

Attachment handling is explicit per provider capability:

- `native`: pass the attachment to AI SDK as an image or file part.
- `text`: pass extracted text or transcript as a text part.
- `reject`: fail with a user-facing unsupported attachment message.

Attachments are never silently dropped. If a text-only provider receives an image, file, or audio attachment without extracted text or transcript, conversion raises `UnsupportedAttachmentError`.

## Current Coverage

The domain model represents:

- system messages
- user text
- reference images
- files such as PDFs
- audio with optional transcript
- assistant text and tool calls
- tool results with text, JSON, or execution-denied output

This model is intentionally independent from Slack SDK objects, AI SDK types, and PostgreSQL row shapes.

## Ephemeral Slack Audio

Slack audio attachments are normalized before provider invocation, not persisted as message history. The Slack handler may download supported audio files (`audio/mpeg`, `audio/mp3`, `audio/wav`, `audio/x-wav`, `audio/flac`) using the bot token, transcribe them through the configured transcription gateway, and pass transcript text into the current `SlackAgentInvocation.transientAttachments`.

Transcript text and audio bytes must not be written to PostgreSQL, Slack messages, Redis job payloads, or application logs. Queued Slack jobs store only Slack identifiers and re-read the Slack thread at worker processing time.

## Ephemeral Slack Images

Slack image attachments are resolved before provider invocation, not persisted as message history. The Slack handler downloads supported image files (`image/png`, `image/jpeg`, `image/webp`) using the bot token and passes the bytes into the current `SlackAgentInvocation.referenceImages`. Images larger than the provider byte target are resized and re-encoded before invocation; images above the Slack image download hard cap are rejected with a Slack ephemeral message.

Image bytes must not be written to PostgreSQL, Slack messages, Redis job payloads, or application logs. Queued Slack jobs store only Slack identifiers and re-read the Slack thread at worker processing time.
