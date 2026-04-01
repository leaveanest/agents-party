"""Slack routing helpers for assistant mentions, thread follow-ups, and reactions."""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Mapping, Sequence
from importlib import import_module
from urllib.parse import urlparse
from typing import Any, Protocol, cast

import httpx
from pydantic_ai import BinaryContent, BinaryImage
from agents_party.agents.agent_router import run_agent_router
from agents_party.agents.slack_runtime import SlackAgentInvocation, SlackReferenceImage
from agents_party.config import settings
from agents_party.domain import (
    MessageRole,
    ThreadMessage,
    ThreadStatus,
)
from agents_party.infrastructure import (
    CloudSpeechTranscriptionService,
    CloudStorageStagingService,
    CloudTranscriptionError,
    CloudTranslationError,
    CloudTranslationService,
    TranscriptionResponse,
)
from agents_party.infrastructure.postgres.connection import (
    build_database_engine_from_settings,
)
from agents_party.repositories import SlackAgentRepository, WorkItemRepository

logger = logging.getLogger(__name__)
_SUPPORTED_ASSISTANT_MESSAGE_SUBTYPES = frozenset({"bot_message"})
_SUPPORTED_USER_THREAD_MESSAGE_SUBTYPES = frozenset({"file_share"})
_MAX_REFERENCE_IMAGES = 3
_MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024
_MAX_REFERENCE_AUDIO_BYTES = 100 * 1024 * 1024
_TRANSCRIPTION_COMMAND_PATTERNS = (
    re.compile(
        r"文字起こし(?:\s*(?:して|してください|して下さい|お願い(?:します)?|頼む))?(?:$|[\s.!！。?？])"
    ),
    re.compile(r"^(?:please\s+)?transcribe\b(?:[\s.!?].*)?$"),
    re.compile(r"^(?:can|could|would)\s+you\s+transcribe\b(?:[\s.!?].*)?$"),
    re.compile(
        r"^(?:please\s+)?(?:run|get|create|make|start)\s+(?:a\s+)?transcription"
        r"(?:\s+for\s+(?:this|that|it|thread|audio|video|file|meeting|recording|attachment))?"
        r"(?:\s+please)?[.!?]?$"
    ),
    re.compile(r"^(?:please\s+)?transcription(?:\s+please)?[.!?]?$"),
)


class SayResponder(Protocol):
    """Protocol for Slack `say` responders used by routing handlers."""

    async def __call__(
        self,
        *,
        text: str,
        thread_ts: str | None = None,
        blocks: Sequence[Mapping[str, Any]] | None = None,
    ) -> Any:
        """Send a Slack message in response to routed execution.

        Args:
            text: Message text to send back to Slack.
            thread_ts: Optional thread timestamp to reply into.
            blocks: Optional Slack Block Kit payload attached to the message.

        Returns:
            Slack responder-specific response payload.
        """
        ...


