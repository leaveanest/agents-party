"""Tests for Slack mention routing, follow-up routing, translation, and transcription."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from typing import Any

import pytest
from pydantic_ai import BinaryContent, BinaryImage

from agents_party.agents.slack_runtime import SlackReferenceImage
from agents_party.domain import (
    MessageRole,
    ThreadMessage,
    ThreadDocument,
    ThreadStatus,
)
from agents_party.infrastructure import (
    TranscriptionResponse,
    TranscriptionSegment,
    TranslationResponse,
)
from agents_party.slack.features import agent_routing


class SayResponder:
    def __init__(self) -> None:
        """Initialize the fake responder call log.

        Returns:
            None.
        """
        self.calls: list[dict[str, Any]] = []

    async def __call__(
        self,
        *,
        text: str,
        thread_ts: str | None = None,
        blocks: Sequence[Mapping[str, Any]] | None = None,
    ) -> None:
        """Record a Slack reply for later assertions.

        Args:
            text: Response text sent by the routing handler.
            thread_ts: Optional thread timestamp used for the reply.
            blocks: Optional Slack Block Kit payload sent with the reply.

        Returns:
            None.
        """
        self.calls.append(
            {
                "text": text,
                "thread_ts": thread_ts,
                "blocks": blocks,
            }
        )


class FakeSlackClient:
    def __init__(
        self,
        responses: list[Mapping[str, Any]] | None = None,
        *,
        history_responses: list[Mapping[str, Any]] | None = None,
        error: Exception | None = None,
        token: str | None = "xoxb-test-token",
    ) -> None:
        """Initialize a fake Slack client for history, replies, and post calls.

        Args:
            responses: Ordered paginated responses returned by `conversations_replies`.
            history_responses: Ordered responses returned by `conversations_history`.
            error: Optional exception raised instead of returning a response.
            token: Optional Slack token exposed for private file downloads.

        Returns:
            None.
        """
        self._responses = list(responses or [])
        self._history_responses = list(history_responses or [])
        self._error = error
        self.token = token
        self.calls: list[dict[str, Any]] = []
        self.history_calls: list[dict[str, Any]] = []
        self.post_calls: list[dict[str, str | None]] = []
        self.upload_calls: list[dict[str, Any]] = []

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

    async def files_upload_v2(self, **kwargs: Any) -> Mapping[str, Any]:
        """Record uploaded files for later assertions.

        Args:
            **kwargs: Upload keyword arguments passed by the routing handler.

        Returns:
            Fake Slack API response payload.
        """
        self.upload_calls.append(kwargs)
        if self._error is not None:
            raise self._error
        return {"ok": True, "file": {"id": "F123"}}


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


def test_normalize_thread_message_preserves_image_metadata() -> None:
    """Verify Slack thread normalization retains lightweight image metadata.

    Returns:
        None.
    """
    message = agent_routing._normalize_thread_message(
        {
            "ts": "1712345678.000100",
            "user": "U1",
            "text": "Use this as a reference",
            "files": [
                {
                    "title": "wireframe",
                    "mimetype": "image/png",
                    "alt_txt": "homepage wireframe with hero image",
                    "url_private_download": "https://files.slack.com/files-pri/T1-F1/wireframe.png",
                }
            ],
            "blocks": [
                {
                    "type": "image",
                    "title": {"type": "plain_text", "text": "moodboard"},
                    "alt_text": "earth-tone product photography",
                    "image_url": "https://example.com/moodboard.png",
                }
            ],
        }
    )

    assert message.role == MessageRole.USER
    assert message.metadata == {
        "slack_images": [
            {
                "source": "file",
                "title": "wireframe",
                "alt_text": "homepage wireframe with hero image",
                "mime_type": "image/png",
                "download_url": "https://files.slack.com/files-pri/T1-F1/wireframe.png",
            },
            {
                "source": "block",
                "title": "moodboard",
                "alt_text": "earth-tone product photography",
                "download_url": "https://example.com/moodboard.png",
            },
        ]
    }


def test_normalize_thread_message_preserves_file_share_transcription_media_metadata() -> (
    None
):
    """Verify Slack file-share thread messages retain transcription media metadata.

    Returns:
        None.
    """
    message = agent_routing._normalize_thread_message(
        {
            "ts": "1712345678.000100",
            "user": "U1",
            "subtype": "file_share",
            "text": "Please transcribe this upload",
            "files": [
                {
                    "name": "meeting.wav",
                    "title": "meeting",
                    "mimetype": "audio/wav",
                    "url_private_download": "https://files.slack.com/files-pri/T1-F1/meeting.wav",
                }
            ],
        }
    )

    assert message.role == MessageRole.USER
    assert message.metadata == {
        "slack_transcription_media": [
            {
                "source": "file",
                "title": "meeting",
                "mime_type": "audio/wav",
                "download_url": "https://files.slack.com/files-pri/T1-F1/meeting.wav",
                "filename": "meeting.wav",
            }
        ]
    }


def test_is_transcription_request_rejects_non_command_keyword_mentions() -> None:
    """Verify keyword-only mentions do not hijack normal assistant questions.

    Returns:
        None.
    """
    assert agent_routing._is_transcription_request("文字起こしして") is True
    assert (
        agent_routing._is_transcription_request("please transcribe this thread") is True
    )
    assert (
        agent_routing._is_transcription_request("transcribe the latest audio") is True
    )
    assert (
        agent_routing._is_transcription_request("could you transcribe this thread?")
        is True
    )
    assert (
        agent_routing._is_transcription_request("what can you transcribe in Slack?")
        is False
    )
    assert (
        agent_routing._is_transcription_request("tell me about transcription factors")
        is False
    )
    assert (
        agent_routing._is_transcription_request("how do transcription factors work?")
        is False
    )


@pytest.mark.asyncio
async def test_download_thread_reference_images_downloads_binary_images(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify thread image metadata is converted into binary reference images.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub HTTP downloads.

    Returns:
        None.
    """

    class FakeHttpClient:
        """Fake async HTTP client used to stub image downloads."""

        async def __aenter__(self) -> FakeHttpClient:
            """Enter the async context manager.

            Returns:
                This fake client.
            """
            return self

        async def __aexit__(self, *args: Any) -> None:
            """Exit the async context manager.

            Args:
                *args: Unused context manager arguments.

            Returns:
                None.
            """
            del args

        async def get(self, url: str, *, headers: Mapping[str, str]) -> Any:
            """Return a deterministic HTTP response for the requested image.

            Args:
                url: Requested image URL.
                headers: Request headers used for authorization.

            Returns:
                Lightweight response object with PNG content.
            """
            assert url == "https://files.slack.com/files-pri/T1-F1/reference.png"
            assert headers["Authorization"] == "Bearer xoxb-test-token"

            class FakeResponse:
                """Fake HTTP response carrying image bytes."""

                headers = {"content-type": "image/png"}
                content = b"reference-bytes"

                def raise_for_status(self) -> None:
                    """Pretend the HTTP response succeeded.

                    Returns:
                        None.
                    """

            return FakeResponse()

    monkeypatch.setattr(
        agent_routing.httpx, "AsyncClient", lambda **_: FakeHttpClient()
    )

    reference_images = await agent_routing._download_thread_reference_images(
        FakeSlackClient(),
        [
            ThreadMessage(
                ts="1712345678.000100",
                role=MessageRole.USER,
                text="Use this reference.",
                user_id="U1",
                metadata={
                    "slack_images": [
                        {
                            "source": "file",
                            "title": "reference",
                            "alt_text": "landing page wireframe",
                            "mime_type": "image/png",
                            "download_url": "https://files.slack.com/files-pri/T1-F1/reference.png",
                        }
                    ]
                },
            )
        ],
    )

    assert reference_images == [
        SlackReferenceImage(
            identifier="thread-image-1712345678-000100-1",
            data=b"reference-bytes",
            media_type="image/png",
            title="reference",
            alt_text="landing page wireframe",
            source="file",
            message_ts="1712345678.000100",
        )
    ]


