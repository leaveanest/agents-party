from __future__ import annotations

from collections.abc import Mapping
from importlib import import_module
from typing import Any, Protocol, cast

from agents_party.agents.slack_runtime import (
    RoutedAgentDecisionAction,
    SlackAgentInvocation,
    execute_registered_agent,
    resolve_routed_agent,
)
from agents_party.config import settings
from agents_party.domain import (
    AgentRouteScope,
    MessageRole,
    ThreadMessage,
    ThreadStatus,
)
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
    """Build a generic help message for mention-based agent routing.

    Args:
        user_id: Optional Slack user id to mention in the help message.

    Returns:
        Slack-formatted help text.
    """
    mention = f"<@{user_id}> " if user_id else ""
    return (
        f"{mention}mention the app in a channel or thread to talk to the configured agent.\n"
        "Routing will eventually be selected from workspace, channel, and thread settings.\n"
        "Examples once routing is configured:\n"
        "- `@agents-party summarize this thread`\n"
        "- `@agents-party capture follow-up actions from this discussion`\n"
        "- `@agents-party review the deployment plan`"
    )


def build_agent_unconfigured_message(user_id: str | None = None) -> str:
    """Build the message shown when no configured or selectable agent is available.

    Args:
        user_id: Optional Slack user id to mention in the help message.

    Returns:
        Slack-formatted fallback text.
    """
    return (
        "No agent is configured for this workspace, channel, or thread yet.\n"
        f"{build_agent_help_message(user_id)}"
    )


def build_unimplemented_agent_message(
    agent_id: str,
    *,
    route_scope: AgentRouteScope | None = None,
    reasoning_summary: str | None = None,
) -> str:
    """Build the message shown when an agent is selected without a runtime.

    Args:
        agent_id: Agent identifier selected by routing.
        route_scope: Configured scope that produced the agent, if any.
        reasoning_summary: Optional selector summary to append for context.

    Returns:
        Slack-formatted message describing the missing runtime binding.
    """
    if route_scope is not None:
        message = (
            f"Resolved agent `{agent_id}` from {route_scope.value} settings. "
            "No runtime is registered yet."
        )
    else:
        message = (
            f"Selected agent `{agent_id}` from selector fallback. "
            "No runtime is registered yet."
        )
    if reasoning_summary:
        return f"{message} {reasoning_summary}"
    return message


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


async def invoke_routed_agent(
    invocation: Mapping[str, Any] | SlackAgentInvocation,
    *,
    client: SlackConversationsClient | None = None,
    repository: SlackAgentRepository | None = None,
    work_item_repository: WorkItemRepository | None = None,
) -> str:
    """Resolve a route, fetch full thread context, and execute the selected agent.

    Args:
        invocation: Raw or validated routing payload derived from Slack.
        client: Slack client used to fetch the full thread transcript.
        repository: Optional repository override used for routing lookup and thread state.
        work_item_repository: Optional repository override for executable runtimes.

    Returns:
        Slack response text produced by the selected runtime or routing fallback.
    """
    parsed_invocation = (
        invocation
        if isinstance(invocation, SlackAgentInvocation)
        else SlackAgentInvocation.from_mapping(invocation)
    )
    resolved_repository = repository or _build_repository()
    if resolved_repository is None:
        return build_agent_unconfigured_message(parsed_invocation.user_id)

    decision = await resolve_routed_agent(
        parsed_invocation,
        repository=resolved_repository,
    )
    if decision.action == RoutedAgentDecisionAction.CLARIFICATION_NEEDED:
        return (
            decision.follow_up_question
            or decision.reasoning_summary
            or build_agent_help_message(parsed_invocation.user_id)
        )
    if decision.action != RoutedAgentDecisionAction.EXECUTE or decision.agent is None:
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
    response_text = await execute_registered_agent(
        execution_invocation,
        decision.agent,
        work_item_repository=work_item_repository,
    )
    if response_text is not None:
        resolved_repository.activate_thread_agent(
            team_id=execution_invocation.team_id,
            channel_id=execution_invocation.channel_id,
            thread_ts=thread_ts,
            agent_id=decision.agent.agent_id,
            root_message_ts=thread_messages[0].ts,
            last_message_ts=thread_messages[-1].ts,
        )
        return response_text
    return build_unimplemented_agent_message(
        decision.agent.agent_id,
        route_scope=decision.route_scope,
        reasoning_summary=decision.reasoning_summary,
    )


async def handle_agent_mention(
    body: Mapping[str, Any],
    event: Mapping[str, Any],
    say: SayResponder,
    client: SlackConversationsClient | None = None,
    repository: SlackAgentRepository | None = None,
    work_item_repository: WorkItemRepository | None = None,
) -> None:
    """Handle a Slack app mention by routing the message into agent selection.

    Args:
        body: Top-level Slack request payload.
        event: Nested Slack event payload for the mention.
        say: Slack responder used to send the routing result.
        client: Slack client used to fetch the full thread transcript.
        repository: Optional repository override used for routing lookup.
        work_item_repository: Optional repository override for executable runtimes.

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
    """Handle Slack `message` events for explicit mentions and active thread replies.

    Args:
        body: Top-level Slack request payload.
        event: Nested Slack message event payload.
        say: Slack responder used to send the routing result.
        client: Slack client used to fetch the full thread transcript.
        bot_user_id: Slack bot user id for strict explicit-mention detection.
        repository: Optional repository override used for routing lookup.
        work_item_repository: Optional repository override for executable runtimes.

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
    "build_unimplemented_agent_message",
    "handle_agent_mention",
    "handle_agent_message",
    "invoke_routed_agent",
]
