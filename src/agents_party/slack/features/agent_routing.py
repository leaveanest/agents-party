from __future__ import annotations

from importlib import import_module
from collections.abc import Mapping
from typing import Any, Protocol, cast

from agents_party.agents.slack_runtime import (
    RoutedAgentDecisionAction,
    SlackAgentInvocation,
    execute_registered_agent,
    resolve_routed_agent,
)
from agents_party.config import settings
from agents_party.domain import AgentRouteScope
from agents_party.repositories import SlackAgentRepository, WorkItemRepository


class SayResponder(Protocol):
    """Protocol for Slack `say` responders used by mention handlers."""

    async def __call__(self, *, text: str, thread_ts: str | None = None) -> Any:
        """Send a Slack message in response to a routed mention.

        Args:
            text: Message text to send back to Slack.
            thread_ts: Optional thread timestamp to reply into.

        Returns:
            Slack responder-specific response payload.
        """
        ...


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
    channel_id = _require_text_field(event, "channel")
    message_ts = _optional_text_field(event, "ts")
    thread_ts = _optional_text_field(event, "thread_ts") or message_ts
    raw_text = _optional_text_field(event, "text") or ""

    return SlackAgentInvocation(
        team_id=_require_text_field(body, "team_id"),
        user_id=_require_text_field(event, "user"),
        channel_id=channel_id,
        viewer_context_channel_ids=[channel_id],
        text=_strip_leading_mentions(raw_text),
        thread_ts=thread_ts,
        message_ts=message_ts,
    )


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


async def invoke_routed_agent(
    invocation: Mapping[str, Any] | SlackAgentInvocation,
    repository: SlackAgentRepository | None = None,
    work_item_repository: WorkItemRepository | None = None,
) -> str:
    """Resolve a route, then execute the registered runtime for the selected agent.

    Args:
        invocation: Raw or validated routing payload derived from the Slack mention.
        repository: Optional repository override used for routing lookup.
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

    response_text = await execute_registered_agent(
        parsed_invocation,
        decision.agent,
        work_item_repository=work_item_repository,
    )
    if response_text is not None:
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
) -> None:
    """Handle a Slack app mention by routing the message into agent selection.

    Args:
        body: Top-level Slack request payload.
        event: Nested Slack event payload for the mention.
        say: Slack responder used to send the routing result.

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

    response_text = await invoke_routed_agent(invocation)
    await say(text=response_text, thread_ts=invocation.thread_ts)
