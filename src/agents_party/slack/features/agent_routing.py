from __future__ import annotations

from collections.abc import Mapping
from importlib import import_module
from typing import Any, Protocol, cast

from agents_party.agents.slack_assistant import run_slack_assistant
from agents_party.agents.slack_runtime import SlackAgentInvocation
from agents_party.config import settings
from agents_party.domain import (
    MessageRole,
    ThreadMessage,
    ThreadStatus,
)
from agents_party.infrastructure import CloudTranslationError, CloudTranslationService
from agents_party.repositories import SlackAgentRepository, WorkItemRepository

_SUPPORTED_ASSISTANT_MESSAGE_SUBTYPES = frozenset({"bot_message"})


class SayResponder(Protocol):
    """Protocol for Slack `say` responders used by routing handlers."""

    async def __call__(self, *, text: str, thread_ts: str | None = None) -> Any:
        """Send a Slack message in response to routed execution.

        Args:
            text: Message text to send back to Slack.
            thread_ts: Optional thread timestamp to reply into.

        Returns:
            Slack responder-specific response payload.
        """
        ...


class SlackConversationsClient(Protocol):
    """Protocol for the subset of the Slack Web API used by routing."""

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


class SlackThreadHistoryError(RuntimeError):
    """Raised when Slack thread history cannot be normalized safely."""


class SlackMessageLookupError(RuntimeError):
    """Raised when a Slack message cannot be read for reaction-triggered translation."""


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
    """Build a generic help message for mention-based Slack assistant usage.

    Args:
        user_id: Optional Slack user id to mention in the help message.

    Returns:
        Slack-formatted help text.
    """
    mention = f"<@{user_id}> " if user_id else ""
    return (
        f"{mention}mention the app in a channel or thread to talk to the assistant.\n"
        "The assistant can help with task management, web research, and translation.\n"
        "Examples:\n"
        "- `@agents-party summarize this thread`\n"
        "- `@agents-party capture follow-up actions from this discussion`\n"
        "- `@agents-party verify the latest deployment policy`"
    )


def build_agent_unconfigured_message(user_id: str | None = None) -> str:
    """Build the message shown when the Slack assistant is unavailable.

    Args:
        user_id: Optional Slack user id to mention in the help message.

    Returns:
        Slack-formatted fallback text.
    """
    return (
        "The Slack assistant is not enabled for this workspace or channel.\n"
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
    """Instantiate the Slack agent repository from configured Firestore settings.

    Returns:
        Firestore-backed Slack agent repository, or `None` when unavailable.
    """
    try:
        module = import_module(
            "agents_party.infrastructure.firestore.slack_agent_repository"
        )
    except ModuleNotFoundError:
        return None

    repository_cls = getattr(module, "FirestoreSlackAgentRepository", None)
    if repository_cls is None:
        return None

    return cast(
        SlackAgentRepository,
        repository_cls(
            project_id=settings.google_cloud_project,
            database=settings.firestore_database,
        ),
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
    subtype = _optional_text_field(message, "subtype")
    if subtype is not None and subtype not in _SUPPORTED_ASSISTANT_MESSAGE_SUBTYPES:
        raise SlackThreadHistoryError(
            f"Unsupported Slack message subtype in thread history: {subtype}"
        )

    ts = _require_text_field(message, "ts")
    text = _optional_text_field(message, "text") or ""
    user_id = _optional_text_field(message, "user")
    bot_id = _optional_text_field(message, "bot_id")
    app_id = _optional_text_field(message, "app_id")

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
    return ThreadMessage(
        ts=ts,
        role=MessageRole.USER,
        text=text,
        user_id=user_id,
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


def _build_translation_service() -> CloudTranslationService | None:
    """Build the configured Cloud Translation service helper.

    Returns:
        Cloud Translation service bound to the configured Google Cloud project, or
        `None` when translation is not configured.
    """
    if not settings.google_cloud_project:
        return None
    return CloudTranslationService(project_id=settings.google_cloud_project)


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
    """Fetch full thread context, run the Slack assistant, and persist thread state.

    Args:
        invocation: Raw or validated routing payload derived from Slack.
        client: Slack client used to fetch the full thread transcript.
        repository: Optional repository override used for channel checks and thread state.
        work_item_repository: Optional repository override for assistant delegation.

    Returns:
        Slack response text produced by the assistant or a configuration fallback.
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

    execution_invocation = parsed_invocation.model_copy(
        update={"thread_messages": thread_messages}
    )
    thread_ts = execution_invocation.thread_ts or execution_invocation.message_ts
    if thread_ts is None:
        return build_thread_context_error_message(parsed_invocation.user_id)

    assistant_result = await run_slack_assistant(
        execution_invocation,
        work_item_repository=work_item_repository,
    )
    response_text = assistant_result.follow_up_question or assistant_result.message
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
            text=build_agent_help_message(invocation.user_id),
            thread_ts=invocation.thread_ts,
        )
        return

    response_text = await invoke_routed_agent(
        invocation,
        client=client,
        repository=repository,
        work_item_repository=work_item_repository,
    )
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
    if not _is_supported_message_event(event):
        return

    raw_text = _optional_text_field(event, "text") or ""
    if _message_targets_bot(raw_text, bot_user_id):
        await handle_agent_mention(
            body,
            event,
            say,
            client=client,
            repository=repository,
            work_item_repository=work_item_repository,
        )
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

    response_text = await invoke_routed_agent(
        invocation,
        client=client,
        repository=resolved_repository,
        work_item_repository=work_item_repository,
    )
    await say(text=response_text, thread_ts=invocation.thread_ts)


__all__ = [
    "SayResponder",
    "SlackConversationsClient",
    "build_agent_help_message",
    "build_agent_invocation_from_mention",
    "build_agent_invocation_from_message",
    "build_agent_unconfigured_message",
    "build_thread_context_error_message",
    "build_translation_execution_error_message",
    "build_translation_unconfigured_message",
    "build_translation_source_error_message",
    "handle_agent_mention",
    "handle_agent_message",
    "handle_translation_reaction",
    "invoke_routed_agent",
    "resolve_translation_language_from_reaction",
]