@pytest.mark.asyncio
async def test_handle_agent_mention_runs_agent_router_and_activates_thread(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify explicit mentions execute the agent router and activate the thread.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub router execution.

    Returns:
        None.
    """

    async def fake_run_agent_router(invocation: Any, **_: Any) -> Any:
        """Return a deterministic router result for mention routing tests.

        Args:
            invocation: Slack invocation received from the routing layer.
            **_: Unused keyword arguments.

        Returns:
            Lightweight router result object with a fixed message.
        """
        assert [message.role for message in invocation.thread_messages] == [
            MessageRole.USER
        ]
        assert invocation.reference_images == []
        return type(
            "AgentRouterResult",
            (),
            {
                "message": "Completed `checklist`.",
                "follow_up_question": None,
                "generated_image": None,
            },
        )()

    monkeypatch.setattr(agent_routing, "run_agent_router", fake_run_agent_router)
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

    assert responder.calls == [
        {
            "text": "Completed `checklist`.",
            "thread_ts": "1712345678.000100",
            "blocks": None,
        }
    ]
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

    async def fake_run_agent_router(invocation: Any, **_: Any) -> Any:
        """Return a deterministic router result for follow-up routing tests.

        Args:
            invocation: Slack invocation received from the routing layer.
            **_: Unused keyword arguments.

        Returns:
            Lightweight router result object with a fixed message.
        """
        assert invocation.text == "please also tag finance"
        return type(
            "AgentRouterResult",
            (),
            {
                "message": "Tagged finance.",
                "follow_up_question": None,
                "generated_image": None,
            },
        )()

    monkeypatch.setattr(agent_routing, "run_agent_router", fake_run_agent_router)
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

    assert responder.calls == [
        {
            "text": "Tagged finance.",
            "thread_ts": "1712345678.000100",
            "blocks": None,
        }
    ]
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
        {
            "text": "The Slack agent router is not enabled for this workspace or channel.\n"
            + agent_routing.build_agent_help_message("U1"),
            "thread_ts": "1712345678.000100",
            "blocks": None,
        }
    ]
    assert repository.activate_calls == []


@pytest.mark.asyncio
async def test_handle_agent_mention_returns_thread_menu_for_textless_mention(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify textless mentions show the thread menu instead of routing to AI.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to assert router non-execution.

    Returns:
        None.
    """

    async def fail_run_agent_router(*_: Any, **__: Any) -> Any:
        """Fail the test if the router is invoked unexpectedly.

        Args:
            *_: Unused positional arguments.
            **__: Unused keyword arguments.

        Returns:
            Never returns because the function always raises.
        """
        raise AssertionError("run_agent_router should not run")

    monkeypatch.setattr(agent_routing, "run_agent_router", fail_run_agent_router)
    responder = SayResponder()

    await agent_routing.handle_agent_mention(
        {"team_id": "T1"},
        {
            "user": "U1",
            "channel": "C123",
            "ts": "1712345678.000100",
            "text": "<@Ubot>",
        },
        responder,
    )

    assert responder.calls == [
        {
            "text": agent_routing.build_thread_menu_message("U1"),
            "thread_ts": "1712345678.000100",
            "blocks": agent_routing.build_thread_menu_blocks("U1"),
        }
    ]


@pytest.mark.asyncio
async def test_handle_agent_mention_starts_background_transcription_for_audio_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify explicit transcription mentions post diarized results in-thread.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub background execution.

    Returns:
        None.
    """

    class FakeTranscriptionService:
        """Fake transcription service returning speaker-attributed segments."""

        def transcribe_bytes(self, **_: Any) -> TranscriptionResponse:
            """Return a deterministic transcription response for routing tests.

            Args:
                **_: Unused keyword arguments.

            Returns:
                Fixed speaker-attributed transcription payload.
            """
            return TranscriptionResponse(
                segments=[
                    TranscriptionSegment(
                        speaker_label="Speaker 1",
                        text="こんにちは 今日は",
                    ),
                    TranscriptionSegment(
                        speaker_label="Speaker 2",
                        text="ありがとうございます",
                    ),
                ]
            )

    scheduled_tasks: list[asyncio.Task[Any]] = []

    def immediate_scheduler(coro: Any) -> asyncio.Task[Any]:
        """Schedule the background coroutine immediately for test control.

        Args:
            coro: Coroutine created by the routing layer.

        Returns:
            Created asyncio task.
        """
        task = asyncio.create_task(coro)
        scheduled_tasks.append(task)
        return task

    async def fake_download_thread_transcription_media_attachment(
        client: Any,
        spec: Any,
    ) -> dict[str, str | bytes]:
        """Return deterministic audio bytes for transcription routing tests.

        Args:
            client: Slack client received by the routing layer.
            spec: Audio descriptor selected from the thread.

        Returns:
            Fake audio payload mapping.
        """
        del client
        assert spec["filename"] == "meeting.wav"
        return {
            "data": b"audio-bytes",
            "media_type": "audio/wav",
            "filename": "meeting.wav",
        }

    monkeypatch.setattr(agent_routing, "_schedule_background_task", immediate_scheduler)
    monkeypatch.setattr(
        agent_routing,
        "_build_transcription_service",
        lambda: FakeTranscriptionService(),
    )
    monkeypatch.setattr(
        agent_routing,
        "_download_thread_transcription_media_attachment",
        fake_download_thread_transcription_media_attachment,
    )
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
                        "subtype": "file_share",
                        "text": "<@Ubot> 文字起こしして",
                        "files": [
                            {
                                "name": "meeting.wav",
                                "title": "meeting",
                                "mimetype": "audio/wav",
                                "url_private_download": "https://files.slack.com/files-pri/T1-F1/meeting.wav",
                            }
                        ],
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
            "text": "<@Ubot> 文字起こしして",
        },
        responder,
        client,
        repository=repository,
    )
    await asyncio.gather(*scheduled_tasks)

    assert responder.calls == []
    assert client.post_calls == [
        {
            "channel": "C123",
            "text": agent_routing.build_transcription_started_message("U1"),
            "thread_ts": "1712345678.000100",
        },
        {
            "channel": "C123",
            "text": agent_routing.build_transcription_response_message(
                TranscriptionResponse(
                    segments=[
                        TranscriptionSegment(
                            speaker_label="Speaker 1",
                            text="こんにちは 今日は",
                        ),
                        TranscriptionSegment(
                            speaker_label="Speaker 2",
                            text="ありがとうございます",
                        ),
                    ]
                ),
                filename="meeting.wav",
            ),
            "thread_ts": "1712345678.000100",
        },
    ]


@pytest.mark.asyncio
async def test_handle_agent_mention_routes_non_command_transcription_keyword_to_assistant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify transcription-related nouns still route to the main assistant path.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub routed execution.

    Returns:
        None.
    """

    def fail_schedule_background_task(_: Any) -> Any:
        """Fail the test if transcription scheduling is attempted.

        Args:
            _: Unused coroutine argument.

        Returns:
            Never returns because the function always raises.

        Raises:
            AssertionError: Raised whenever scheduling is attempted.
        """
        raise AssertionError("_schedule_background_task should not run")

    async def fake_invoke_routed_agent(*_: Any, **__: Any) -> str:
        """Return a deterministic assistant response for non-command keyword mentions.

        Args:
            *_: Unused positional arguments.
            **__: Unused keyword arguments.

        Returns:
            Deterministic assistant response text.
        """
        return "assistant route"

    monkeypatch.setattr(
        agent_routing,
        "_schedule_background_task",
        fail_schedule_background_task,
    )
    monkeypatch.setattr(agent_routing, "invoke_routed_agent", fake_invoke_routed_agent)
    responder = SayResponder()
    repository = StubSlackAgentRepository()

    await agent_routing.handle_agent_mention(
        {"team_id": "T1"},
        {
            "user": "U1",
            "channel": "C123",
            "ts": "1712345678.000100",
            "text": "<@Ubot> tell me about transcription factors",
        },
        responder,
        repository=repository,
    )

    assert responder.calls == [
        {
            "text": "assistant route",
            "thread_ts": "1712345678.000100",
            "blocks": None,
        }
    ]


@pytest.mark.asyncio
async def test_handle_agent_mention_reports_thread_context_error_for_transcription_without_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify transcription requests fail visibly when no Slack client is available.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to assert scheduler non-execution.

    Returns:
        None.
    """

    def fail_schedule_background_task(_: Any) -> Any:
        """Fail the test if transcription scheduling is attempted.

        Args:
            _: Unused coroutine argument.

        Returns:
            Never returns because the function always raises.

        Raises:
            AssertionError: Raised whenever scheduling is attempted.
        """
        raise AssertionError("_schedule_background_task should not run")

    monkeypatch.setattr(
        agent_routing,
        "_schedule_background_task",
        fail_schedule_background_task,
    )
    responder = SayResponder()
    repository = StubSlackAgentRepository()

    await agent_routing.handle_agent_mention(
        {"team_id": "T1"},
        {
            "user": "U1",
            "channel": "C123",
            "ts": "1712345678.000100",
            "text": "<@Ubot> 文字起こしして",
        },
        responder,
        repository=repository,
    )

    assert responder.calls == [
        {
            "text": agent_routing.build_thread_context_error_message("U1"),
            "thread_ts": "1712345678.000100",
            "blocks": None,
        }
    ]


@pytest.mark.asyncio
async def test_handle_agent_mention_returns_unconfigured_for_disabled_channel_transcription_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify disabled channels block transcription requests before background work starts.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to assert scheduler non-execution.

    Returns:
        None.
    """

    def fail_schedule_background_task(_: Any) -> Any:
        """Fail the test if transcription scheduling is attempted.

        Args:
            _: Unused coroutine argument.

        Returns:
            Never returns because the function always raises.

        Raises:
            AssertionError: Raised whenever scheduling is attempted.
        """
        raise AssertionError("_schedule_background_task should not run")

    monkeypatch.setattr(
        agent_routing,
        "_schedule_background_task",
        fail_schedule_background_task,
    )
    responder = SayResponder()
    repository = StubSlackAgentRepository(channel_enabled=False)

    await agent_routing.handle_agent_mention(
        {"team_id": "T1"},
        {
            "user": "U1",
            "channel": "C123",
            "ts": "1712345678.000100",
            "text": "<@Ubot> 文字起こしして",
        },
        responder,
        repository=repository,
    )

    assert responder.calls == [
        {
            "text": "The Slack agent router is not enabled for this workspace or channel.\n"
            + agent_routing.build_agent_help_message("U1"),
            "thread_ts": "1712345678.000100",
            "blocks": None,
        }
    ]
    assert repository.activate_calls == []


@pytest.mark.asyncio
async def test_handle_agent_mention_starts_background_transcription_for_video_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify explicit transcription mentions accept video attachments too.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub background execution.

    Returns:
        None.
    """

    class FakeTranscriptionService:
        """Fake transcription service validating the forwarded video payload."""

        def transcribe_bytes(self, **kwargs: Any) -> TranscriptionResponse:
            """Return a deterministic transcription response for video tests.

            Args:
                **kwargs: Keyword arguments forwarded by the routing layer.

            Returns:
                Fixed speaker-attributed transcription payload.
            """
            assert kwargs["filename"] == "demo.mp4"
            assert kwargs["content_type"] == "video/mp4"
            return TranscriptionResponse(
                segments=[
                    TranscriptionSegment(
                        speaker_label="Speaker 1",
                        text="デモ動画の音声です",
                    )
                ]
            )

    scheduled_tasks: list[asyncio.Task[Any]] = []

    def immediate_scheduler(coro: Any) -> asyncio.Task[Any]:
        """Schedule the background coroutine immediately for test control.

        Args:
            coro: Coroutine created by the routing layer.

        Returns:
            Created asyncio task.
        """
        task = asyncio.create_task(coro)
        scheduled_tasks.append(task)
        return task

    async def fake_download_thread_transcription_media_attachment(
        client: Any,
        spec: Any,
    ) -> dict[str, str | bytes]:
        """Return deterministic video bytes for transcription routing tests.

        Args:
            client: Slack client received by the routing layer.
            spec: Media descriptor selected from the thread.

        Returns:
            Fake video payload mapping.
        """
        del client
        assert spec["filename"] == "demo.mp4"
        return {
            "data": b"video-bytes",
            "media_type": "video/mp4",
            "filename": "demo.mp4",
        }

    monkeypatch.setattr(agent_routing, "_schedule_background_task", immediate_scheduler)
    monkeypatch.setattr(
        agent_routing,
        "_build_transcription_service",
        lambda: FakeTranscriptionService(),
    )
    monkeypatch.setattr(
        agent_routing,
        "_download_thread_transcription_media_attachment",
        fake_download_thread_transcription_media_attachment,
    )
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
                        "text": "<@Ubot> 文字起こしして",
                        "files": [
                            {
                                "name": "demo.mp4",
                                "title": "demo",
                                "mimetype": "video/mp4",
                                "url_private_download": "https://files.slack.com/files-pri/T1-F1/demo.mp4",
                            }
                        ],
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
            "text": "<@Ubot> 文字起こしして",
        },
        responder,
        client,
        repository=repository,
    )
    await asyncio.gather(*scheduled_tasks)

    assert responder.calls == []
    assert client.post_calls[-1] == {
        "channel": "C123",
        "text": agent_routing.build_transcription_response_message(
            TranscriptionResponse(
                segments=[
                    TranscriptionSegment(
                        speaker_label="Speaker 1",
                        text="デモ動画の音声です",
                    )
                ]
            ),
            filename="demo.mp4",
        ),
        "thread_ts": "1712345678.000100",
    }


@pytest.mark.asyncio
async def test_handle_agent_mention_reports_missing_thread_audio_for_transcription(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify transcription requests fail clearly when the thread has no audio.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to control background tasks.

    Returns:
        None.
    """
    scheduled_tasks: list[asyncio.Task[Any]] = []

    def immediate_scheduler(coro: Any) -> asyncio.Task[Any]:
        """Schedule the background coroutine immediately for test control.

        Args:
            coro: Coroutine created by the routing layer.

        Returns:
            Created asyncio task.
        """
        task = asyncio.create_task(coro)
        scheduled_tasks.append(task)
        return task

    monkeypatch.setattr(agent_routing, "_schedule_background_task", immediate_scheduler)
    monkeypatch.setattr(agent_routing, "_build_transcription_service", lambda: object())
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
                        "text": "<@Ubot> 文字起こしして",
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
            "text": "<@Ubot> 文字起こしして",
        },
        responder,
        client,
        repository=repository,
    )
    await asyncio.gather(*scheduled_tasks)

    assert responder.calls == []
    assert client.post_calls[-1] == {
        "channel": "C123",
        "text": agent_routing.build_transcription_source_error_message("U1"),
        "thread_ts": "1712345678.000100",
    }