class SlackConversationsClient(Protocol):
    """Protocol for the subset of the Slack Web API used by routing."""

    token: str | None

    async def chat_postMessage(
        self,
        *,
        channel: str,
        text: str,
        thread_ts: str | None = None,
    ) -> Mapping[str, Any]:
        """Post a Slack message back into a channel or thread.

        Args:
            channel: Slack channel id where the reply should be posted.
            text: Message text to send.
            thread_ts: Optional root thread timestamp for threaded replies.

        Returns:
            Slack API response payload for the posted message.
        """
        ...

    async def conversations_history(
        self,
        *,
        channel: str,
        latest: str,
        oldest: str,
        inclusive: bool,
        limit: int | None = None,
    ) -> Mapping[str, Any]:
        """Fetch message history for a channel around a specific timestamp.

        Args:
            channel: Slack channel id containing the target message.
            latest: Inclusive upper-bound timestamp for the history query.
            oldest: Inclusive lower-bound timestamp for the history query.
            inclusive: Whether Slack should include the boundary timestamps.
            limit: Optional page size override.

        Returns:
            Slack API response payload for the requested history window.
        """
        ...

    async def conversations_replies(
        self,
        *,
        channel: str,
        ts: str,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> Mapping[str, Any]:
        """Fetch paginated Slack thread history for a channel thread.

        Args:
            channel: Slack channel id containing the thread.
            ts: Root thread timestamp used by Slack's replies API.
            cursor: Optional Slack pagination cursor.
            limit: Optional page size override.

        Returns:
            Slack API response payload for the requested page.
        """
        ...

    async def files_upload_v2(
        self,
        *,
        channel: str,
        file: bytes,
        filename: str | None = None,
        title: str | None = None,
        alt_txt: str | None = None,
        initial_comment: str | None = None,
        thread_ts: str | None = None,
    ) -> Mapping[str, Any]:
        """Upload a generated file back into a Slack channel or thread.

        Args:
            channel: Slack channel id where the file should be uploaded.
            file: Raw file bytes to upload.
            filename: Optional upload filename.
            title: Optional title shown by Slack for the uploaded file.
            alt_txt: Optional alt text shown for image uploads.
            initial_comment: Optional comment posted alongside the upload.
            thread_ts: Optional thread timestamp for threaded uploads.

        Returns:
            Slack API response payload for the uploaded file.
        """
        ...


class SlackThreadHistoryError(RuntimeError):
    """Raised when Slack thread history cannot be normalized safely."""


class SlackMessageLookupError(RuntimeError):
    """Raised when a Slack message cannot be read for reaction-triggered translation."""


class SlackAudioDownloadError(RuntimeError):
    """Raised when Slack transcription media cannot be downloaded safely."""


def _read_nested_plain_text(value: object) -> str | None:
    """Read a plain-text field from either a raw string or Slack text object.

    Args:
        value: Slack payload value that may hold text directly or via a nested object.

    Returns:
        Trimmed text value, or `None` when no usable text is present.
    """
    if isinstance(value, str):
        text = value.strip()
        return text or None
    if isinstance(value, Mapping):
        nested_text = cast(Mapping[str, Any], value).get("text")
        if isinstance(nested_text, str):
            text = nested_text.strip()
            return text or None
    return None


def _is_transcription_media_slack_file(file_payload: Mapping[str, Any]) -> bool:
    """Return whether a Slack file payload looks transcribable.

    Args:
        file_payload: Slack file payload embedded in a message.

    Returns:
        `True` when the file appears to be an audio or video payload.
    """
    mime_type = _optional_text_field(file_payload, "mimetype")
    if mime_type is not None and (
        mime_type.startswith("audio/") or mime_type.startswith("video/")
    ):
        return True
    file_type = _optional_text_field(file_payload, "filetype")
    return file_type in {
        "aac",
        "avi",
        "flac",
        "m4a",
        "mkv",
        "mov",
        "mp3",
        "mp4",
        "mpeg",
        "mpg",
        "ogg",
        "wav",
        "webm",
    }


def _is_image_like_slack_file(file_payload: Mapping[str, Any]) -> bool:
    """Return whether a Slack file payload looks like an image attachment.

    Args:
        file_payload: Slack file payload embedded in a message.

    Returns:
        `True` when the file is an image or has an image-like file type.
    """
    mime_type = _optional_text_field(file_payload, "mimetype")
    if mime_type is not None and mime_type.startswith("image/"):
        return True
    file_type = _optional_text_field(file_payload, "filetype")
    return file_type in {"gif", "heic", "jpeg", "jpg", "png", "svg", "webp"}


def _extract_slack_transcription_media_metadata(
    message: Mapping[str, Any],
) -> list[dict[str, str]]:
    """Extract lightweight transcription-media metadata from a Slack message.

    Args:
        message: Raw Slack message payload that may contain audio or video files.

    Returns:
        Ordered media descriptors suitable for later download and transcription.
    """
    media_files: list[dict[str, str]] = []
    raw_files = message.get("files")
    if not isinstance(raw_files, list):
        return media_files

    for raw_file in raw_files:
        if not isinstance(raw_file, Mapping) or not _is_transcription_media_slack_file(
            raw_file
        ):
            continue
        media_payload: dict[str, str] = {"source": "file"}
        title = _optional_text_field(raw_file, "title") or _optional_text_field(
            raw_file, "name"
        )
        mime_type = _optional_text_field(raw_file, "mimetype")
        download_url = _optional_text_field(
            raw_file, "url_private_download"
        ) or _optional_text_field(raw_file, "url_private")
        filename = _optional_text_field(raw_file, "name")
        if title is not None:
            media_payload["title"] = title
        if mime_type is not None:
            media_payload["mime_type"] = mime_type
        if download_url is not None:
            media_payload["download_url"] = download_url
        if filename is not None:
            media_payload["filename"] = filename
        media_files.append(media_payload)
    return media_files


def _extract_slack_image_metadata(message: Mapping[str, Any]) -> list[dict[str, str]]:
    """Extract lightweight image metadata from a Slack message payload.

    Args:
        message: Raw Slack message payload that may contain image files or blocks.

    Returns:
        Ordered image descriptors suitable for thread-context prompts.
    """
    images: list[dict[str, str]] = []

    raw_files = message.get("files")
    if isinstance(raw_files, list):
        for raw_file in raw_files:
            if not isinstance(raw_file, Mapping) or not _is_image_like_slack_file(
                raw_file
            ):
                continue
            image: dict[str, str] = {"source": "file"}
            title = _optional_text_field(raw_file, "title") or _optional_text_field(
                raw_file, "name"
            )
            alt_text = _optional_text_field(raw_file, "alt_txt")
            mime_type = _optional_text_field(raw_file, "mimetype")
            download_url = _optional_text_field(
                raw_file, "url_private_download"
            ) or _optional_text_field(raw_file, "url_private")
            if title is not None:
                image["title"] = title
            if alt_text is not None:
                image["alt_text"] = alt_text
            if mime_type is not None:
                image["mime_type"] = mime_type
            if download_url is not None:
                image["download_url"] = download_url
            images.append(image)

    raw_blocks = message.get("blocks")
    if isinstance(raw_blocks, list):
        for raw_block in raw_blocks:
            if not isinstance(raw_block, Mapping) or raw_block.get("type") != "image":
                continue
            image = {"source": "block"}
            title = _read_nested_plain_text(raw_block.get("title"))
            alt_text = _optional_text_field(raw_block, "alt_text")
            download_url = _optional_text_field(raw_block, "image_url")
            if title is not None:
                image["title"] = title
            if alt_text is not None:
                image["alt_text"] = alt_text
            if download_url is not None:
                image["download_url"] = download_url
            images.append(image)

    raw_attachments = message.get("attachments")
    if isinstance(raw_attachments, list):
        for raw_attachment in raw_attachments:
            if not isinstance(raw_attachment, Mapping):
                continue
            image_url = _optional_text_field(raw_attachment, "image_url")
            thumb_url = _optional_text_field(raw_attachment, "thumb_url")
            if image_url is None and thumb_url is None:
                continue
            image = {"source": "attachment"}
            title = _optional_text_field(raw_attachment, "title")
            alt_text = _optional_text_field(
                raw_attachment, "fallback"
            ) or _optional_text_field(raw_attachment, "text")
            download_url = image_url or thumb_url
            if title is not None:
                image["title"] = title
            if alt_text is not None:
                image["alt_text"] = alt_text
            if download_url is not None:
                image["download_url"] = download_url
            images.append(image)

    return images


def _collect_thread_image_specs(
    thread_messages: Sequence[ThreadMessage],
) -> list[dict[str, str]]:
    """Collect downloadable image descriptors from normalized thread messages.

    Args:
        thread_messages: Normalized Slack thread transcript used for routing.

    Returns:
        Ordered downloadable image descriptors trimmed to the most recent images.
    """
    specs: list[dict[str, str]] = []
    for message in thread_messages:
        raw_images = message.metadata.get("slack_images")
        if not isinstance(raw_images, list):
            continue
        for index, raw_image in enumerate(raw_images, start=1):
            if not isinstance(raw_image, Mapping):
                continue
            image_payload = cast(Mapping[str, Any], raw_image)
            download_url = str(image_payload.get("download_url") or "").strip()
            if not download_url:
                continue
            spec = {
                "identifier": f"thread-image-{message.ts.replace('.', '-')}-{index}",
                "download_url": download_url,
                "media_type": str(image_payload.get("mime_type") or "").strip(),
                "title": str(image_payload.get("title") or "").strip(),
                "alt_text": str(image_payload.get("alt_text") or "").strip(),
                "source": str(image_payload.get("source") or "").strip(),
                "message_ts": message.ts,
            }
            specs.append(spec)
    if len(specs) <= _MAX_REFERENCE_IMAGES:
        return specs
    return specs[-_MAX_REFERENCE_IMAGES:]


def _collect_thread_transcription_media_specs(
    thread_messages: Sequence[ThreadMessage],
) -> list[dict[str, str]]:
    """Collect downloadable transcription-media descriptors from thread messages.

    Args:
        thread_messages: Normalized Slack thread transcript used for routing.

    Returns:
        Ordered downloadable audio or video descriptors.
    """
    specs: list[dict[str, str]] = []
    for message in thread_messages:
        raw_media = message.metadata.get("slack_transcription_media")
        if not isinstance(raw_media, list):
            continue
        for index, raw_file in enumerate(raw_media, start=1):
            if not isinstance(raw_file, Mapping):
                continue
            file_payload = cast(Mapping[str, Any], raw_file)
            download_url = str(file_payload.get("download_url") or "").strip()
            if not download_url:
                continue
            specs.append(
                {
                    "identifier": f"thread-media-{message.ts.replace('.', '-')}-{index}",
                    "download_url": download_url,
                    "media_type": str(file_payload.get("mime_type") or "").strip(),
                    "title": str(file_payload.get("title") or "").strip(),
                    "filename": str(file_payload.get("filename") or "").strip(),
                    "source": str(file_payload.get("source") or "").strip(),
                    "message_ts": message.ts,
                }
            )
    return specs


def _build_slack_download_headers(url: str, token: str) -> dict[str, str]:
    """Build safe headers for downloading a Slack-owned private file.

    Args:
        url: Download URL extracted from Slack metadata.
        token: Slack bot token available on the current client.

    Returns:
        Request headers, including Slack bearer auth only for Slack-owned hosts.
    """
    hostname = urlparse(url).hostname or ""
    if hostname.endswith("slack.com") or hostname.endswith("slack-files.com"):
        return {"Authorization": f"Bearer {token}"}
    return {}


async def _download_thread_reference_images(
    client: SlackConversationsClient | None,
    thread_messages: Sequence[ThreadMessage],
) -> list[SlackReferenceImage]:
    """Download recent image attachments from a Slack thread for multimodal input.

    Args:
        client: Slack client whose token can authorize private Slack file downloads.
        thread_messages: Normalized Slack thread transcript used for routing.

    Returns:
        Downloaded reference images suitable for passing to the image agent.
    """
    if client is None or not isinstance(client.token, str) or not client.token.strip():
        return []

    specs = _collect_thread_image_specs(thread_messages)
    if not specs:
        return []

    token = client.token.strip()
    reference_images: list[SlackReferenceImage] = []
    async with httpx.AsyncClient(follow_redirects=True, timeout=20.0) as http_client:
        for spec in specs:
            try:
                response = await http_client.get(
                    spec["download_url"],
                    headers=_build_slack_download_headers(spec["download_url"], token),
                )
                response.raise_for_status()
            except httpx.HTTPError:
                continue

            media_type = (
                spec["media_type"]
                or response.headers.get("content-type", "").split(";", 1)[0].strip()
            )
            if not media_type.startswith("image/"):
                continue

            data = response.content
            if not data or len(data) > _MAX_REFERENCE_IMAGE_BYTES:
                continue

            reference_images.append(
                SlackReferenceImage(
                    identifier=spec["identifier"],
                    data=data,
                    media_type=media_type,
                    title=spec["title"] or None,
                    alt_text=spec["alt_text"] or None,
                    source=spec["source"] or None,
                    message_ts=spec["message_ts"] or None,
                )
            )
    return reference_images


async def _download_thread_transcription_media_attachment(
    client: SlackConversationsClient | None,
    spec: Mapping[str, str],
) -> dict[str, str | bytes]:
    """Download a Slack audio or video attachment for transcription.

    Args:
        client: Slack client whose token can authorize private Slack file downloads.
        spec: Media descriptor selected from `_collect_thread_transcription_media_specs`.

    Returns:
        Mapping containing binary `data`, normalized `media_type`, and `filename`.

    Raises:
        SlackAudioDownloadError: If the attachment cannot be downloaded safely.
    """
    if client is None or not isinstance(client.token, str) or not client.token.strip():
        raise SlackAudioDownloadError("Slack client token is required.")

    download_url = str(spec.get("download_url") or "").strip()
    if not download_url:
        raise SlackAudioDownloadError("Slack media descriptor did not include a URL.")

    async with httpx.AsyncClient(follow_redirects=True, timeout=60.0) as http_client:
        try:
            async with http_client.stream(
                "GET",
                download_url,
                headers=_build_slack_download_headers(
                    download_url, client.token.strip()
                ),
            ) as response:
                response.raise_for_status()
                media_type = (
                    str(spec.get("media_type") or "").strip()
                    or response.headers.get("content-type", "").split(";", 1)[0].strip()
                )
                if not (
                    media_type.startswith("audio/") or media_type.startswith("video/")
                ):
                    raise SlackAudioDownloadError(
                        "Slack attachment was not an audio or video payload."
                    )

                data_buffer = bytearray()
                async for chunk in response.aiter_bytes():
                    if not chunk:
                        continue
                    data_buffer.extend(chunk)
                    if len(data_buffer) > _MAX_REFERENCE_AUDIO_BYTES:
                        raise SlackAudioDownloadError(
                            "Slack audio or video attachment was empty or too large."
                        )
        except httpx.HTTPError as exc:
            raise SlackAudioDownloadError(
                "Slack transcription media download failed."
            ) from exc
        except SlackAudioDownloadError:
            raise

    data = bytes(data_buffer)
    if not data:
        raise SlackAudioDownloadError(
            "Slack audio or video attachment was empty or too large."
        )

    filename = (
        str(spec.get("filename") or spec.get("title") or "media").strip() or "media"
    )
    return {
        "data": data,
        "media_type": media_type,
        "filename": filename,
    }


def _filename_for_generated_image(media_type: str) -> str:
    """Return a stable Slack upload filename for a generated image.

    Args:
        media_type: MIME type reported by the image-generation agent.

    Returns:
        Filename with an extension matching the MIME type when recognized.
    """
    if media_type == "image/jpeg":
        return "generated-image.jpg"
    if media_type == "image/webp":
        return "generated-image.webp"
    return "generated-image.png"


def _filename_for_generated_video(media_type: str) -> str:
    """Return a stable Slack upload filename for a generated video.

    Args:
        media_type: MIME type reported by the video-generation runtime.

    Returns:
        Filename with an extension matching the MIME type when recognized.
    """
    if media_type == "video/quicktime":
        return "generated-video.mov"
    return "generated-video.mp4"


async def _upload_generated_image_reply(
    client: SlackConversationsClient | None,
    *,
    channel_id: str,
    thread_ts: str,
    image: BinaryImage,
    initial_comment: str,
) -> bool:
    """Upload a generated image into the routed Slack thread.

    Args:
        client: Slack client used to upload the generated image.
        channel_id: Slack channel id where the thread lives.
        thread_ts: Root Slack thread timestamp for the upload.
        image: Generated binary image payload.
        initial_comment: Comment posted alongside the uploaded image.

    Returns:
        `True` when the upload succeeds, else `False`.
    """
    if client is None:
        return False

    await client.files_upload_v2(
        channel=channel_id,
        file=image.data,
        filename=_filename_for_generated_image(image.media_type),
        title="Generated image",
        alt_txt=initial_comment,
        initial_comment=initial_comment,
        thread_ts=thread_ts,
    )
    return True


async def _upload_generated_video_reply(
    client: SlackConversationsClient | None,
    *,
    channel_id: str,
    thread_ts: str,
    video: BinaryContent,
    initial_comment: str,
) -> bool:
    """Upload a generated video into the routed Slack thread.

    Args:
        client: Slack client used to upload the generated video.
        channel_id: Slack channel id where the thread lives.
        thread_ts: Root Slack thread timestamp for the upload.
        video: Generated binary video payload.
        initial_comment: Comment posted alongside the uploaded video.

    Returns:
        `True` when the upload succeeds, else `False`.
    """
    if client is None:
        return False

    await client.files_upload_v2(
        channel=channel_id,
        file=video.data,
        filename=_filename_for_generated_video(video.media_type),
        title="Generated video",
        initial_comment=initial_comment,
        thread_ts=thread_ts,
    )
    return True


_FLAG_REACTION_LANGUAGE_CODE_MAP = {
    "au": "en",
    "br": "pt",
    "ca": "en",
    "cn": "zh-CN",
    "cz": "cs",
    "de": "de",
    "dk": "da",
    "es": "es",
    "fi": "fi",
    "fr": "fr",
    "gb": "en",
    "gr": "el",
    "hk": "zh-TW",
    "hu": "hu",
    "id": "id",
    "il": "he",
    "in": "hi",
    "it": "it",
    "jp": "ja",
    "kr": "ko",
    "mx": "es",
    "nl": "nl",
    "no": "no",
    "nz": "en",
    "pl": "pl",
    "pt": "pt",
    "ro": "ro",
    "ru": "ru",
    "sa": "ar",
    "se": "sv",
    "th": "th",
    "tr": "tr",
    "tw": "zh-TW",
    "ua": "uk",
    "us": "en",
    "vn": "vi",
}


def _require_text_field(payload: Mapping[str, Any], field_name: str) -> str:
    """Read a required non-empty string field from a Slack payload.

    Args:
        payload: Slack request payload to inspect.
        field_name: Field name that must contain a non-empty string.

    Returns:
        Trimmed string value for the requested field.

    Raises:
        ValueError: If the field is missing or blank.
    """
    value = payload.get(field_name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Missing required Slack field: {field_name}")
    return value.strip()


def _optional_text_field(payload: Mapping[str, Any], field_name: str) -> str | None:
    """Read an optional trimmed string field from a Slack payload.

    Args:
        payload: Slack request payload to inspect.
        field_name: Field name to read.

    Returns:
        Trimmed string value, or `None` when the field is missing or blank.
    """
    value = payload.get(field_name)
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def _strip_leading_mentions(text: str) -> str:
    """Remove leading Slack user mentions so routing sees only the user request.

    Args:
        text: Raw Slack message text.

    Returns:
        Message text with leading mention tokens removed.
    """
    stripped = text.lstrip()
    while stripped.startswith("<@"):
        end = stripped.find(">")
        if end == -1:
            break
        stripped = stripped[end + 1 :].lstrip()
    return stripped


def _leading_mention_ids(text: str) -> list[str]:
    """Return ordered leading Slack mention ids from the start of a message.

    Args:
        text: Raw Slack message text.

    Returns:
        Mentioned user ids found at the start of the message before non-mention text.
    """
    stripped = text.lstrip()
    mention_ids: list[str] = []
    while stripped.startswith("<@"):
        end = stripped.find(">")
        if end == -1:
            break
        mention_token = stripped[2:end].strip()
        if mention_token:
            mention_ids.append(mention_token)
        stripped = stripped[end + 1 :].lstrip()
    return mention_ids


def _message_targets_bot(text: str, bot_user_id: str | None) -> bool:
    """Return whether a Slack message explicitly targets this bot via leading mention.

    Args:
        text: Raw Slack message text.
        bot_user_id: Slack bot user id for this application.

    Returns:
        `True` when the message begins with mention tokens that include this bot.
    """
    if not bot_user_id:
        return False
    return bot_user_id in _leading_mention_ids(text)


def build_agent_help_message(user_id: str | None = None) -> str:
    """Build a generic help message for mention-based Slack agent-router usage.

    Args:
        user_id: Optional Slack user id to mention in the help message.

    Returns:
        Slack-formatted help text.
    """
    mention = f"<@{user_id}> " if user_id else ""
    return (
        f"{mention}mention the app in a channel or thread to talk to the assistant.\n"
        "The assistant can help with general questions, task management, web research, place and route lookup, translation, image generation, and video generation.\n"
        "Examples:\n"
        "- `@agents-party summarize this thread`\n"
        "- `@agents-party capture follow-up actions from this discussion`\n"
        "- `@agents-party verify the latest deployment policy`\n"
        "- `@agents-party 新宿駅近くのカフェを探して`\n"
        "- `@agents-party create a mockup from this idea`\n"
        "- `@agents-party 文字起こしして`"
    )


def build_thread_menu_message(user_id: str | None = None) -> str:
    """Build the fallback text shown for a mention with no actionable prompt.

    Args:
        user_id: Optional Slack user id to mention in the menu message.

    Returns:
        Slack-formatted plain-text fallback that mirrors the menu blocks.
    """
    mention = f"<@{user_id}> " if user_id else ""
    return (
        f"{mention}choose what you want to do with this thread.\n"
        "Try one of these mentions:\n"
        "- `@agents-party summarize this thread`\n"
        "- `@agents-party capture follow-up actions from this discussion`\n"
        "- `@agents-party verify the latest deployment policy`\n"
        "- `@agents-party 東京駅から渋谷駅までのルートを教えて`\n"
        "- `@agents-party 文字起こしして`"
    )


def build_thread_menu_blocks(user_id: str | None = None) -> list[dict[str, Any]]:
    """Build the Block Kit menu shown for a textless assistant mention.

    Args:
        user_id: Optional Slack user id to mention in the menu prompt.

    Returns:
        Slack Block Kit payload presenting the thread menu choices.
    """
    mention = f"<@{user_id}> " if user_id else ""
    return [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"{mention}What would you like to do with this thread?",
            },
        },
        {
            "type": "section",
            "fields": [
                {
                    "type": "mrkdwn",
                    "text": "*Summarize*\n`@agents-party summarize this thread`",
                },
                {
                    "type": "mrkdwn",
                    "text": (
                        "*Action Items*\n"
                        "`@agents-party capture follow-up actions from this discussion`"
                    ),
                },
                {
                    "type": "mrkdwn",
                    "text": (
                        "*Verify*\n`@agents-party verify the latest deployment policy`"
                    ),
                },
                {
                    "type": "mrkdwn",
                    "text": (
                        "*Maps*\n`@agents-party 東京駅から渋谷駅までのルートを教えて`"
                    ),
                },
                {
                    "type": "mrkdwn",
                    "text": "*Transcribe*\n`@agents-party 文字起こしして`",
                },
            ],
        },
        {
            "type": "context",
            "elements": [
                {
                    "type": "mrkdwn",
                    "text": "A mention without text stays in menu mode and does not run the AI route yet.",
                }
            ],
        },
    ]


