from __future__ import annotations

from importlib import import_module
from collections.abc import Mapping
from typing import Any, NotRequired, Protocol, TypedDict, cast

from agents_party.agents.agent_selector import (
    AgentSelectorAction,
    AgentSelectorCandidate,
    run_agent_selector,
)
from agents_party.config import settings
from agents_party.domain import AgentDocument, ResolvedAgentRoute
from agents_party.repositories import SlackAgentRepository


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


class AgentInvocation(TypedDict):
    team_id: str
    user_id: str
    channel_id: str
    viewer_context_channel_ids: tuple[str, ...]
    text: str
    thread_ts: NotRequired[str | None]
    message_ts: NotRequired[str | None]


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


def build_agent_selected_message(route: ResolvedAgentRoute) -> str:
    """Build the temporary response used when a configured route is resolved.

    Args:
        route: Resolved configured route for the current Slack context.

    Returns:
        Slack-formatted confirmation message.
    """
    return (
        f"Resolved agent `{route.agent.agent_id}` from {route.scope.value} settings, "
        "but execution is not connected yet."
    )


def build_selector_selected_message(agent_id: str, reasoning_summary: str) -> str:
    """Build the temporary response used when selector fallback chooses an agent.

    Args:
        agent_id: Agent id recommended by the selector.
        reasoning_summary: Short explanation returned by the selector.

    Returns:
        Slack-formatted confirmation message.
    """
    return (
        f"Selected agent `{agent_id}` from selector fallback, "
        f"but execution is not connected yet. {reasoning_summary}"
    )


def build_agent_invocation_from_mention(
    body: Mapping[str, Any],
    event: Mapping[str, Any],
) -> AgentInvocation:
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

    invocation: AgentInvocation = {
        "team_id": _require_text_field(body, "team_id"),
        "user_id": _require_text_field(event, "user"),
        "channel_id": channel_id,
        "viewer_context_channel_ids": (channel_id,),
        "text": _strip_leading_mentions(raw_text),
    }
    if thread_ts is not None:
        invocation["thread_ts"] = thread_ts
    if message_ts is not None:
        invocation["message_ts"] = message_ts
    return invocation


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


def _build_selector_candidates(
    agents: list[AgentDocument],
) -> list[AgentSelectorCandidate]:
    """Project stored agent documents into selector candidate payloads.

    Args:
        agents: Stored agent documents eligible for selector fallback.

    Returns:
        Selector candidate payloads derived from the stored agents.
    """
    return [
        AgentSelectorCandidate(
            agent_id=agent.agent_id,
            name=agent.name,
            description=agent.description or agent.name,
            when_to_use=agent.when_to_use,
            supported_skill_names=agent.supported_skill_names,
            enabled=agent.enabled,
        )
        for agent in agents
    ]


async def invoke_routed_agent(
    invocation: AgentInvocation,
    repository: SlackAgentRepository | None = None,
) -> str:
    """Resolve a configured route, then fall back to selector-based agent choice.

    Args:
        invocation: Internal routing payload derived from the Slack mention.
        repository: Optional repository override used for routing lookup.

    Returns:
        Slack response text describing the selected route or fallback outcome.
    """
    resolved_repository = repository or _build_repository()
    if resolved_repository is None:
        return build_agent_unconfigured_message(invocation["user_id"])

    route = resolved_repository.resolve_agent(
        team_id=invocation["team_id"],
        channel_id=invocation["channel_id"],
        thread_ts=invocation.get("thread_ts"),
    )
    if route is None:
        candidates = resolved_repository.list_enabled_agents(
            team_id=invocation["team_id"],
            channel_id=invocation["channel_id"],
            thread_ts=invocation.get("thread_ts"),
        )
        if not candidates:
            return build_agent_unconfigured_message(invocation["user_id"])

        selection = await run_agent_selector(
            {
                "text": invocation["text"],
                "team_id": invocation["team_id"],
                "channel_id": invocation["channel_id"],
                "thread_ts": invocation.get("thread_ts"),
                "candidates": _build_selector_candidates(candidates),
            }
        )
        if (
            selection.action == AgentSelectorAction.SELECTED
            and selection.recommended_agent_id is not None
        ):
            return build_selector_selected_message(
                selection.recommended_agent_id,
                selection.reasoning_summary,
            )
        if selection.action == AgentSelectorAction.CLARIFICATION_NEEDED:
            return selection.follow_up_question or selection.reasoning_summary
        return build_agent_unconfigured_message(invocation["user_id"])
    return build_agent_selected_message(route)


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

    if not invocation["text"].strip():
        await say(
            text=build_agent_help_message(invocation["user_id"]),
            thread_ts=invocation.get("thread_ts"),
        )
        return

    response_text = await invoke_routed_agent(invocation)
    await say(text=response_text, thread_ts=invocation.get("thread_ts"))
