from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pytest

from agents_party.domain import (
    MessageRole,
    ThreadDocument,
    ThreadStatus,
)
from agents_party.infrastructure import TranslationResponse
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
        history_responses: list[Mapping[str, Any]] | None = None,
        error: Exception | None = None,
    ) -> None:
        """Initialize a fake Slack client for history, replies, and post calls.

        Args:
            responses: Ordered paginated responses returned by `conversations_replies`.
            history_responses: Ordered responses returned by `conversations_history`.
            error: Optional exception raised instead of returning a response.

        Returns:
            None.
        """
        self._responses = list(responses or [])
        self._history_responses = list(history_responses or [])
        self._error = error
        self.calls: list[dict[str, Any]] = []
        self.history_calls: list[dict[str, Any]] = []
        self.post_calls: list[dict[str, str | None]] = []

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

    async def conversations_history(
        self,
        *,
        channel: str,
        latest: str,
        oldest: str,
        inclusive: bool,
        limit: int | None = None,
    ) -> Mapping[str, Any]:
        """Return a fake history lookup response for a specific message timestamp.

        Args:
            channel: Slack channel id requested by the caller.
            latest: Inclusive upper-bound timestamp requested by the caller.
            oldest: Inclusive lower-bound timestamp requested by the caller.
            inclusive: Whether Slack should include boundary timestamps.
            limit: Optional page size requested by the caller.

        Returns:
            Fake Slack API response payload.
        """
        self.history_calls.append(
            {
                "channel": channel,
                "latest": latest,
                "oldest": oldest,
                "inclusive": inclusive,
                "limit": limit,
            }
        )
        if self._error is not None:
            raise self._error
        if not self._history_responses:
            return {"ok": True, "messages": []}
        return self._history_responses.pop(0)

    async def chat_postMessage(
        self,
        *,
        channel: str,
        text: str,
        thread_ts: str | None = None,
    ) -> Mapping[str, Any]:
        """Record posted Slack messages for later assertions.

        Args:
            channel: Slack channel id requested by the caller.
            text: Message text posted by the handler.
            thread_ts: Optional root thread timestamp for the reply.

        Returns:
            Fake Slack API response payload.
        """
        self.post_calls.append(
            {
                "channel": channel,
                "text": text,
                "thread_ts": thread_ts,
            }
        )
        if self._error is not None:
            raise self._error
        return {"ok": True, "channel": channel, "ts": thread_ts or "posted"}