def build_agent_unconfigured_message(user_id: str | None = None) -> str:
    """Build the message shown when the Slack agent router is unavailable.

    Args:
        user_id: Optional Slack user id to mention in the help message.

    Returns:
        Slack-formatted fallback text.
    """
    return (
        "The Slack agent router is not enabled for this workspace or channel.\n"
        f"{build_agent_help_message(user_id)}"
    )


def build_thread_context_error_message(user_id: str | None = None) -> str:
    """Build the message shown when full Slack thread context cannot be loaded.

    Args:
        user_id: Optional Slack user id to mention in the error message.

    Returns:
        Slack-formatted operational error message.
    """
    mention = f"<@{user_id}> " if user_id else ""
    return (
        f"{mention}I couldn't load the full Slack thread context for this run.\n"
        "Please try again in the same thread."
    )


def build_translation_source_error_message(user_id: str | None = None) -> str:
    """Build the message shown when a reaction target cannot be translated.

    Args:
        user_id: Optional Slack user id to mention in the error message.

    Returns:
        Slack-formatted operational error message.
    """
    mention = f"<@{user_id}> " if user_id else ""
    return (
        f"{mention}I couldn't read translatable text from the reacted Slack message.\n"
        "Try adding the flag reaction to a text message."
    )


def build_translation_unconfigured_message(user_id: str | None = None) -> str:
    """Build the message shown when Cloud Translation is not configured.

    Args:
        user_id: Optional Slack user id to mention in the error message.

    Returns:
        Slack-formatted configuration error message.
    """
    mention = f"<@{user_id}> " if user_id else ""
    return (
        f"{mention}Translation is not configured for this workspace.\n"
        "Set `GOOGLE_CLOUD_PROJECT` and configure Application Default Credentials."
    )