@pytest.mark.asyncio
async def test_handle_agent_mention_reports_unconfigured_transcription(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify transcription requests fail clearly when Speech is unconfigured.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to control background tasks.

    Returns:
        None.
    """
    scheduled_tasks: list[asyncio.Task[Any]] = []

    def immediate_scheduler(coro: Any) -> asyncio.Task[Any]:
        """Schedule the background coroutine immediately for test control.

        Args:
            coro: Coroutine created by the routing layer.

        Returns:
            Created asyncio task.
        """
        task = asyncio.create_task(coro)
        scheduled_tasks.append(task)
        return task

    monkeypatch.setattr(agent_routing, "_schedule_background_task", immediate_scheduler)
    monkeypatch.setattr(agent_routing, "_build_transcription_service", lambda: None)
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
                        "text": "<@Ubot> 文字起こしして",
                        "files": [
                            {
                                "name": "meeting.wav",
                                "title": "meeting",
                                "mimetype": "audio/wav",
                                "url_private_download": "https://files.slack.com/files-pri/T1-F1/meeting.wav",
                            }
                        ],
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
            "text": "<@Ubot> 文字起こしして",
        },
        responder,
        client,
        repository=repository,
    )
    await asyncio.gather(*scheduled_tasks)

    assert responder.calls == []
    assert client.post_calls[-1] == {
        "channel": "C123",
        "text": agent_routing.build_transcription_unconfigured_message("U1"),
        "thread_ts": "1712345678.000100",
    }


@pytest.mark.asyncio
async def test_handle_agent_mention_reports_transcription_download_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify transcription requests fail clearly when audio download fails.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to control background tasks.

    Returns:
        None.
    """

    class FakeTranscriptionService:
        """Fake transcription service that should never be called in this test."""

        def transcribe_bytes(self, **_: Any) -> TranscriptionResponse:
            """Fail the test if the transcription service is reached.

            Args:
                **_: Unused keyword arguments.

            Returns:
                Never returns because the function always raises.
            """
            raise AssertionError("transcribe_bytes should not be called")

    scheduled_tasks: list[asyncio.Task[Any]] = []

    def immediate_scheduler(coro: Any) -> asyncio.Task[Any]:
        """Schedule the background coroutine immediately for test control.

        Args:
            coro: Coroutine created by the routing layer.

        Returns:
            Created asyncio task.
        """
        task = asyncio.create_task(coro)
        scheduled_tasks.append(task)
        return task

    async def fail_download_thread_transcription_media_attachment(
        client: Any,
        spec: Any,
    ) -> dict[str, str | bytes]:
        """Raise a download failure for transcription routing tests.

        Args:
            client: Slack client received by the routing layer.
            spec: Audio descriptor selected from the thread.

        Returns:
            Never returns because the function always raises.
        """
        del client, spec
        raise agent_routing.SlackAudioDownloadError("boom")

    monkeypatch.setattr(agent_routing, "_schedule_background_task", immediate_scheduler)
    monkeypatch.setattr(
        agent_routing,
        "_build_transcription_service",
        lambda: FakeTranscriptionService(),
    )
    monkeypatch.setattr(
        agent_routing,
        "_download_thread_transcription_media_attachment",
        fail_download_thread_transcription_media_attachment,
    )
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
                        "text": "<@Ubot> 文字起こしして",
                        "files": [
                            {
                                "name": "meeting.wav",
                                "title": "meeting",
                                "mimetype": "audio/wav",
                                "url_private_download": "https://files.slack.com/files-pri/T1-F1/meeting.wav",
                            }
                        ],
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
            "text": "<@Ubot> 文字起こしして",
        },
        responder,
        client,
        repository=repository,
    )
    await asyncio.gather(*scheduled_tasks)

    assert responder.calls == []
    assert client.post_calls[-1] == {
        "channel": "C123",
        "text": agent_routing.build_transcription_execution_error_message("U1"),
        "thread_ts": "1712345678.000100",
    }


