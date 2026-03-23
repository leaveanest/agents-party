from __future__ import annotations

from typing import Any

import pytest

import agents_party.agents.slack_runtime as slack_runtime
import agents_party.agents.work_manager as work_manager_module
from agents_party.agents.slack_runtime import (
    RoutedAgentDecisionAction,
    SlackAgentInvocation,
    execute_registered_agent,
    resolve_routed_agent,
)
from agents_party.agents.work_manager import WorkManagerAction, WorkManagerResult
from agents_party.domain import AgentDocument, AgentRouteScope, ResolvedAgentRoute


class StubSlackAgentRepository:
    def __init__(
        self,
        *,
        route: ResolvedAgentRoute | None = None,
        agents: list[AgentDocument] | None = None,
    ) -> None:
        """Initialize the fake routing repository for runtime tests.

        Args:
            route: Optional configured route returned by `resolve_agent`.
            agents: Optional selector candidates returned by `list_enabled_agents`.

        Returns:
            None.
        """
        self.route = route
        self.agents = agents or []

    def resolve_agent(
        self,
        *,
        team_id: str,
        channel_id: str,
        thread_ts: str | None = None,
    ) -> ResolvedAgentRoute | None:
        """Return the configured route for the supplied Slack context.

        Args:
            team_id: Workspace id, unused by the fake repository.
            channel_id: Channel id, unused by the fake repository.
            thread_ts: Thread timestamp, unused by the fake repository.

        Returns:
            Configured route, if any.
        """
        del team_id, channel_id, thread_ts
        return self.route

    def list_enabled_agents(
        self,
        *,
        team_id: str,
        channel_id: str,
        thread_ts: str | None = None,
    ) -> list[AgentDocument]:
        """Return the configured selector candidates for the Slack context.

        Args:
            team_id: Workspace id, unused by the fake repository.
            channel_id: Channel id, unused by the fake repository.
            thread_ts: Thread timestamp, unused by the fake repository.

        Returns:
            Copy of the configured candidate list.
        """
        del team_id, channel_id, thread_ts
        return list(self.agents)


def make_invocation() -> SlackAgentInvocation:
    """Build a representative Slack invocation for runtime tests.

    Returns:
        Slack invocation containing channel, thread, and user request context.
    """
    return SlackAgentInvocation(
        team_id="T1",
        user_id="U1",
        channel_id="C123",
        viewer_context_channel_ids=["C123"],
        text="follow up with finance",
        thread_ts="1712345678.000100",
        message_ts="1712345678.000100",
    )


@pytest.mark.asyncio
async def test_resolve_routed_agent_prefers_configured_route() -> None:
    """Verify configured routing returns an executable decision immediately.

    Returns:
        None.
    """
    repository = StubSlackAgentRepository(
        route=ResolvedAgentRoute(
            scope=AgentRouteScope.CHANNEL,
            agent=AgentDocument(
                agent_id="work-manager",
                name="Work Manager",
                model_provider="google-gla",
                model_name="gemini-3-flash-preview",
            ),
            team_id="T1",
            channel_id="C123",
        )
    )

    decision = await resolve_routed_agent(make_invocation(), repository=repository)

    assert decision.action == RoutedAgentDecisionAction.EXECUTE
    assert decision.agent is not None
    assert decision.agent.agent_id == "work-manager"
    assert decision.route_scope == AgentRouteScope.CHANNEL


@pytest.mark.asyncio
async def test_resolve_routed_agent_uses_selector_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify selector fallback produces an executable decision when needed.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub selector execution.

    Returns:
        None.
    """

    async def fake_run_agent_selector(invocation: dict[str, Any]) -> Any:
        """Return a deterministic selector result for the fallback flow.

        Args:
            invocation: Selector invocation payload built by runtime routing.

        Returns:
            Lightweight object emulating a selector result.
        """
        assert invocation["text"] == "follow up with finance"
        return type(
            "SelectorResult",
            (),
            {
                "action": slack_runtime.AgentSelectorAction.SELECTED,
                "recommended_agent_id": "handover-agent",
                "reasoning_summary": "The request looks like a handoff summary.",
                "follow_up_question": None,
            },
        )()

    monkeypatch.setattr(slack_runtime, "run_agent_selector", fake_run_agent_selector)
    repository = StubSlackAgentRepository(
        agents=[
            AgentDocument(
                agent_id="handover-agent",
                name="Handover Agent",
                description="Builds handoff summaries.",
                model_provider="google-gla",
                model_name="gemini-3-flash-preview",
            )
        ]
    )

    decision = await resolve_routed_agent(make_invocation(), repository=repository)

    assert decision.action == RoutedAgentDecisionAction.EXECUTE
    assert decision.agent is not None
    assert decision.agent.agent_id == "handover-agent"
    assert decision.reasoning_summary == "The request looks like a handoff summary."


@pytest.mark.asyncio
async def test_execute_registered_agent_runs_work_manager(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify the registered work-manager runtime delegates to `run_work_manager`.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub work-manager execution.

    Returns:
        None.
    """

    async def fake_run_work_manager(
        invocation: Any,
        *,
        repository: Any = None,
        model: str | None = None,
        request_preparer: Any = None,
    ) -> WorkManagerResult:
        """Return a deterministic work-manager result for runtime execution.

        Args:
            invocation: Work-manager invocation built by the runtime executor.
            repository: Optional repository override, unused by this fake.
            model: Provider-qualified model string selected from the agent document.
            request_preparer: Optional request preparer override, unused by this fake.

        Returns:
            Fixed work-manager result used by the assertion.
        """
        del repository, request_preparer
        assert invocation.channel_id == "C123"
        assert model == "google-gla:gemini-3-flash-preview"
        return WorkManagerResult(
            action=WorkManagerAction.NO_OP,
            message="Handled by work manager.",
            work_items=[],
            needs_confirmation=False,
            follow_up_question=None,
        )

    monkeypatch.setattr(work_manager_module, "run_work_manager", fake_run_work_manager)

    response_text = await execute_registered_agent(
        make_invocation(),
        AgentDocument(
            agent_id="work-manager",
            name="Work Manager",
            model_provider="google-gla",
            model_name="gemini-3-flash-preview",
        ),
    )

    assert response_text == "Handled by work manager."


@pytest.mark.asyncio
async def test_execute_registered_agent_returns_none_for_unregistered_agent() -> None:
    """Verify runtime execution reports unsupported agents without raising.

    Returns:
        None.
    """
    response_text = await execute_registered_agent(
        make_invocation(),
        AgentDocument(
            agent_id="handover-agent",
            name="Handover Agent",
            model_provider="google-gla",
            model_name="gemini-3-flash-preview",
        ),
    )

    assert response_text is None