def build_translation_execution_error_message(user_id: str | None = None) -> str:
    """Build the message shown when Cloud Translation fails at execution time.

    Args:
        user_id: Optional Slack user id to mention in the error message.

    Returns:
        Slack-formatted runtime error message.
    """
    mention = f"<@{user_id}> " if user_id else ""
    return (
        f"{mention}I couldn't translate that message right now.\n"
        "Please try again in a moment."
    )


def build_transcription_started_message(user_id: str | None = None) -> str:
    """Build the message shown when a transcription job has started.

    Args:
        user_id: Optional Slack user id to mention in the start message.

    Returns:
        Slack-formatted progress message.
    """
    mention = f"<@{user_id}> " if user_id else ""
    return (
        f"{mention}starting transcription for the latest audio or video attachment in this thread.\n"
        "I'll post the result here when it is ready."
    )


def build_transcription_source_error_message(user_id: str | None = None) -> str:
    """Build the message shown when a thread contains no transcribable media.

    Args:
        user_id: Optional Slack user id to mention in the error message.

    Returns:
        Slack-formatted operational error message.
    """
    mention = f"<@{user_id}> " if user_id else ""
    return (
        f"{mention}I couldn't find a Slack audio or video attachment in this thread.\n"
        "Attach an audio or video file and ask me to transcribe it in the same thread."
    )


