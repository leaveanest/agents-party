"""Slack-facing agent selection and execution helpers."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field

from agents_party.agents.agent_selector import (
    AgentSelectorAction,
    AgentSelectorCandidate,
    run_agent_selector,
)
from agents_party.domain import AgentDocument, AgentRouteScope, ResolvedAgentRoute
from agents_party.repositories import SlackAgentRepository, WorkItemRepository


class SlackAgentInvocation(BaseModel):
    """Common Slack request envelope used by executable agents.

    Attributes:
        team_id: Slack workspace identifier owning the request.
        user_id: Slack user identifier for the requester.
        channel_id: Slack channel identifier where the request was made.
        viewer_context_channel_ids: Channels used for repository visibility lookups.
        text: User request text after Slack-specific normalization.
        thread_ts: Optional thread timestamp for thread-aware routing and replies.
        message_ts: Optional originating message timestamp.
    """

    model_config = ConfigDict(extra="forbid")

    team_id: str
    user_id: str
    channel_id: str
    viewer_context_channel_ids: list[str] = Field(default_factory=list)
    text: str
    thread_ts: str | None = None
    message_ts: str | None = None

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any]) -> Self:
        """Validate a generic mapping into a typed Slack agent invocation.

        Args:
            data: Untrusted invocation payload supplied by callers.

        Returns:
            Validated Slack agent invocation model.
        """
        return cls.model_validate(data)


class RoutedAgentDecisionAction(StrEnum):
    """Possible outcomes of route resolution for a Slack request."""

    EXECUTE = "execute"
    CLARIFICATION_NEEDED = "clarification_needed"
    NO_MATCH = "no_match"


@dataclass(slots=True)
class RoutedAgentDecision:
    """Decision returned by Slack agent resolution before runtime execution.

    Attributes:
        action: Whether routing can execute, needs clarification, or found no match.
        agent: Selected agent document when execution should proceed.
        route_scope: Configured route scope when the agent came from stored routing.
        reasoning_summary: Short selector or routing summary for logging and UX.
        follow_up_question: Blocking question when clarification is required.
    """

    action: RoutedAgentDecisionAction
    agent: AgentDocument | None = None
    route_scope: AgentRouteScope | None = None
    reasoning_summary: str | None = None
    follow_up_question: str | None = None


type SlackAgentExecutor = Callable[
    [SlackAgentInvocation, AgentDocument, WorkItemRepository | None],
    Awaitable[str],
]


def build_selector_candidates(
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


def build_agent_model_name(agent: AgentDocument) -> str:
    """Build a provider-qualified model string for a stored agent document.

    Args:
        agent: Stored agent configuration containing provider and model fields.

    Returns:
        Model string suitable for `pydantic-ai` agent construction.
    """
    return f"{agent.model_provider}:{agent.model_name}"


def _find_agent_document(
    agents: list[AgentDocument],
    agent_id: str,
) -> AgentDocument | None:
    """Find a stored agent document by id within a candidate list.

    Args:
        agents: Candidate agent documents to search.
        agent_id: Agent identifier selected by the routing flow.

    Returns:
        Matching agent document, or `None` when the id is unavailable.
    """
    for agent in agents:
        if agent.agent_id == agent_id:
            return agent
    return None


def _decision_from_route(route: ResolvedAgentRoute) -> RoutedAgentDecision:
    """Convert a configured route into an executable routing decision.

    Args:
        route: Configured route resolved from repository settings.

    Returns:
        Executable routing decision using the configured agent document.
    """
    return RoutedAgentDecision(
        action=RoutedAgentDecisionAction.EXECUTE,
        agent=route.agent,
        route_scope=route.scope,
        reasoning_summary=f"Resolved agent from {route.scope.value} settings.",
    )


async def resolve_routed_agent(
    invocation: Mapping[str, Any] | SlackAgentInvocation,
    *,
    repository: SlackAgentRepository,
) -> RoutedAgentDecision:
    """Resolve the Slack request into a concrete agent execution decision.

    Args:
        invocation: Raw or validated Slack agent invocation payload.
        repository: Repository used for configured routes and fallback candidates.

    Returns:
        Routing decision describing whether execution should proceed or block.
    """
    parsed_invocation = (
        invocation
        if isinstance(invocation, SlackAgentInvocation)
        else SlackAgentInvocation.from_mapping(invocation)
    )
    route = repository.resolve_agent(
        team_id=parsed_invocation.team_id,
        channel_id=parsed_invocation.channel_id,
        thread_ts=parsed_invocation.thread_ts,
    )
    if route is not None:
        return _decision_from_route(route)

    candidates = repository.list_enabled_agents(
        team_id=parsed_invocation.team_id,
        channel_id=parsed_invocation.channel_id,
        thread_ts=parsed_invocation.thread_ts,
    )
    if not candidates:
        return RoutedAgentDecision(action=RoutedAgentDecisionAction.NO_MATCH)

    selection = await run_agent_selector(
        {
            "text": parsed_invocation.text,
            "team_id": parsed_invocation.team_id,
            "channel_id": parsed_invocation.channel_id,
            "thread_ts": parsed_invocation.thread_ts,
            "candidates": build_selector_candidates(candidates),
        }
    )
    if (
        selection.action == AgentSelectorAction.SELECTED
        and selection.recommended_agent_id is not None
    ):
        matched_agent = _find_agent_document(candidates, selection.recommended_agent_id)
        if matched_agent is None:
            return RoutedAgentDecision(
                action=RoutedAgentDecisionAction.NO_MATCH,
                reasoning_summary=(
                    "Selector returned an agent that is not available in the current"
                    " candidate set."
                ),
            )
        return RoutedAgentDecision(
            action=RoutedAgentDecisionAction.EXECUTE,
            agent=matched_agent,
            reasoning_summary=selection.reasoning_summary,
        )
    if selection.action == AgentSelectorAction.CLARIFICATION_NEEDED:
        return RoutedAgentDecision(
            action=RoutedAgentDecisionAction.CLARIFICATION_NEEDED,
            reasoning_summary=selection.reasoning_summary,
            follow_up_question=selection.follow_up_question,
        )
    return RoutedAgentDecision(
        action=RoutedAgentDecisionAction.NO_MATCH,
        reasoning_summary=selection.reasoning_summary,
    )


async def _run_work_manager_agent(
    invocation: SlackAgentInvocation,
    agent: AgentDocument,
    work_item_repository: WorkItemRepository | None = None,
) -> str:
    """Execute the built-in work-manager runtime for a Slack request.

    Args:
        invocation: Validated Slack request passed into the runtime.
        agent: Stored agent configuration used to resolve the model name.
        work_item_repository: Optional repository override used for tests.

    Returns:
        Slack-ready response text produced by the work-manager agent.
    """
    from agents_party.agents.work_manager import WorkManagerInvocation, run_work_manager

    result = await run_work_manager(
        WorkManagerInvocation.model_validate(invocation.model_dump(mode="python")),
        repository=work_item_repository,
        model=build_agent_model_name(agent),
    )
    return result.follow_up_question or result.message


SLACK_AGENT_EXECUTORS: dict[str, SlackAgentExecutor] = {
    "work-manager": _run_work_manager_agent,
}


async def execute_registered_agent(
    invocation: Mapping[str, Any] | SlackAgentInvocation,
    agent: AgentDocument,
    *,
    work_item_repository: WorkItemRepository | None = None,
) -> str | None:
    """Execute a registered Slack agent runtime when one is available.

    Args:
        invocation: Raw or validated Slack agent invocation payload.
        agent: Stored agent document selected for execution.
        work_item_repository: Optional repository override for runtimes that need it.

    Returns:
        Slack-ready response text, or `None` when no runtime is registered.
    """
    executor = SLACK_AGENT_EXECUTORS.get(agent.agent_id)
    if executor is None:
        return None

    parsed_invocation = (
        invocation
        if isinstance(invocation, SlackAgentInvocation)
        else SlackAgentInvocation.from_mapping(invocation)
    )
    return await executor(parsed_invocation, agent, work_item_repository)


__all__ = [
    "RoutedAgentDecision",
    "RoutedAgentDecisionAction",
    "SLACK_AGENT_EXECUTORS",
    "SlackAgentInvocation",
    "build_agent_model_name",
    "build_selector_candidates",
    "execute_registered_agent",
    "resolve_routed_agent",
]