class StubSlackAgentRepository:
    def __init__(
        self,
        *,
        channel_enabled: bool = True,
        thread_document: ThreadDocument | None = None,
        auto_reply_enabled: bool = True,
    ) -> None:
        """Initialize the fake repository with channel and thread state.

        Args:
            channel_enabled: Whether the assistant is enabled for the channel.
            thread_document: Optional stored thread document returned by thread lookups.
            auto_reply_enabled: Whether follow-up thread messages should auto-route.

        Returns:
            None.
        """
        self.channel_enabled = channel_enabled
        self.thread_document = thread_document
        self.auto_reply_enabled = auto_reply_enabled
        self.activate_calls: list[dict[str, str]] = []
        self.thread_reads = 0

    def is_channel_enabled(
        self,
        *,
        team_id: str,
        channel_id: str,
    ) -> bool:
        """Return the configured assistant enablement for the channel.

        Args:
            team_id: Workspace id, unused by the fake.
            channel_id: Channel id, unused by the fake.

        Returns:
            Configured channel enablement.
        """
        del team_id, channel_id
        return self.channel_enabled

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
        """Return the configured fake auto-reply value.

        Args:
            team_id: Workspace id, unused by the fake.
            channel_id: Channel id, unused by the fake.

        Returns:
            Configured auto-reply boolean.
        """
        del team_id, channel_id
        return self.auto_reply_enabled


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
async def test_handle_agent_mention_runs_assistant_and_activates_thread(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify explicit mentions execute the assistant and activate the thread.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub assistant execution.

    Returns:
        None.
    """

    async def fake_run_slack_assistant(invocation: Any, **_: Any) -> Any:
        """Return a deterministic assistant result for mention routing tests.

        Args:
            invocation: Slack invocation received from the routing layer.
            **_: Unused keyword arguments.

        Returns:
            Lightweight assistant result object with a fixed message.
        """
        assert [message.role for message in invocation.thread_messages] == [
            MessageRole.USER
        ]
        return type(
            "SlackAssistantResult",
            (),
            {
                "message": "Completed `checklist`.",
                "follow_up_question": None,
            },
        )()

    monkeypatch.setattr(agent_routing, "run_slack_assistant", fake_run_slack_assistant)
    responder = SayResponder()
    repository = StubSlackAgentRepository()
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

    await agent_routing.handle_agent_mention(
        {"team_id": "T1"},
        {
            "user": "U1",
            "channel": "C123",
            "ts": "1712345678.000100",
            "text": "<@Ubot> mark the checklist complete",
        },
        responder,
        client,
        repository=repository,
    )

    assert responder.calls == [("Completed `checklist`.", "1712345678.000100")]
    assert repository.activate_calls == [
        {
            "team_id": "T1",
            "channel_id": "C123",
            "thread_ts": "1712345678.000100",
            "agent_id": "assistant",
            "root_message_ts": "1712345678.000100",
            "last_message_ts": "1712345678.000100",
        }
    ]


@pytest.mark.asyncio
async def test_handle_agent_message_routes_active_thread_follow_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify active assistant threads auto-route follow-up messages.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub assistant execution.

    Returns:
        None.
    """

    async def fake_run_slack_assistant(invocation: Any, **_: Any) -> Any:
        """Return a deterministic assistant result for follow-up routing tests.

        Args:
            invocation: Slack invocation received from the routing layer.
            **_: Unused keyword arguments.

        Returns:
            Lightweight assistant result object with a fixed message.
        """
        assert invocation.text == "please also tag finance"
        return type(
            "SlackAssistantResult",
            (),
            {"message": "Tagged finance.", "follow_up_question": None},
        )()

    monkeypatch.setattr(agent_routing, "run_slack_assistant", fake_run_slack_assistant)
    responder = SayResponder()
    repository = StubSlackAgentRepository(
        thread_document=ThreadDocument(
            thread_ts="1712345678.000100",
            root_message_ts="1712345678.000100",
            channel_id="C123",
            team_id="T1",
            status=ThreadStatus.ACTIVE,
            agent_id="assistant",
            last_message_ts="1712345678.000100",
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
                        "text": "<@Ubot> summarize this thread",
                    },
                    {
                        "ts": "1712345680.000100",
                        "user": "U1",
                        "text": "please also tag finance",
                    },
                ],
            }
        ]
    )

    await agent_routing.handle_agent_message(
        {"team_id": "T1"},
        {
            "user": "U1",
            "channel": "C123",
            "ts": "1712345680.000100",
            "thread_ts": "1712345678.000100",
            "text": "please also tag finance",
        },
        responder,
        client,
        bot_user_id="Ubot",
        repository=repository,
    )

    assert responder.calls == [("Tagged finance.", "1712345678.000100")]
    assert repository.activate_calls[-1]["agent_id"] == "assistant"


@pytest.mark.asyncio
async def test_handle_agent_mention_returns_unconfigured_for_disabled_channel() -> None:
    """Verify disabled channels do not run the assistant for new mentions.

    Returns:
        None.
    """
    responder = SayResponder()
    repository = StubSlackAgentRepository(channel_enabled=False)

    await agent_routing.handle_agent_mention(
        {"team_id": "T1"},
        {
            "user": "U1",
            "channel": "C123",
            "ts": "1712345678.000100",
            "text": "<@Ubot> summarize this thread",
        },
        responder,
        repository=repository,
    )

    assert responder.calls == [
        (
            "The Slack assistant is not enabled for this workspace or channel.\n"
            + agent_routing.build_agent_help_message("U1"),
            "1712345678.000100",
        )
    ]
    assert repository.activate_calls == []