def build_transcription_unconfigured_message(user_id: str | None = None) -> str:
    """Build the message shown when Cloud Speech transcription is not configured.

    Args:
        user_id: Optional Slack user id to mention in the error message.

    Returns:
        Slack-formatted configuration error message.
    """
    mention = f"<@{user_id}> " if user_id else ""
    return (
        f"{mention}Transcription is not configured for this workspace.\n"
        "Set `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_TRANSCRIPTION_STAGING_BUCKET`, and configure Application Default Credentials."
    )


def build_transcription_execution_error_message(user_id: str | None = None) -> str:
    """Build the message shown when Cloud Speech transcription fails at runtime.

    Args:
        user_id: Optional Slack user id to mention in the error message.

    Returns:
        Slack-formatted runtime error message.
    """
    mention = f"<@{user_id}> " if user_id else ""
    return (
        f"{mention}I couldn't transcribe that media right now.\n"
        "Please try again in a moment."
    )


def build_transcription_response_message(
    transcription: TranscriptionResponse,
    *,
    filename: str | None = None,
) -> str:
    """Build the final Slack reply for a completed transcription run.

    Args:
        transcription: Completed speaker-attributed transcription response.
        filename: Optional original Slack filename for the transcribed audio.

    Returns:
        Slack-formatted transcription reply.
    """
    heading = "Transcription complete."
    if filename:
        heading = f"Transcription complete for `{filename}`."
    lines = [heading]
    for segment in transcription.segments:
        lines.append(f"{segment.speaker_label}: {segment.text}")
    return "\n".join(lines)


def _is_transcription_request(text: str) -> bool:
    """Return whether a Slack request explicitly asks for transcription.

    Args:
        text: User request text after Slack mention normalization.

    Returns:
        `True` when the request clearly asks for transcription.
    """
    normalized = text.casefold()
    return any(
        pattern.search(normalized) is not None
        for pattern in _TRANSCRIPTION_COMMAND_PATTERNS
    )


def _build_agent_invocation(
    body: Mapping[str, Any],
    event: Mapping[str, Any],
    *,
    strip_leading_mentions: bool,
) -> SlackAgentInvocation:
    """Convert a Slack event payload into the internal routing shape.

    Args:
        body: Top-level Slack request payload.
        event: Nested Slack event payload.
        strip_leading_mentions: Whether to remove leading mention tokens from text.

    Returns:
        Internal invocation payload used by agent routing.

    Raises:
        ValueError: If required Slack fields are missing or blank.
    """
    channel_id = _require_text_field(event, "channel")
    message_ts = _require_text_field(event, "ts")
    thread_ts = _optional_text_field(event, "thread_ts") or message_ts
    raw_text = _optional_text_field(event, "text") or ""
    text = _strip_leading_mentions(raw_text) if strip_leading_mentions else raw_text

    return SlackAgentInvocation(
        team_id=_require_text_field(body, "team_id"),
        user_id=_require_text_field(event, "user"),
        channel_id=channel_id,
        viewer_context_channel_ids=[channel_id],
        text=text,
        thread_ts=thread_ts,
        message_ts=message_ts,
    )


def build_agent_invocation_from_mention(
    body: Mapping[str, Any],
    event: Mapping[str, Any],
) -> SlackAgentInvocation:
    """Convert a Slack `app_mention` payload into the internal routing shape.

    Args:
        body: Top-level Slack request payload.
        event: Nested Slack event payload for the mention.

    Returns:
        Internal invocation payload used by agent routing.

    Raises:
        ValueError: If required Slack fields are missing or blank.
    """
    return _build_agent_invocation(body, event, strip_leading_mentions=True)


def build_agent_invocation_from_message(
    body: Mapping[str, Any],
    event: Mapping[str, Any],
) -> SlackAgentInvocation:
    """Convert a Slack follow-up `message` event into the internal routing shape.

    Args:
        body: Top-level Slack request payload.
        event: Nested Slack event payload for the follow-up message.

    Returns:
        Internal invocation payload used by agent routing.

    Raises:
        ValueError: If required Slack fields are missing or blank.
    """
    return _build_agent_invocation(body, event, strip_leading_mentions=False)


def _build_repository() -> SlackAgentRepository | None:
    """Instantiate the Slack agent repository from configured PostgreSQL settings.

    Returns:
        PostgreSQL-backed Slack agent repository, or `None` when unavailable.
    """
    if not settings.database_enabled:
        return None
    try:
        module = import_module(
            "agents_party.infrastructure.postgres.slack_agent_repository"
        )
    except ModuleNotFoundError:
        return None

    repository_cls = getattr(module, "PostgresSlackAgentRepository", None)
    if repository_cls is None:
        return None

    return cast(
        SlackAgentRepository,
        repository_cls(engine=build_database_engine_from_settings(settings)),
    )


def _normalize_thread_message(message: Mapping[str, Any]) -> ThreadMessage:
    """Normalize a Slack thread message into the shared transcript model.

    Args:
        message: Raw Slack thread message payload.

    Returns:
        Normalized thread message used by downstream agents.

    Raises:
        SlackThreadHistoryError: If the message cannot be mapped safely.
    """
    ts = _require_text_field(message, "ts")
    text = _optional_text_field(message, "text") or ""
    user_id = _optional_text_field(message, "user")
    bot_id = _optional_text_field(message, "bot_id")
    app_id = _optional_text_field(message, "app_id")
    image_metadata = _extract_slack_image_metadata(message)
    transcription_media_metadata = _extract_slack_transcription_media_metadata(message)
    subtype = _optional_text_field(message, "subtype")
    if (
        subtype is not None
        and subtype not in _SUPPORTED_ASSISTANT_MESSAGE_SUBTYPES
        and not (
            subtype in _SUPPORTED_USER_THREAD_MESSAGE_SUBTYPES and user_id is not None
        )
    ):
        raise SlackThreadHistoryError(
            f"Unsupported Slack message subtype in thread history: {subtype}"
        )

    if (
        subtype in _SUPPORTED_ASSISTANT_MESSAGE_SUBTYPES
        or bot_id is not None
        or app_id is not None
    ):
        metadata: dict[str, Any] = {}
        if subtype is not None:
            metadata["slack_subtype"] = subtype
        if bot_id is not None:
            metadata["slack_bot_id"] = bot_id
        if app_id is not None:
            metadata["slack_app_id"] = app_id
        if image_metadata:
            metadata["slack_images"] = image_metadata
        if transcription_media_metadata:
            metadata["slack_transcription_media"] = transcription_media_metadata
        return ThreadMessage(
            ts=ts,
            role=MessageRole.ASSISTANT,
            text=text,
            user_id=user_id,
            metadata=metadata,
        )

    if user_id is None:
        raise SlackThreadHistoryError(
            "Slack thread history contained a user-authored message without `user`."
        )
    metadata: dict[str, Any] = {}
    if image_metadata:
        metadata["slack_images"] = image_metadata
    if transcription_media_metadata:
        metadata["slack_transcription_media"] = transcription_media_metadata
    return ThreadMessage(
        ts=ts,
        role=MessageRole.USER,
        text=text,
        user_id=user_id,
        metadata=metadata,
    )