@pytest.mark.asyncio
async def test_handle_agent_mention_uploads_generated_image_into_thread(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify image-generation delegation uploads the image instead of sending text.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub router execution.

    Returns:
        None.
    """

    async def fake_run_agent_router(invocation: Any, **_: Any) -> Any:
        """Return a deterministic image-generation router result for routing tests.

        Args:
            invocation: Slack invocation received from the routing layer.
            **_: Unused keyword arguments.

        Returns:
            Lightweight router result object carrying a generated image.
        """
        assert invocation.text == "generate a fox poster"
        assert invocation.reference_images == [
            SlackReferenceImage(
                identifier="thread-image-1712345678-000100-1",
                data=b"thread-reference-bytes",
                media_type="image/png",
                title="reference",
                alt_text="orange fox poster sketch",
                source="file",
                message_ts="1712345678.000100",
            )
        ]
        return type(
            "AgentRouterResult",
            (),
            {
                "message": "Generated image for prompt:\ngenerate a fox poster",
                "follow_up_question": None,
                "generated_image": BinaryImage(
                    data=b"png-bytes",
                    media_type="image/png",
                ),
            },
        )()

    monkeypatch.setattr(agent_routing, "run_agent_router", fake_run_agent_router)

    async def fake_download_thread_reference_images(
        client: Any,
        thread_messages: Any,
    ) -> list[SlackReferenceImage]:
        """Return a deterministic binary reference image for routing tests.

        Args:
            client: Slack client received by the routing layer.
            thread_messages: Thread transcript received by the routing layer.

        Returns:
            Single downloaded reference image.
        """
        del client, thread_messages
        return [
            SlackReferenceImage(
                identifier="thread-image-1712345678-000100-1",
                data=b"thread-reference-bytes",
                media_type="image/png",
                title="reference",
                alt_text="orange fox poster sketch",
                source="file",
                message_ts="1712345678.000100",
            )
        ]

    monkeypatch.setattr(
        agent_routing,
        "_download_thread_reference_images",
        fake_download_thread_reference_images,
    )
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
                        "text": "<@Ubot> generate a fox poster",
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
            "text": "<@Ubot> generate a fox poster",
        },
        responder,
        client,
        repository=repository,
    )

    assert responder.calls == []
    assert client.upload_calls == [
        {
            "channel": "C123",
            "file": b"png-bytes",
            "filename": "generated-image.png",
            "title": "Generated image",
            "alt_txt": "Generated image for prompt:\ngenerate a fox poster",
            "initial_comment": "Generated image for prompt:\ngenerate a fox poster",
            "thread_ts": "1712345678.000100",
        }
    ]
    assert repository.activate_calls[-1]["agent_id"] == "assistant"


@pytest.mark.asyncio
async def test_handle_agent_mention_uploads_generated_video_into_thread(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify video-generation delegation uploads the video instead of sending text.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub router execution.

    Returns:
        None.
    """

    async def fake_run_agent_router(invocation: Any, **_: Any) -> Any:
        """Return a deterministic video-generation router result for routing tests.

        Args:
            invocation: Slack invocation received from the routing layer.
            **_: Unused keyword arguments.

        Returns:
            Lightweight router result carrying a generated video.
        """
        assert invocation.text == "create a teaser video"
        return type(
            "AgentRouterResult",
            (),
            {
                "message": "Generated video for prompt:\ncreate a teaser video",
                "follow_up_question": None,
                "generated_video": BinaryContent(
                    data=b"mp4-bytes",
                    media_type="video/mp4",
                ),
            },
        )()

    monkeypatch.setattr(agent_routing, "run_agent_router", fake_run_agent_router)
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
                        "text": "<@Ubot> create a teaser video",
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
            "text": "<@Ubot> create a teaser video",
        },
        responder,
        client,
        repository=repository,
    )

    assert responder.calls == []
    assert client.upload_calls == [
        {
            "channel": "C123",
            "file": b"mp4-bytes",
            "filename": "generated-video.mp4",
            "title": "Generated video",
            "initial_comment": "Generated video for prompt:\ncreate a teaser video",
            "thread_ts": "1712345678.000100",
        }
    ]
    assert repository.activate_calls[-1]["agent_id"] == "assistant"


@pytest.mark.asyncio
async def test_handle_agent_message_ignores_disabled_channel_follow_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify disabled channels do not auto-route active-thread follow-ups.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to assert router non-execution.

    Returns:
        None.
    """

    async def fail_run_agent_router(*_: Any, **__: Any) -> Any:
        """Fail the test if the router is invoked unexpectedly.

        Args:
            *_: Unused positional arguments.
            **__: Unused keyword arguments.

        Returns:
            Never returns because the function always raises.
        """
        raise AssertionError("run_agent_router should not run")

    monkeypatch.setattr(agent_routing, "run_agent_router", fail_run_agent_router)
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
    """Verify invalid thread history prevents router execution.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to assert router non-execution.

    Returns:
        None.
    """

    async def fail_run_agent_router(*_: Any, **__: Any) -> Any:
        """Fail the test if the router is invoked unexpectedly.

        Args:
            *_: Unused positional arguments.
            **__: Unused keyword arguments.

        Returns:
            Never returns because the function always raises.
        """
        raise AssertionError("run_agent_router should not run")

    monkeypatch.setattr(agent_routing, "run_agent_router", fail_run_agent_router)
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
