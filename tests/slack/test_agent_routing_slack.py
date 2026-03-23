from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pytest

import agents_party.agents.slack_runtime as slack_runtime_module
from agents_party.domain import AgentDocument, AgentRouteScope, ResolvedAgentRoute
from agents_party.slack.features import agent_routing


class SayResponder:
    def __init__(self) -> None:
        """Initialize the fake responder call log.

        Returns:
            None.
        """
        self.calls: list[tuple[str, str | None]] = []

    async def __call__(self, *, text: str, thread_ts: str | None = None) -> None:
        """Record a Slack reply for later assertions.

        Args:
            text: Response text sent by the routing handler.
            thread_ts: Optional thread timestamp used for the reply.

        Returns:
            None.
        """
        self.calls.append((text, thread_ts))


class StubSlackAgentRepository:
    def __init__(
        self,
        *,
        route: ResolvedAgentRoute | None = None,
        agents: list[AgentDocument] | None = None,
    ) -> None:
        """Initialize the fake repository with optional route and candidates.

        Args:
            route: Optional route returned by `resolve_agent`.
            agents: Optional candidate agents returned by `list_enabled_agents`.

        Returns:
            None.
        """
        self.route = route
        self.agents = agents or []
        self.resolve_calls = 0
        self.list_calls = 0

    def resolve_agent(
        self,
        *,
        team_id: str,
        channel_id: str,
        thread_ts: str | None = None,
    ) -> ResolvedAgentRoute | None:
        """Return the configured fake route and count calls.

        Args:
            team_id: Workspace id, unused by the fake.
            channel_id: Channel id, unused by the fake.
            thread_ts: Thread timestamp, unused by the fake.

        Returns:
            Configured fake route, if any.
        """
        del team_id, channel_id, thread_ts
        self.resolve_calls += 1
        return self.route

    def list_enabled_agents(
        self,
        *,
        team_id: str,
        channel_id: str,
        thread_ts: str | None = None,
    ) -> list[AgentDocument]:
        """Return configured fake selector candidates and count calls.

        Args:
            team_id: Workspace id, unused by the fake.
            channel_id: Channel id, unused by the fake.
            thread_ts: Thread timestamp, unused by the fake.

        Returns:
            Copy of the configured fake agent list.
        """
        del team_id, channel_id, thread_ts
        self.list_calls += 1
        return list(self.agents)


def test_build_agent_invocation_from_mention_strips_leading_mentions() -> None:
    """Verify mention parsing strips bot mentions from the routed text.

    Returns:
        None.
    """
    invocation = agent_routing.build_agent_invocation_from_mention(
        {"team_id": "T1"},
        {
            "user": "U1",
            "channel": "C123",
            "ts": "1712345678.000100",
            "thread_ts": "1712345678.000100",
            "text": "<@Ubot>   follow up with finance",
        },
    )

    assert invocation.text == "follow up with finance"
    assert invocation.thread_ts == "1712345678.000100"


@pytest.mark.asyncio
async def test_handle_agent_mention_routes_response_to_thread(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify mention handling replies into the original Slack thread.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub agent invocation.

    Returns:
        None.
    """

    async def fake_invoke_routed_agent(invocation: Any) -> str:
        """Return a deterministic routed-agent response for the test.

        Args:
            invocation: Routing invocation received from the handler.

        Returns:
            Fixed response text used by the assertion.
        """
        assert invocation.text == "mark the checklist complete"
        return "Completed `checklist`."

    monkeypatch.setattr(agent_routing, "invoke_routed_agent", fake_invoke_routed_agent)
    responder = SayResponder()

    await agent_routing.handle_agent_mention(
        {"team_id": "T1"},
        {
            "user": "U1",
            "channel": "C123",
            "ts": "1712345678.000100",
            "thread_ts": "1712345678.000100",
            "text": "<@Ubot> mark the checklist complete",
        },
        responder,
    )

    assert responder.calls == [("Completed `checklist`.", "1712345678.000100")]


@pytest.mark.asyncio
async def test_invoke_routed_agent_skips_selector_when_route_is_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify selector fallback is skipped when a configured route exists.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub the selector.

    Returns:
        None.
    """

    async def fake_execute_registered_agent(*args: Any, **kwargs: Any) -> str:
        """Return a deterministic runtime response for the configured route.

        Args:
            *args: Positional arguments passed to the runtime executor.
            **kwargs: Keyword arguments passed to the runtime executor.

        Returns:
            Fixed response text used by the assertion.
        """
        del args, kwargs
        return "Tracked `channel task`."

    monkeypatch.setattr(
        agent_routing,
        "execute_registered_agent",
        fake_execute_registered_agent,
    )
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

    message = await agent_routing.invoke_routed_agent(
        {
            "team_id": "T1",
            "user_id": "U1",
            "channel_id": "C123",
            "viewer_context_channel_ids": ("C123",),
            "text": "track this",
        },
        repository=repository,
    )

    assert message == "Tracked `channel task`."
    assert repository.list_calls == 0


@pytest.mark.asyncio
async def test_invoke_routed_agent_uses_selector_only_when_route_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify selector fallback runs only when no configured route exists.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub selector execution.

    Returns:
        None.
    """

    async def fake_run_agent_selector(invocation: Mapping[str, Any]) -> Any:
        """Return a deterministic selector result for the routing fallback test.

        Args:
            invocation: Selector invocation payload built by routing.

        Returns:
            Lightweight object emulating a selector result.
        """
        assert invocation["text"] == "summarize this thread"
        assert invocation["candidates"][0].agent_id == "handover-agent"
        return type(
            "SelectorResult",
            (),
            {
                "action": slack_runtime_module.AgentSelectorAction.SELECTED,
                "recommended_agent_id": "handover-agent",
                "reasoning_summary": "The request is a thread summary.",
                "follow_up_question": None,
            },
        )()

    monkeypatch.setattr(
        slack_runtime_module,
        "run_agent_selector",
        fake_run_agent_selector,
    )
    repository = StubSlackAgentRepository(
        agents=[
            AgentDocument(
                agent_id="handover-agent",
                name="Handover Agent",
                description="Builds handoff summaries.",
                when_to_use="Use for shift handoffs and summaries.",
                supported_skill_names=["handover-brief-builder"],
                model_provider="google-gla",
                model_name="gemini-3-flash-preview",
            )
        ]
    )

    message = await agent_routing.invoke_routed_agent(
        {
            "team_id": "T1",
            "user_id": "U1",
            "channel_id": "C123",
            "viewer_context_channel_ids": ("C123",),
            "text": "summarize this thread",
            "thread_ts": "1712345678.000100",
        },
        repository=repository,
    )

    assert "Selected agent `handover-agent` from selector fallback." in message
    assert "No runtime is registered yet." in message
    assert repository.list_calls == 1