async def _fetch_thread_messages(
    client: SlackConversationsClient | None,
    invocation: SlackAgentInvocation,
) -> list[ThreadMessage]:
    """Fetch and normalize the full Slack thread transcript for execution.

    Args:
        client: Slack client used to call `conversations.replies`.
        invocation: Validated Slack invocation describing the target thread.

    Returns:
        Chronological normalized Slack thread transcript.

    Raises:
        SlackThreadHistoryError: If the transcript cannot be fetched or normalized.
    """
    if client is None:
        raise SlackThreadHistoryError("Slack client is required for thread history.")
    if invocation.thread_ts is None:
        raise SlackThreadHistoryError(
            "Thread timestamp is required for thread history."
        )

    raw_messages: list[Mapping[str, Any]] = []
    cursor: str | None = None
    while True:
        try:
            response = await client.conversations_replies(
                channel=invocation.channel_id,
                ts=invocation.thread_ts,
                cursor=cursor,
                limit=200,
            )
        except Exception as exc:  # pragma: no cover - defensive Slack SDK wrapper.
            raise SlackThreadHistoryError(
                "Slack conversations.replies raised an exception."
            ) from exc
        if response.get("ok") is False:
            raise SlackThreadHistoryError(
                "Slack conversations.replies returned ok=false."
            )

        batch = response.get("messages")
        if not isinstance(batch, list) or not batch:
            raise SlackThreadHistoryError(
                "Slack conversations.replies did not return thread messages."
            )
        raw_messages.extend(
            cast(list[Mapping[str, Any]], batch),
        )

        response_metadata = response.get("response_metadata")
        cursor = (
            response_metadata.get("next_cursor")
            if isinstance(response_metadata, Mapping)
            else None
        )
        if not isinstance(cursor, str) or not cursor.strip():
            break

    return [_normalize_thread_message(message) for message in raw_messages]


def resolve_translation_language_from_reaction(
    reaction_name: str,
) -> str | None:
    """Map a Slack flag reaction name to a target language code.

    Args:
        reaction_name: Slack reaction name such as `flag-jp` or `jp`.

    Returns:
        Target language code, or `None` when the reaction is unsupported.
    """
    normalized = reaction_name.strip().casefold()
    if not normalized:
        return None
    if normalized in _FLAG_REACTION_LANGUAGE_CODE_MAP:
        return _FLAG_REACTION_LANGUAGE_CODE_MAP[normalized]
    if normalized.startswith("flag-"):
        return _FLAG_REACTION_LANGUAGE_CODE_MAP.get(normalized.removeprefix("flag-"))
    return None


def _is_supported_translation_reaction_event(event: Mapping[str, Any]) -> bool:
    """Return whether a Slack reaction event should trigger translation.

    Args:
        event: Slack reaction event payload.

    Returns:
        `True` when the reaction targets a Slack message and maps to a language.
    """
    item = event.get("item")
    if not isinstance(item, Mapping):
        return False
    if item.get("type") != "message":
        return False
    reaction_name = _optional_text_field(event, "reaction")
    if reaction_name is None:
        return False
    return resolve_translation_language_from_reaction(reaction_name) is not None


async def _fetch_message_for_reaction(
    client: SlackConversationsClient | None,
    *,
    channel_id: str,
    message_ts: str,
) -> Mapping[str, Any]:
    """Fetch a single Slack message targeted by a reaction.

    Args:
        client: Slack client used to call `conversations.history`.
        channel_id: Slack channel id containing the target message.
        message_ts: Slack timestamp identifying the target message.

    Returns:
        Raw Slack message payload for the requested timestamp.

    Raises:
        SlackMessageLookupError: If the message cannot be fetched safely.
    """
    if client is None:
        raise SlackMessageLookupError("Slack client is required for message lookup.")

    try:
        response = await client.conversations_history(
            channel=channel_id,
            latest=message_ts,
            oldest=message_ts,
            inclusive=True,
            limit=1,
        )
    except Exception as exc:  # pragma: no cover - defensive Slack SDK wrapper.
        raise SlackMessageLookupError(
            "Slack conversations.history raised an exception."
        ) from exc

    if response.get("ok") is False:
        raise SlackMessageLookupError("Slack conversations.history returned ok=false.")

    messages = response.get("messages")
    if not isinstance(messages, list) or not messages:
        raise SlackMessageLookupError(
            "Slack conversations.history did not return the target message."
        )

    message = messages[0]
    if not isinstance(message, Mapping):
        raise SlackMessageLookupError(
            "Slack conversations.history returned invalid data."
        )
    return message


def _is_supported_follow_up_message_event(event: Mapping[str, Any]) -> bool:
    """Return whether a Slack `message` event should auto-route as a follow-up.

    Args:
        event: Slack message event payload.

    Returns:
        `True` when the event is a user-authored non-empty thread reply.
    """
    if _optional_text_field(event, "subtype") is not None:
        return False
    if event.get("bot_id") is not None or event.get("bot_profile") is not None:
        return False

    thread_ts = _optional_text_field(event, "thread_ts")
    message_ts = _optional_text_field(event, "ts")
    if thread_ts is None or message_ts is None or thread_ts == message_ts:
        return False
    if _optional_text_field(event, "user") is None:
        return False
    return bool(_optional_text_field(event, "text"))


def _is_supported_message_event(event: Mapping[str, Any]) -> bool:
    """Return whether a Slack `message` event is a user-authored text message.

    Args:
        event: Slack message event payload.

    Returns:
        `True` when the event is a non-empty user-authored message payload.
    """
    if _optional_text_field(event, "subtype") is not None:
        return False
    if event.get("bot_id") is not None or event.get("bot_profile") is not None:
        return False
    if _optional_text_field(event, "user") is None:
        return False
    return bool(_optional_text_field(event, "text"))


def _is_supported_targeted_message_event(event: Mapping[str, Any]) -> bool:
    """Return whether a targeted Slack message can route through mention handling.

    Args:
        event: Slack message event payload.

    Returns:
        `True` when the event is a user-authored targeted message or file share.
    """
    if event.get("bot_id") is not None or event.get("bot_profile") is not None:
        return False
    if _optional_text_field(event, "user") is None:
        return False
    if not _optional_text_field(event, "text"):
        return False
    subtype = _optional_text_field(event, "subtype")
    return subtype is None or subtype == "file_share"


def _build_translation_service() -> CloudTranslationService | None:
    """Build the configured Cloud Translation service helper.

    Returns:
        Cloud Translation service bound to the configured Google Cloud project, or
        `None` when translation is not configured.
    """
    if not settings.google_cloud_project:
        return None
    return CloudTranslationService(project_id=settings.google_cloud_project)


def _build_transcription_service() -> CloudSpeechTranscriptionService | None:
    """Build the configured Cloud Speech transcription service helper.

    Returns:
        Cloud Speech transcription service bound to the configured Google Cloud
        project, or `None` when transcription is not configured.
    """
    if not settings.google_cloud_project:
        return None
    if not settings.google_cloud_transcription_staging_bucket:
        return None
    staging_service = CloudStorageStagingService(
        project_id=settings.google_cloud_project,
        bucket_name=settings.google_cloud_transcription_staging_bucket,
    )
    return CloudSpeechTranscriptionService(
        project_id=settings.google_cloud_project,
        location=settings.google_cloud_speech_location,
        model=settings.google_cloud_transcription_model,
        language_codes=settings.google_cloud_transcription_language_codes,
        staging_service=staging_service,
    )