@pytest.mark.asyncio
async def test_handle_agent_message_ignores_disabled_channel_follow_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify disabled channels do not auto-route active-thread follow-ups.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to assert assistant non-execution.

    Returns:
        None.
    """

    async def fail_run_slack_assistant(*_: Any, **__: Any) -> Any:
        """Fail the test if the assistant is invoked unexpectedly.

        Args:
            *_: Unused positional arguments.
            **__: Unused keyword arguments.

        Returns:
            Never returns because the function always raises.
        """
        raise AssertionError("run_slack_assistant should not run")

    monkeypatch.setattr(agent_routing, "run_slack_assistant", fail_run_slack_assistant)
    responder = SayResponder()
    repository = StubSlackAgentRepository(
        channel_enabled=False,
        thread_document=ThreadDocument(
            thread_ts="1712345678.000100",
            root_message_ts="1712345678.000100",
            channel_id="C123",
            team_id="T1",
            status=ThreadStatus.ACTIVE,
            agent_id="assistant",
            last_message_ts="1712345678.000100",
        ),
    )

    await agent_routing.handle_agent_message(
        {"team_id": "T1"},
        {
            "user": "U1",
            "channel": "C123",
            "ts": "1712345680.000100",
            "thread_ts": "1712345678.000100",
            "text": "please also tag finance",
        },
        responder,
        bot_user_id="Ubot",
        repository=repository,
    )

    assert responder.calls == []


@pytest.mark.asyncio
async def test_invoke_routed_agent_returns_context_error_for_unsupported_thread_history(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify invalid thread history prevents assistant execution.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to assert assistant non-execution.

    Returns:
        None.
    """

    async def fail_run_slack_assistant(*_: Any, **__: Any) -> Any:
        """Fail the test if the assistant is invoked unexpectedly.

        Args:
            *_: Unused positional arguments.
            **__: Unused keyword arguments.

        Returns:
            Never returns because the function always raises.
        """
        raise AssertionError("run_slack_assistant should not run")

    monkeypatch.setattr(agent_routing, "run_slack_assistant", fail_run_slack_assistant)
    repository = StubSlackAgentRepository()
    client = FakeSlackClient(
        [
            {
                "ok": True,
                "messages": [
                    {
                        "ts": "1712345678.000100",
                        "subtype": "channel_join",
                        "text": "joined the channel",
                    }
                ],
            }
        ]
    )

    response_text = await agent_routing.invoke_routed_agent(
        {
            "team_id": "T1",
            "user_id": "U1",
            "channel_id": "C123",
            "text": "summarize this thread",
            "thread_ts": "1712345678.000100",
            "message_ts": "1712345678.000100",
        },
        client=client,
        repository=repository,
    )

    assert response_text == agent_routing.build_thread_context_error_message("U1")


@pytest.mark.asyncio
async def test_handle_translation_reaction_translates_flagged_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify flag reactions translate the reacted message in the message thread.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub translation service creation.

    Returns:
        None.
    """

    class FakeTranslationService:
        def translate_text(self, **_: Any) -> TranslationResponse:
            """Return a deterministic translation response for reaction tests.

            Args:
                **_: Unused keyword arguments.

            Returns:
                Fixed translated text payload.
            """
            return TranslationResponse(translated_text="こんにちは")

    monkeypatch.setattr(
        agent_routing,
        "_build_translation_service",
        lambda: FakeTranslationService(),
    )
    client = FakeSlackClient(
        history_responses=[
            {
                "ok": True,
                "messages": [
                    {
                        "ts": "1712345678.000100",
                        "text": "Hello",
                    }
                ],
            }
        ]
    )

    await agent_routing.handle_translation_reaction(
        {"team_id": "T1"},
        {
            "user": "U1",
            "reaction": "flag-jp",
            "item": {
                "type": "message",
                "channel": "C123",
                "ts": "1712345678.000100",
            },
        },
        client=client,
    )

    assert client.post_calls == [
        {
            "channel": "C123",
            "text": "こんにちは",
            "thread_ts": "1712345678.000100",
        }
    ]
