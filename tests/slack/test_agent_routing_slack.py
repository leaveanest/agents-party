from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pytest

import agents_party.agents.slack_runtime as slack_runtime_module
from agents_party.domain import (
    AgentDocument,
    AgentRouteScope,
    MessageRole,
    ResolvedAgentRoute,
    ThreadDocument,
    ThreadStatus,
)
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


class FakeSlackClient:
    def __init__(
        self,
        responses: list[Mapping[str, Any]] | None = None,
        *,
        error: Exception | None = None,
    ) -> None:
        """Initialize a fake Slack client for thread history calls.

        Args:
            responses: Ordered paginated responses returned by `conversations_replies`.
            error: Optional exception raised instead of returning a response.

        Returns:
            None.
        """
        self._responses = list(responses or [])
        self._error = error
        self.calls: list[dict[str, Any]] = []

    async def conversations_replies(
        self,
        *,
        channel: str,
        ts: str,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> Mapping[str, Any]:
        """Return a fake paginated thread history response.

        Args:
            channel: Slack channel id requested by the caller.
            ts: Slack root thread timestamp requested by the caller.
            cursor: Optional Slack pagination cursor.
            limit: Optional page size requested by the caller.

        Returns:
            Fake Slack API response payload.
        """
        self.calls.append(
            {
                "channel": channel,
                "ts": ts,
                "cursor": cursor,
                "limit": limit,
            }
        )
        if self._error is not None:
            raise self._error

        if not self._responses:
            return {"ok": True, "messages": []}
        return self._responses.pop(0)


class StubSlackAgentRepository:
    def __init__(
        self,
        *,
        route: ResolvedAgentRoute | None = None,
        agents: list[AgentDocument] | None = None,
        thread_document: ThreadDocument | None = None,
        auto_reply_enabled: bool = True,
    ) -> None:
        """Initialize the fake repository with optional route, candidates, and thread state.

        Args:
            route: Optional route returned by `resolve_agent`.
            agents: Optional candidate agents returned by `list_enabled_agents`.
            thread_document: Optional stored thread document returned by thread lookups.
            auto_reply_enabled: Whether follow-up thread messages should auto-route.

        Returns:
            None.
        """
        self.route = route
        self.agents = agents or []
        self.thread_document = thread_document
        self.auto_reply_enabled = auto_reply_enabled
        self.resolve_calls = 0
        self.list_calls = 0
        self.activate_calls: list[dict[str, str]] = []
        self.thread_reads = 0
        self.auto_reply_reads = 0

    def resolve_agent(
        self,
        *,
        team_id: str,
        channel_id: str,
        thread_ts: str | None = None,
    ) -> ResolvedAgentRoute | None:
        """Return the configured fake route and count calls.

        Args:
            team_id: Workspace id used to build a fallback thread route.
            channel_id: Channel id used to build a fallback thread route.
            thread_ts: Thread timestamp used to build a fallback thread route.

        Returns:
            Configured fake route, or a derived thread route when thread state exists.
        """
        self.resolve_calls += 1
        if self.route is not None:
            return self.route
        if (
            self.thread_document is not None
            and self.thread_document.agent_id is not None
            and thread_ts == self.thread_document.thread_ts
        ):
            for agent in self.agents:
                if agent.agent_id == self.thread_document.agent_id:
                    return ResolvedAgentRoute(
                        scope=AgentRouteScope.THREAD,
                        agent=agent,
                        team_id=team_id,
                        channel_id=channel_id,
                        thread_ts=thread_ts,
                    )
        return None

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

    def get_thread_document(
        self,
        *,
        team_id: str,
        channel_id: str,
        thread_ts: str,
    ) -> ThreadDocument | None:
        """Return the configured thread document and count reads.

        Args:
            team_id: Workspace id, unused by the fake.
            channel_id: Channel id, unused by the fake.
            thread_ts: Thread timestamp used to select the stored thread state.

        Returns:
            Stored thread document when the timestamps match, else `None`.
        """
        del team_id, channel_id
        self.thread_reads += 1
        if self.thread_document is None or self.thread_document.thread_ts != thread_ts:
            return None
        return self.thread_document

    def activate_thread_agent(
        self,
        *,
        team_id: str,
        channel_id: str,
        thread_ts: str,
        agent_id: str,
        root_message_ts: str,
        last_message_ts: str,
    ) -> ThreadDocument:
        """Persist a fake active thread route for later assertions.

        Args:
            team_id: Workspace id owning the thread.
            channel_id: Channel id owning the thread.
            thread_ts: Slack thread timestamp.
            agent_id: Agent id that handled the thread.
            root_message_ts: Root Slack message timestamp.
            last_message_ts: Latest Slack message timestamp in the transcript.

        Returns:
            Stored thread document reflecting the new active route.
        """
        self.activate_calls.append(
            {
                "team_id": team_id,
                "channel_id": channel_id,
                "thread_ts": thread_ts,
                "agent_id": agent_id,
                "root_message_ts": root_message_ts,
                "last_message_ts": last_message_ts,
            }
        )
        self.thread_document = ThreadDocument(
            thread_ts=thread_ts,
            root_message_ts=root_message_ts,
            channel_id=channel_id,
            team_id=team_id,
            status=ThreadStatus.ACTIVE,
            agent_id=agent_id,
            last_message_ts=last_message_ts,
        )
        return self.thread_document

    def is_thread_auto_reply_enabled(
        self,
        *,
        team_id: str,
        channel_id: str,
    ) -> bool:
        """Return the configured fake auto-reply value and count reads.

        Args:
            team_id: Workspace id, unused by the fake.
            channel_id: Channel id, unused by the fake.

        Returns:
            Configured auto-reply boolean.
        """
        del team_id, channel_id
        self.auto_reply_reads += 1
        return self.auto_reply_enabled


def _work_manager_agent() -> AgentDocument:
    """Build a representative registered work-manager agent document.

    Returns:
        Configured work-manager agent document for tests.
    """
    return AgentDocument(
        agent_id="work-manager",
        name="Work Manager",
        model_provider="google-gla",
        model_name="gemini-3-flash-preview",
    )


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


def test_build_agent_invocation_from_message_preserves_follow_up_text() -> None:
    """Verify follow-up message parsing keeps the original thread reply text.

    Returns:
        None.
    """
    invocation = agent_routing.build_agent_invocation_from_message(
        {"team_id": "T1"},
        {
            "user": "U1",
            "channel": "C123",
            "ts": "1712345680.000100",
            "thread_ts": "1712345678.000100",
            "text": "please also tag finance",
        },
    )

    assert invocation.text == "please also tag finance"
    assert invocation.thread_ts == "1712345678.000100"


@pytest.mark.asyncio
async def test_handle_agent_message_routes_explicit_mention_and_activates_thread(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify explicit mentions are handled from `message` events and activate the thread.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub runtime execution.

    Returns:
        None.
    """

    async def fake_execute_registered_agent(
        invocation: Any,
        agent: AgentDocument,
        work_item_repository: Any | None = None,
    ) -> str:
        """Return a deterministic routed-agent response for the test.

        Args:
            invocation: Routing invocation received by the runtime layer.
            agent: Routed agent selected for execution.
            work_item_repository: Optional repository override, unused by the fake.

        Returns:
            Fixed response text used by the assertion.
        """
        del work_item_repository
        assert agent.agent_id == "work-manager"
        assert [message.role for message in invocation.thread_messages] == [
            MessageRole.USER
        ]
        return "Completed `checklist`."

    monkeypatch.setattr(
        agent_routing,
        "execute_registered_agent",
        fake_execute_registered_agent,
    )
    responder = SayResponder()
    repository = StubSlackAgentRepository(
        route=ResolvedAgentRoute(
            scope=AgentRouteScope.CHANNEL,
            agent=_work_manager_agent(),
            team_id="T1",
            channel_id="C123",
            thread_ts="1712345678.000100",
        )
    )
    client = FakeSlackClient(
        [
            {
                "ok": True,
                "messages": [
                    {
                        "ts": "1712345678.000100",
                        "user": "U1",
                        "text": "<@Ubot> mark the checklist complete",
                    }
                ],
            }
        ]
    )

    await agent_routing.handle_agent_message(
        {"team_id": "T1"},
        {
            "user": "U1",
            "channel": "C123",
            "ts": "1712345678.000100",
            "text": "<@Ubot> mark the checklist complete",
        },
        responder,
        client,
        bot_user_id="Ubot",
        repository=repository,
    )

    assert responder.calls == [("Completed `checklist`.", "1712345678.000100")]
    assert repository.activate_calls == [
        {
            "team_id": "T1",
            "channel_id": "C123",
            "thread_ts": "1712345678.000100",
            "agent_id": "work-manager",
            "root_message_ts": "1712345678.000100",
            "last_message_ts": "1712345678.000100",
        }
    ]


@pytest.mark.asyncio
async def test_selector_fallback_activation_is_reused_for_follow_up_messages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify selector fallback activates the thread and later follow-ups reuse it.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub selector and runtime execution.

    Returns:
        None.
    """
    responses = iter(["Handled initial request.", "Handled follow-up request."])

    async def fake_run_agent_selector(invocation: Mapping[str, Any]) -> Any:
        """Return a deterministic selector result for the routing fallback test.

        Args:
            invocation: Selector invocation payload built by routing.

        Returns:
            Lightweight object emulating a selector result.
        """
        assert invocation["candidates"][0].agent_id == "work-manager"
        return type(
            "SelectorResult",
            (),
            {
                "action": slack_runtime_module.AgentSelectorAction.SELECTED,
                "recommended_agent_id": "work-manager",
                "reasoning_summary": "The request matches the work manager.",
                "follow_up_question": None,
            },
        )()

    async def fake_execute_registered_agent(
        invocation: Any,
        agent: AgentDocument,
        work_item_repository: Any | None = None,
    ) -> str:
        """Return a deterministic response for each invocation.

        Args:
            invocation: Routing invocation received by the runtime layer.
            agent: Routed agent selected for execution.
            work_item_repository: Optional repository override, unused by the fake.

        Returns:
            Next deterministic response string from the iterator.
        """
        del work_item_repository
        assert agent.agent_id == "work-manager"
        assert invocation.thread_messages[-1].role == MessageRole.USER
        return next(responses)

    monkeypatch.setattr(
        slack_runtime_module,
        "run_agent_selector",
        fake_run_agent_selector,
    )
    monkeypatch.setattr(
        agent_routing,
        "execute_registered_agent",
        fake_execute_registered_agent,
    )
    repository = StubSlackAgentRepository(agents=[_work_manager_agent()])
    responder = SayResponder()
    client = FakeSlackClient(
        [
            {
                "ok": True,
                "messages": [
                    {
                        "ts": "1712345678.000100",
                        "user": "U1",
                        "text": "<@Ubot> capture a task",
                    }
                ],
            },
            {
                "ok": True,
                "messages": [
                    {
                        "ts": "1712345678.000100",
                        "user": "U1",
                        "text": "<@Ubot> capture a task",
                    },
                    {
                        "ts": "1712345680.000100",
                        "user": "U1",
                        "text": "also assign it to finance",
                    },
                ],
            },
        ]
    )

    await agent_routing.handle_agent_message(
        {"team_id": "T1"},
        {
            "user": "U1",
            "channel": "C123",
            "ts": "1712345678.000100",
            "text": "<@Ubot> capture a task",
        },
        responder,
        client,
        bot_user_id="Ubot",
        repository=repository,
    )

    selector_list_calls = repository.list_calls
    await agent_routing.handle_agent_message(
        {"team_id": "T1"},
        {
            "user": "U1",
            "channel": "C123",
            "ts": "1712345680.000100",
            "thread_ts": "1712345678.000100",
            "text": "also assign it to finance",
        },
        responder,
        client,
        bot_user_id="Ubot",
        repository=repository,
    )

    assert responder.calls == [
        ("Handled initial request.", "1712345678.000100"),
        ("Handled follow-up request.", "1712345678.000100"),
    ]
    assert selector_list_calls == 1
    assert repository.list_calls == selector_list_calls
    assert repository.thread_document is not None
    assert repository.thread_document.agent_id == "work-manager"


@pytest.mark.parametrize(
    ("event", "thread_document", "auto_reply_enabled"),
    [
        (
            {
                "user": "U1",
                "channel": "C123",
                "ts": "1712345680.000100",
                "thread_ts": "1712345678.000100",
                "text": "   ",
            },
            ThreadDocument(
                thread_ts="1712345678.000100",
                root_message_ts="1712345678.000100",
                channel_id="C123",
                team_id="T1",
                status=ThreadStatus.ACTIVE,
                agent_id="work-manager",
            ),
            True,
        ),
        (
            {
                "user": "U1",
                "channel": "C123",
                "ts": "1712345680.000100",
                "text": "outside the thread",
            },
            ThreadDocument(
                thread_ts="1712345678.000100",
                root_message_ts="1712345678.000100",
                channel_id="C123",
                team_id="T1",
                status=ThreadStatus.ACTIVE,
                agent_id="work-manager",
            ),
            True,
        ),
        (
            {
                "user": "U1",
                "channel": "C123",
                "ts": "1712345680.000100",
                "thread_ts": "1712345678.000100",
                "text": "edited",
                "subtype": "message_changed",
            },
            ThreadDocument(
                thread_ts="1712345678.000100",
                root_message_ts="1712345678.000100",
                channel_id="C123",
                team_id="T1",
                status=ThreadStatus.ACTIVE,
                agent_id="work-manager",
            ),
            True,
        ),
        (
            {
                "user": "U1",
                "channel": "C123",
                "ts": "1712345680.000100",
                "thread_ts": "1712345678.000100",
                "text": "bot authored",
                "bot_id": "B1",
            },
            ThreadDocument(
                thread_ts="1712345678.000100",
                root_message_ts="1712345678.000100",
                channel_id="C123",
                team_id="T1",
                status=ThreadStatus.ACTIVE,
                agent_id="work-manager",
            ),
            True,
        ),
        (
            {
                "user": "U1",
                "channel": "C123",
                "ts": "1712345680.000100",
                "thread_ts": "1712345678.000100",
                "text": "inactive thread",
            },
            ThreadDocument(
                thread_ts="1712345678.000100",
                root_message_ts="1712345678.000100",
                channel_id="C123",
                team_id="T1",
                status=ThreadStatus.CLOSED,
                agent_id="work-manager",
            ),
            True,
        ),
        (
            {
                "user": "U1",
                "channel": "C123",
                "ts": "1712345680.000100",
                "thread_ts": "1712345678.000100",
                "text": "auto reply disabled",
            },
            ThreadDocument(
                thread_ts="1712345678.000100",
                root_message_ts="1712345678.000100",
                channel_id="C123",
                team_id="T1",
                status=ThreadStatus.ACTIVE,
                agent_id="work-manager",
            ),
            False,
        ),
    ],
)
@pytest.mark.asyncio
async def test_handle_agent_message_ignores_unsupported_follow_up_events(
    monkeypatch: pytest.MonkeyPatch,
    event: dict[str, str],
    thread_document: ThreadDocument,
    auto_reply_enabled: bool,
) -> None:
    """Verify invalid follow-up message events do not trigger auto-routing.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to guard against invocation.
        event: Slack event payload under test.
        thread_document: Stored thread document returned by the fake repository.
        auto_reply_enabled: Effective thread auto-reply setting for the fake repository.

    Returns:
        None.
    """

    async def fail_invoke_routed_agent(*args: Any, **kwargs: Any) -> str:
        """Fail the test if follow-up routing runs unexpectedly.

        Args:
            *args: Positional invocation arguments, unused.
            **kwargs: Keyword invocation arguments, unused.

        Returns:
            Never returns because the test fails first.
        """
        del args, kwargs
        raise AssertionError("invoke_routed_agent should not run for ignored events")

    monkeypatch.setattr(agent_routing, "invoke_routed_agent", fail_invoke_routed_agent)
    responder = SayResponder()
    repository = StubSlackAgentRepository(
        agents=[_work_manager_agent()],
        thread_document=thread_document,
        auto_reply_enabled=auto_reply_enabled,
    )

    await agent_routing.handle_agent_message(
        {"team_id": "T1"},
        event,
        responder,
        FakeSlackClient(),
        bot_user_id="Ubot",
        repository=repository,
    )

    assert responder.calls == []


@pytest.mark.asyncio
async def test_handle_agent_message_ignores_other_users_mentions_for_new_threads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify message events do not start routing for mentions that target another user.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to guard against invocation.

    Returns:
        None.
    """

    async def fail_handle_agent_mention(*args: Any, **kwargs: Any) -> None:
        """Fail the test if explicit-mention routing runs unexpectedly.

        Args:
            *args: Positional invocation arguments, unused.
            **kwargs: Keyword invocation arguments, unused.

        Returns:
            Never returns because the test fails first.
        """
        del args, kwargs
        raise AssertionError(
            "handle_agent_mention should not run for another user's mention"
        )

    monkeypatch.setattr(
        agent_routing, "handle_agent_mention", fail_handle_agent_mention
    )
    responder = SayResponder()

    await agent_routing.handle_agent_message(
        {"team_id": "T1"},
        {
            "user": "U1",
            "channel": "C123",
            "ts": "1712345678.000100",
            "text": "<@Uother> this should not route",
        },
        responder,
        FakeSlackClient(),
        bot_user_id="Ubot",
        repository=StubSlackAgentRepository(),
    )

    assert responder.calls == []


@pytest.mark.asyncio
async def test_invoke_routed_agent_fetches_thread_history_normalizes_and_activates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify execution uses normalized full-thread context and activates the thread.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub runtime execution.

    Returns:
        None.
    """

    async def fake_execute_registered_agent(
        invocation: Any,
        agent: AgentDocument,
        work_item_repository: Any | None = None,
    ) -> str:
        """Assert normalized transcript content before returning a fixed response.

        Args:
            invocation: Routing invocation received by the runtime layer.
            agent: Routed agent selected for execution.
            work_item_repository: Optional repository override, unused by the fake.

        Returns:
            Fixed response text used by the assertion.
        """
        del work_item_repository
        assert agent.agent_id == "work-manager"
        assert [message.role for message in invocation.thread_messages] == [
            MessageRole.USER,
            MessageRole.ASSISTANT,
            MessageRole.USER,
        ]
        assert [message.text for message in invocation.thread_messages] == [
            "initial request",
            "ack",
            "follow-up detail",
        ]
        return "Tracked `channel task`."

    monkeypatch.setattr(
        agent_routing,
        "execute_registered_agent",
        fake_execute_registered_agent,
    )
    repository = StubSlackAgentRepository(
        route=ResolvedAgentRoute(
            scope=AgentRouteScope.CHANNEL,
            agent=_work_manager_agent(),
            team_id="T1",
            channel_id="C123",
            thread_ts="1712345678.000100",
        )
    )
    client = FakeSlackClient(
        [
            {
                "ok": True,
                "messages": [
                    {
                        "ts": "1712345678.000100",
                        "user": "U1",
                        "text": "initial request",
                    },
                    {
                        "ts": "1712345678.000200",
                        "subtype": "bot_message",
                        "bot_id": "B1",
                        "text": "ack",
                    },
                ],
                "response_metadata": {"next_cursor": "cursor-1"},
            },
            {
                "ok": True,
                "messages": [
                    {
                        "ts": "1712345678.000300",
                        "user": "U1",
                        "text": "follow-up detail",
                    }
                ],
                "response_metadata": {"next_cursor": ""},
            },
        ]
    )

    message = await agent_routing.invoke_routed_agent(
        {
            "team_id": "T1",
            "user_id": "U1",
            "channel_id": "C123",
            "viewer_context_channel_ids": ("C123",),
            "text": "track this",
            "thread_ts": "1712345678.000100",
            "message_ts": "1712345678.000300",
        },
        client=client,
        repository=repository,
    )

    assert message == "Tracked `channel task`."
    assert repository.activate_calls == [
        {
            "team_id": "T1",
            "channel_id": "C123",
            "thread_ts": "1712345678.000100",
            "agent_id": "work-manager",
            "root_message_ts": "1712345678.000100",
            "last_message_ts": "1712345678.000300",
        }
    ]
    assert client.calls[0]["cursor"] is None
    assert client.calls[1]["cursor"] == "cursor-1"


@pytest.mark.asyncio
async def test_invoke_routed_agent_returns_context_error_for_unsupported_thread_history(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify unsupported thread history skips execution and leaves thread state unchanged.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to guard against runtime execution.

    Returns:
        None.
    """

    async def fail_execute_registered_agent(*args: Any, **kwargs: Any) -> str:
        """Fail the test if runtime execution runs unexpectedly.

        Args:
            *args: Positional invocation arguments, unused.
            **kwargs: Keyword invocation arguments, unused.

        Returns:
            Never returns because the test fails first.
        """
        del args, kwargs
        raise AssertionError("execute_registered_agent should not run")

    monkeypatch.setattr(
        agent_routing,
        "execute_registered_agent",
        fail_execute_registered_agent,
    )
    repository = StubSlackAgentRepository(
        route=ResolvedAgentRoute(
            scope=AgentRouteScope.CHANNEL,
            agent=_work_manager_agent(),
            team_id="T1",
            channel_id="C123",
        )
    )
    client = FakeSlackClient(
        [
            {
                "ok": True,
                "messages": [
                    {
                        "ts": "1712345678.000100",
                        "user": "U1",
                        "text": "initial request",
                    },
                    {
                        "ts": "1712345678.000200",
                        "subtype": "message_changed",
                        "text": "edited",
                    },
                ],
            }
        ]
    )

    message = await agent_routing.invoke_routed_agent(
        {
            "team_id": "T1",
            "user_id": "U1",
            "channel_id": "C123",
            "viewer_context_channel_ids": ("C123",),
            "text": "track this",
            "thread_ts": "1712345678.000100",
            "message_ts": "1712345678.000100",
        },
        client=client,
        repository=repository,
    )

    assert "I couldn't load the full Slack thread context" in message
    assert repository.activate_calls == []


@pytest.mark.asyncio
async def test_invoke_routed_agent_does_not_activate_for_unimplemented_agent() -> None:
    """Verify unsupported runtimes do not mark the thread as active.

    Returns:
        None.
    """
    repository = StubSlackAgentRepository(
        route=ResolvedAgentRoute(
            scope=AgentRouteScope.THREAD,
            agent=AgentDocument(
                agent_id="handover-agent",
                name="Handover Agent",
                model_provider="google-gla",
                model_name="gemini-3-flash-preview",
            ),
            team_id="T1",
            channel_id="C123",
            thread_ts="1712345678.000100",
        )
    )
    client = FakeSlackClient(
        [
            {
                "ok": True,
                "messages": [
                    {
                        "ts": "1712345678.000100",
                        "user": "U1",
                        "text": "summarize this thread",
                    }
                ],
            }
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
            "message_ts": "1712345678.000100",
        },
        client=client,
        repository=repository,
    )

    assert "No runtime is registered yet." in message
    assert repository.activate_calls == []