def _schedule_background_task(coro: Any) -> asyncio.Task[Any]:
    """Create a background task for long-running Slack feature work.

    Args:
        coro: Awaitable coroutine implementing the background work.

    Returns:
        Created asyncio task.
    """
    task = asyncio.create_task(coro)
    task.add_done_callback(_log_background_task_error)
    return task


def _log_background_task_error(task: asyncio.Task[Any]) -> None:
    """Log uncaught exceptions from background Slack feature tasks.

    Args:
        task: Completed background task.

    Returns:
        None.
    """
    if task.cancelled():
        return
    try:
        task.result()
    except Exception:  # pragma: no cover - defensive async logging.
        logger.exception("Background Slack task failed.")


async def _run_transcription_request(
    invocation: SlackAgentInvocation,
    *,
    client: SlackConversationsClient,
) -> None:
    """Execute a thread transcription request outside the Slack ack path.

    Args:
        invocation: Validated Slack invocation describing the target thread.
        client: Slack client used to fetch thread history and post replies.

    Returns:
        None.
    """
    thread_ts = invocation.thread_ts or invocation.message_ts
    if thread_ts is None:
        return

    await client.chat_postMessage(
        channel=invocation.channel_id,
        text=build_transcription_started_message(invocation.user_id),
        thread_ts=thread_ts,
    )

    try:
        thread_messages = await _fetch_thread_messages(client, invocation)
    except SlackThreadHistoryError:
        await client.chat_postMessage(
            channel=invocation.channel_id,
            text=build_thread_context_error_message(invocation.user_id),
            thread_ts=thread_ts,
        )
        return

    media_specs = _collect_thread_transcription_media_specs(thread_messages)
    if not media_specs:
        await client.chat_postMessage(
            channel=invocation.channel_id,
            text=build_transcription_source_error_message(invocation.user_id),
            thread_ts=thread_ts,
        )
        return

    transcription_service = _build_transcription_service()
    if transcription_service is None:
        await client.chat_postMessage(
            channel=invocation.channel_id,
            text=build_transcription_unconfigured_message(invocation.user_id),
            thread_ts=thread_ts,
        )
        return

    latest_media = media_specs[-1]
    try:
        media_payload = await _download_thread_transcription_media_attachment(
            client,
            latest_media,
        )
        transcription = await asyncio.to_thread(
            transcription_service.transcribe_bytes,
            data=cast(bytes, media_payload["data"]),
            filename=cast(str, media_payload["filename"]),
            content_type=cast(str, media_payload["media_type"]),
        )
    except (SlackAudioDownloadError, CloudTranscriptionError, ValueError):
        await client.chat_postMessage(
            channel=invocation.channel_id,
            text=build_transcription_execution_error_message(invocation.user_id),
            thread_ts=thread_ts,
        )
        return

    await client.chat_postMessage(
        channel=invocation.channel_id,
        text=build_transcription_response_message(
            transcription,
            filename=cast(str, media_payload["filename"]),
        ),
        thread_ts=thread_ts,
    )


async def handle_translation_reaction(
    body: Mapping[str, Any],
    event: Mapping[str, Any],
    client: SlackConversationsClient | None = None,
) -> None:
    """Handle Slack flag reactions by translating the reacted message in-thread.

    Args:
        body: Top-level Slack request payload.
        event: Nested Slack reaction event payload.
        client: Slack client used to read the target message and post the reply.

    Returns:
        None.
    """
    if not _is_supported_translation_reaction_event(event):
        return

    reacting_user_id = _optional_text_field(event, "user")
    reaction_name = _require_text_field(event, "reaction")
    target_language_code = resolve_translation_language_from_reaction(reaction_name)
    if target_language_code is None:
        return

    item = event.get("item")
    if not isinstance(item, Mapping):
        return
    fallback_channel_id = _optional_text_field(item, "channel")
    fallback_message_ts = _optional_text_field(item, "ts")

    try:
        channel_id = _require_text_field(item, "channel")
        message_ts = _require_text_field(item, "ts")
        source_message = await _fetch_message_for_reaction(
            client,
            channel_id=channel_id,
            message_ts=message_ts,
        )
        source_text = _optional_text_field(source_message, "text")
        if source_text is None:
            raise SlackMessageLookupError(
                "Slack message did not contain translatable text."
            )
        thread_ts = _optional_text_field(
            source_message, "thread_ts"
        ) or _require_text_field(
            source_message,
            "ts",
        )
    except (ValueError, SlackMessageLookupError):
        if client is None or fallback_channel_id is None or fallback_message_ts is None:
            return
        await client.chat_postMessage(
            channel=fallback_channel_id,
            text=build_translation_source_error_message(reacting_user_id),
            thread_ts=fallback_message_ts,
        )
        return

    translation_service = _build_translation_service()
    if translation_service is None:
        if client is None:
            return
        await client.chat_postMessage(
            channel=channel_id,
            text=build_translation_unconfigured_message(reacting_user_id),
            thread_ts=thread_ts,
        )
        return

    try:
        translation = translation_service.translate_text(
            text=source_text,
            target_language_code=target_language_code,
            mime_type="text/plain",
        )
    except (ValueError, CloudTranslationError):
        if client is None:
            return
        await client.chat_postMessage(
            channel=channel_id,
            text=build_translation_execution_error_message(reacting_user_id),
            thread_ts=thread_ts,
        )
        return

    response_text = translation.translated_text
    if client is None or not response_text.strip():
        return
    await client.chat_postMessage(
        channel=channel_id,
        text=response_text,
        thread_ts=thread_ts,
    )


