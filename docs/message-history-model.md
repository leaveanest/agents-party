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