async def invoke_routed_agent(
    invocation: Mapping[str, Any] | SlackAgentInvocation,
    *,
    client: SlackConversationsClient | None = None,
    repository: SlackAgentRepository | None = None,
    work_item_repository: WorkItemRepository | None = None,
) -> str:
    """Fetch full thread context, run the agent router, and persist thread state.

    Args:
        invocation: Raw or validated routing payload derived from Slack.
        client: Slack client used to fetch the full thread transcript and any
            downloadable reference images.
        repository: Optional repository override used for channel checks and thread state.
        work_item_repository: Optional repository override for router delegation.

    Returns:
        Slack response text produced by the router or a configuration fallback.
    """
    parsed_invocation = (
        invocation
        if isinstance(invocation, SlackAgentInvocation)
        else SlackAgentInvocation.from_mapping(invocation)
    )
    resolved_repository = repository or _build_repository()
    if resolved_repository is None or not resolved_repository.is_channel_enabled(
        team_id=parsed_invocation.team_id,
        channel_id=parsed_invocation.channel_id,
    ):
        return build_agent_unconfigured_message(parsed_invocation.user_id)

    try:
        thread_messages = await _fetch_thread_messages(client, parsed_invocation)
    except SlackThreadHistoryError:
        return build_thread_context_error_message(parsed_invocation.user_id)

    reference_images = await _download_thread_reference_images(client, thread_messages)
    execution_invocation = parsed_invocation.model_copy(
        update={
            "thread_messages": thread_messages,
            "reference_images": reference_images,
        }
    )
    thread_ts = execution_invocation.thread_ts or execution_invocation.message_ts
    if thread_ts is None:
        return build_thread_context_error_message(parsed_invocation.user_id)

    router_result = await run_agent_router(
        execution_invocation,
        work_item_repository=work_item_repository,
    )
    response_text = getattr(router_result, "follow_up_question", None) or getattr(
        router_result, "message", ""
    )
    generated_video = getattr(router_result, "generated_video", None)
    if generated_video is not None:
        initial_comment = response_text.strip() or (
            f"Generated video for prompt:\n{execution_invocation.text}"
        )
        try:
            uploaded = await _upload_generated_video_reply(
                client,
                channel_id=execution_invocation.channel_id,
                thread_ts=thread_ts,
                video=generated_video,
                initial_comment=initial_comment,
            )
        except Exception:
            return "Video generation succeeded, but uploading to Slack failed."
        if not uploaded:
            return "Video generation requires a Slack upload client for this route."
        resolved_repository.activate_thread_agent(
            team_id=execution_invocation.team_id,
            channel_id=execution_invocation.channel_id,
            thread_ts=thread_ts,
            agent_id="assistant",
            root_message_ts=thread_messages[0].ts,
            last_message_ts=thread_messages[-1].ts,
        )
        return ""
    generated_image = getattr(router_result, "generated_image", None)
    if generated_image is not None:
        initial_comment = response_text.strip() or (
            f"Generated image for prompt:\n{execution_invocation.text}"
        )
        try:
            uploaded = await _upload_generated_image_reply(
                client,
                channel_id=execution_invocation.channel_id,
                thread_ts=thread_ts,
                image=generated_image,
                initial_comment=initial_comment,
            )
        except Exception:
            return "Image generation succeeded, but uploading to Slack failed."
        if not uploaded:
            return "Image generation requires a Slack upload client for this route."
        resolved_repository.activate_thread_agent(
            team_id=execution_invocation.team_id,
            channel_id=execution_invocation.channel_id,
            thread_ts=thread_ts,
            agent_id="assistant",
            root_message_ts=thread_messages[0].ts,
            last_message_ts=thread_messages[-1].ts,
        )
        return ""
    if response_text.strip():
        resolved_repository.activate_thread_agent(
            team_id=execution_invocation.team_id,
            channel_id=execution_invocation.channel_id,
            thread_ts=thread_ts,
            agent_id="assistant",
            root_message_ts=thread_messages[0].ts,
            last_message_ts=thread_messages[-1].ts,
        )
        return response_text
    return build_agent_help_message(parsed_invocation.user_id)


async def handle_agent_mention(
    body: Mapping[str, Any],
    event: Mapping[str, Any],
    say: SayResponder,
    client: SlackConversationsClient | None = None,
    repository: SlackAgentRepository | None = None,
    work_item_repository: WorkItemRepository | None = None,
) -> None:
    """Handle a Slack app mention by routing the message into the assistant.

    Args:
        body: Top-level Slack request payload.
        event: Nested Slack event payload for the mention.
        say: Slack responder used to send the routing result.
        client: Slack client used to fetch the full thread transcript.
        repository: Optional repository override used for routing lookup.
        work_item_repository: Optional repository override for assistant delegation.

    Returns:
        None.
    """
    try:
        invocation = build_agent_invocation_from_mention(body, event)
    except ValueError:
        await say(text=build_agent_help_message())
        return

    if not invocation.text.strip():
        await say(
            text=build_thread_menu_message(invocation.user_id),
            thread_ts=invocation.thread_ts,
            blocks=build_thread_menu_blocks(invocation.user_id),
        )
        return

    resolved_repository = repository or _build_repository()
    if resolved_repository is None or not resolved_repository.is_channel_enabled(
        team_id=invocation.team_id,
        channel_id=invocation.channel_id,
    ):
        await say(
            text=build_agent_unconfigured_message(invocation.user_id),
            thread_ts=invocation.thread_ts,
        )
        return

    if _is_transcription_request(invocation.text):
        if client is None:
            await say(
                text=build_thread_context_error_message(invocation.user_id),
                thread_ts=invocation.thread_ts,
            )
            return
        _schedule_background_task(
            _run_transcription_request(
                invocation,
                client=client,
            )
        )
        return

    response_text = await invoke_routed_agent(
        invocation,
        client=client,
        repository=resolved_repository,
        work_item_repository=work_item_repository,
    )
    if response_text.strip():
        await say(text=response_text, thread_ts=invocation.thread_ts)


async def handle_agent_message(
    body: Mapping[str, Any],
    event: Mapping[str, Any],
    say: SayResponder,
    client: SlackConversationsClient | None = None,
    bot_user_id: str | None = None,
    repository: SlackAgentRepository | None = None,
    work_item_repository: WorkItemRepository | None = None,
) -> None:
    """Handle Slack `message` events for explicit mentions and active assistant threads.

    Args:
        body: Top-level Slack request payload.
        event: Nested Slack message event payload.
        say: Slack responder used to send the routing result.
        client: Slack client used to fetch the full thread transcript.
        bot_user_id: Slack bot user id for strict explicit-mention detection.
        repository: Optional repository override used for routing lookup.
        work_item_repository: Optional repository override for assistant delegation.

    Returns:
        None.
    """
    raw_text = _optional_text_field(event, "text") or ""
    if _message_targets_bot(raw_text, bot_user_id):
        if not _is_supported_targeted_message_event(event):
            return
        await handle_agent_mention(
            body,
            event,
            say,
            client=client,
            repository=repository,
            work_item_repository=work_item_repository,
        )
        return

    if not _is_supported_message_event(event):
        return

    try:
        invocation = build_agent_invocation_from_message(body, event)
    except ValueError:
        return

    if not _is_supported_follow_up_message_event(event):
        return

    resolved_repository = repository or _build_repository()
    if resolved_repository is None or invocation.thread_ts is None:
        return

    thread_document = resolved_repository.get_thread_document(
        team_id=invocation.team_id,
        channel_id=invocation.channel_id,
        thread_ts=invocation.thread_ts,
    )
    if (
        thread_document is None
        or thread_document.status != ThreadStatus.ACTIVE
        or not thread_document.agent_id
    ):
        return
    if not resolved_repository.is_thread_auto_reply_enabled(
        team_id=invocation.team_id,
        channel_id=invocation.channel_id,
    ):
        return
    if not resolved_repository.is_channel_enabled(
        team_id=invocation.team_id,
        channel_id=invocation.channel_id,
    ):
        return

    if _is_transcription_request(invocation.text):
        if client is None:
            await say(
                text=build_thread_context_error_message(invocation.user_id),
                thread_ts=invocation.thread_ts,
            )
            return
        _schedule_background_task(
            _run_transcription_request(
                invocation,
                client=client,
            )
        )
        return

    response_text = await invoke_routed_agent(
        invocation,
        client=client,
        repository=resolved_repository,
        work_item_repository=work_item_repository,
    )
    if response_text.strip():
        await say(text=response_text, thread_ts=invocation.thread_ts)


__all__ = [
    "SayResponder",
    "SlackConversationsClient",
    "build_agent_help_message",
    "build_agent_invocation_from_mention",
    "build_agent_invocation_from_message",
    "build_thread_menu_blocks",
    "build_thread_menu_message",
    "build_agent_unconfigured_message",
    "build_thread_context_error_message",
    "build_transcription_execution_error_message",
    "build_transcription_response_message",
    "build_transcription_source_error_message",
    "build_transcription_started_message",
    "build_transcription_unconfigured_message",
    "build_translation_execution_error_message",
    "build_translation_unconfigured_message",
    "build_translation_source_error_message",
    "handle_agent_mention",
    "handle_agent_message",
    "handle_translation_reaction",
    "invoke_routed_agent",
    "resolve_translation_language_from_reaction",
]
