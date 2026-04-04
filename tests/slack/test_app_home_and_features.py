"""Tests for App Home publishing plus image and video Slack interactions."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, cast

import pytest
from pydantic_ai import BinaryContent, BinaryImage

from agents_party.agents.image_generation import ImageGenerationInvocation
from agents_party.agents.video_generation import VideoGenerationInvocation
from agents_party.domain import AgentDocument
from agents_party.slack.events.app_home_opened import (
    _build_home_view,
    handle_app_home_opened,
)
from agents_party.slack.features import register_feature_handlers
import agents_party.slack.events.app_home_opened as app_home_opened
import agents_party.slack.features.agent_settings as agent_settings
import agents_party.slack.features.image_generation as image_generation
import agents_party.slack.features.video_generation as video_generation


class StubFeatureApp:
    """Minimal Slack app stub that records action and view handlers."""

    def __init__(self) -> None:
        """Initialize the stub feature registry.

        Returns:
            None.
        """
        self.action_handlers: dict[str, Callable[..., Any]] = {}
        self.view_handlers: dict[str, Callable[..., Any]] = {}

    def action(self, name: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """Capture action registrations performed by the application setup.

        Args:
            name: Slack action id being registered.

        Returns:
            Decorator that stores the handler and returns it unchanged.
        """

        def decorator(handler: Callable[..., Any]) -> Callable[..., Any]:
            self.action_handlers[name] = handler
            return handler

        return decorator

    def view(self, name: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """Capture view registrations performed by the application setup.

        Args:
            name: Slack view callback id being registered.

        Returns:
            Decorator that stores the handler and returns it unchanged.
        """

        def decorator(handler: Callable[..., Any]) -> Callable[..., Any]:
            self.view_handlers[name] = handler
            return handler

        return decorator


class FakeHomeClient:
    """Stub Slack client that records App Home publish calls."""

    def __init__(self) -> None:
        """Initialize the App Home client stub.

        Returns:
            None.
        """
        self.published_views: list[dict[str, Any]] = []
        self.user_info_requests: list[str] = []

    async def views_publish(self, *, user_id: str, view: dict[str, Any]) -> None:
        """Record App Home publish calls for later assertions.

        Args:
            user_id: Slack user receiving the App Home view.
            view: Block Kit payload published to App Home.

        Returns:
            None.
        """
        self.published_views.append({"user_id": user_id, "view": view})

    async def users_info(self, *, user: str) -> Mapping[str, Any]:
        """Return a deterministic workspace-admin user object.

        Args:
            user: Slack user id whose role is being requested.

        Returns:
            Slack-style user payload exposing admin privileges.
        """
        self.user_info_requests.append(user)
        return {
            "user": {
                "id": user,
                "is_admin": True,
                "is_owner": False,
                "is_primary_owner": False,
            }
        }


class StubSlackAgentRepository:
    """Stub repository that exposes agent lists and persists enablement changes."""

    def __init__(self, agents: list[AgentDocument]) -> None:
        """Initialize the stub with a mutable set of agent documents.

        Args:
            agents: Agent documents exposed to the App Home feature.
        """
        self.agents = agents
        self.updated_agent_ids: list[str] = []

    def list_agents(self) -> list[AgentDocument]:
        """Return the configured agent documents.

        Returns:
            Stored agent documents for the App Home settings modal.
        """
        return list(self.agents)

    def set_enabled_agents(self, *, agent_ids: list[str]) -> list[AgentDocument]:
        """Persist which agents should remain enabled in the stub state.

        Args:
            agent_ids: Agent ids that should remain enabled after the update.

        Returns:
            Updated agent documents with the new enabled state.
        """
        self.updated_agent_ids = list(agent_ids)
        enabled_ids = set(agent_ids)
        self.agents = [
            agent.model_copy(update={"enabled": agent.agent_id in enabled_ids})
            for agent in self.agents
        ]
        return list(self.agents)


class FakeInteractionClient:
    """Stub Slack client that records modal, message, and upload calls."""

    def __init__(self) -> None:
        """Initialize the interaction client stub.

        Returns:
            None.
        """
        self.opened_views: list[dict[str, Any]] = []
        self.published_views: list[dict[str, Any]] = []
        self.user_info_requests: list[str] = []
        self.messages: list[dict[str, str]] = []
        self.uploads: list[dict[str, Any]] = []
        self.opened_conversations: list[dict[str, Any]] = []

    async def views_open(self, *, trigger_id: str, view: dict[str, Any]) -> None:
        """Record modal open calls for later assertions.

        Args:
            trigger_id: Slack trigger id used to open the modal.
            view: Modal payload opened for the user.

        Returns:
            None.
        """
        self.opened_views.append({"trigger_id": trigger_id, "view": view})

    async def views_publish(self, *, user_id: str, view: dict[str, Any]) -> None:
        """Record App Home publish calls performed after modal submission.

        Args:
            user_id: Slack user receiving the refreshed App Home view.
            view: Block Kit payload published to App Home.

        Returns:
            None.
        """
        self.published_views.append({"user_id": user_id, "view": view})

    async def users_info(self, *, user: str) -> Mapping[str, Any]:
        """Return a deterministic workspace-admin user object.

        Args:
            user: Slack user id whose role is being requested.

        Returns:
            Slack-style user payload exposing admin privileges.
        """
        self.user_info_requests.append(user)
        return {
            "user": {
                "id": user,
                "is_admin": True,
                "is_owner": False,
                "is_primary_owner": False,
            }
        }

    async def chat_postMessage(self, *, channel: str, text: str) -> None:
        """Record Slack direct messages posted by the feature handlers.

        Args:
            channel: Destination Slack channel or user id.
            text: Message text posted by the handler.

        Returns:
            None.
        """
        self.messages.append({"channel": channel, "text": text})

    async def conversations_open(self, *, users: str) -> Mapping[str, Any]:
        """Record direct-message openings and return a deterministic channel id.

        Args:
            users: Slack user id used to open the direct-message conversation.

        Returns:
            Slack response payload containing the opened direct-message channel.
        """
        self.opened_conversations.append({"users": users})
        return {"channel": {"id": "D123"}}

    async def files_upload_v2(self, **kwargs: Any) -> None:
        """Record Slack file uploads initiated by the feature handlers.

        Args:
            **kwargs: Upload keyword arguments passed by the handler.

        Returns:
            None.
        """
        self.uploads.append(kwargs)


class FakeAck:
    """Async ack stub that records payloads sent to Slack."""

    def __init__(self) -> None:
        """Initialize the ack call log.

        Returns:
            None.
        """
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, **kwargs: Any) -> None:
        """Record acknowledgement payloads for later assertions.

        Args:
            **kwargs: Ack keyword arguments passed by the handler.

        Returns:
            None.
        """
        self.calls.append(kwargs)


class FakeImageGenerationRunner:
    """Stub image-generation runner used by the Slack feature tests."""

    def __init__(self, result: BinaryImage) -> None:
        """Initialize the fake runner with a deterministic image result.

        Args:
            result: Generated image returned for every prompt.
        """
        self.result = result
        self.invocations: list[Any] = []

    async def __call__(self, invocation: Any) -> BinaryImage:
        """Record invocations and return the configured generated image.

        Args:
            invocation: Image-generation invocation submitted by the Slack feature.

        Returns:
            Configured generated image result.
        """
        self.invocations.append(invocation)
        return self.result


class FakeVideoGenerationRunner:
    """Stub video-generation runner used by the Slack feature tests."""

    def __init__(self, result: BinaryContent) -> None:
        """Initialize the fake runner with a deterministic video result.

        Args:
            result: Generated video returned for every prompt.
        """
        self.result = result
        self.invocations: list[Any] = []

    async def __call__(self, invocation: Any) -> BinaryContent:
        """Record invocations and return the configured generated video.

        Args:
            invocation: Video-generation invocation submitted by the Slack feature.

        Returns:
            Configured generated video result.
        """
        self.invocations.append(invocation)
        return self.result


def _build_submission_body(prompt: str) -> Mapping[str, Any]:
    """Build a minimal Slack view submission payload for image generation.

    Args:
        prompt: Prompt value inserted into the modal state.

    Returns:
        Slack view submission payload used by the feature handler tests.
    """
    return {
        "team": {"id": "T123"},
        "user": {"id": "U123"},
        "view": {
            "state": {
                "values": {
                    "image_generation_prompt": {
                        "image_generation_prompt_value": {"value": prompt}
                    }
                }
            }
        },
    }


def _build_video_submission_body(prompt: str) -> Mapping[str, Any]:
    """Build a minimal Slack view submission payload for video generation.

    Args:
        prompt: Prompt value inserted into the modal state.

    Returns:
        Slack view submission payload used by the feature handler tests.
    """
    return {
        "team": {"id": "T123"},
        "user": {"id": "U123"},
        "view": {
            "state": {
                "values": {
                    "video_generation_prompt": {
                        "video_generation_prompt_value": {"value": prompt}
                    }
                }
            }
        },
    }


def _build_agent_settings_submission_body(agent_ids: list[str]) -> Mapping[str, Any]:
    """Build a minimal Slack view submission payload for agent settings.

    Args:
        agent_ids: Agent ids selected in the settings modal.

    Returns:
        Slack view submission payload used by the feature handler tests.
    """
    return {
        "team": {"id": "T123"},
        "user": {"id": "U123"},
        "view": {
            "state": {
                "values": {
                    "agent_settings": {
                        "agent_settings_selected_agents": {
                            "selected_options": [
                                {"value": agent_id} for agent_id in agent_ids
                            ]
                        }
                    }
                }
            }
        },
    }


def test_build_home_view_includes_agent_settings_summary() -> None:
    """Verify App Home shows agent status summary and settings action.

    Returns:
        None.
    """
    agents = [
        AgentDocument(
            agent_id="work-manager",
            name="Work Manager",
            model_provider="google-gla",
            model_name="gemini-2.5-flash",
            enabled=True,
        ),
        AgentDocument(
            agent_id="web-research",
            name="Web Research",
            model_provider="google-gla",
            model_name="gemini-2.5-flash",
            enabled=False,
        ),
    ]

    view = _build_home_view(
        agents=agents,
        settings_available=True,
        can_manage_settings=True,
    )

    action_blocks = [block for block in view["blocks"] if block["type"] == "actions"]

    assert len(action_blocks) == 1
    assert action_blocks[0]["elements"][0]["action_id"] == (
        agent_settings.AGENT_SETTINGS_ACTION_ID
    )
    summary_text = view["blocks"][3]["text"]["text"]
    assert "2 件のエージェント" in summary_text
    assert "Work Manager" in summary_text
    assert "Web Research" in summary_text


@pytest.mark.asyncio
async def test_handle_app_home_opened_publishes_view(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify opening App Home publishes the new Block Kit home view.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to inject fake settings state.

    Returns:
        None.
    """
    agents = [
        AgentDocument(
            agent_id="work-manager",
            name="Work Manager",
            model_provider="google-gla",
            model_name="gemini-2.5-flash",
            enabled=True,
        )
    ]
    client = FakeHomeClient()
    monkeypatch.setattr(
        app_home_opened,
        "load_agent_settings_state",
        lambda: (agents, True),
    )

    await handle_app_home_opened({"user": "U123"}, cast(Any, client))

    assert client.published_views == [
        {
            "user_id": "U123",
            "view": _build_home_view(
                agents=agents,
                settings_available=True,
                can_manage_settings=True,
            ),
        }
    ]
    assert client.user_info_requests == ["U123"]


@pytest.mark.asyncio
async def test_handle_app_home_opened_hides_settings_button_for_non_admin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify App Home hides settings actions for non-admin viewers.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to inject fake settings state.

    Returns:
        None.
    """

    class NonAdminHomeClient(FakeHomeClient):
        """Fake home client returning a non-admin user object."""

        async def users_info(self, *, user: str) -> Mapping[str, Any]:
            """Return a Slack-style user payload without admin privileges.

            Args:
                user: Slack user id whose role is being requested.

            Returns:
                Slack-style non-admin user payload.
            """
            self.user_info_requests.append(user)
            return {
                "user": {
                    "id": user,
                    "is_admin": False,
                    "is_owner": False,
                    "is_primary_owner": False,
                }
            }

    agents = [
        AgentDocument(
            agent_id="work-manager",
            name="Work Manager",
            model_provider="google-gla",
            model_name="gemini-2.5-flash",
            enabled=True,
        )
    ]
    client = NonAdminHomeClient()
    monkeypatch.setattr(
        app_home_opened,
        "load_agent_settings_state",
        lambda: (agents, True),
    )

    await handle_app_home_opened({"user": "U123"}, cast(Any, client))

    blocks = client.published_views[0]["view"]["blocks"]
    assert [block for block in blocks if block["type"] == "actions"] == []


def test_register_feature_handlers_wires_image_generation_handlers() -> None:
    """Verify interactive feature wiring includes media-generation handlers.

    Returns:
        None.
    """
    app = StubFeatureApp()

    register_feature_handlers(cast(Any, app))

    assert set(app.action_handlers) == {
        "onboarding:start",
        agent_settings.AGENT_SETTINGS_ACTION_ID,
        image_generation.IMAGE_GENERATION_ACTION_ID,
        video_generation.VIDEO_GENERATION_ACTION_ID,
    }
    assert set(app.view_handlers) == {
        agent_settings.AGENT_SETTINGS_VIEW_CALLBACK_ID,
        image_generation.IMAGE_GENERATION_VIEW_CALLBACK_ID,
        video_generation.VIDEO_GENERATION_VIEW_CALLBACK_ID,
    }


@pytest.mark.asyncio
async def test_handle_agent_settings_action_opens_modal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify the App Home action opens the agent settings modal.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to inject modal state.

    Returns:
        None.
    """
    ack = FakeAck()
    client = FakeInteractionClient()
    agents = [
        AgentDocument(
            agent_id="work-manager",
            name="Work Manager",
            model_provider="google-gla",
            model_name="gemini-2.5-flash",
            enabled=True,
        )
    ]
    monkeypatch.setattr(
        agent_settings,
        "load_agent_settings_state",
        lambda: (agents, True),
    )

    await agent_settings.handle_agent_settings_action(
        cast(Any, ack),
        {"trigger_id": "trigger-123", "user": {"id": "U123"}},
        cast(Any, client),
    )

    assert ack.calls == [{}]
    assert client.opened_views[0]["trigger_id"] == "trigger-123"
    assert (
        client.opened_views[0]["view"]["callback_id"]
        == agent_settings.AGENT_SETTINGS_VIEW_CALLBACK_ID
    )
    assert client.user_info_requests == ["U123"]


@pytest.mark.asyncio
async def test_handle_agent_settings_submission_updates_repository_and_home(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify agent settings submission persists selection and refreshes App Home.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to inject the fake repository.

    Returns:
        None.
    """
    ack = FakeAck()
    client = FakeInteractionClient()
    repository = StubSlackAgentRepository(
        [
            AgentDocument(
                agent_id="work-manager",
                name="Work Manager",
                model_provider="google-gla",
                model_name="gemini-2.5-flash",
                enabled=True,
            ),
            AgentDocument(
                agent_id="web-research",
                name="Web Research",
                model_provider="google-gla",
                model_name="gemini-2.5-flash",
                enabled=False,
            ),
        ]
    )
    monkeypatch.setattr(agent_settings, "_build_repository", lambda: repository)

    await agent_settings.handle_agent_settings_submission(
        cast(Any, ack),
        _build_agent_settings_submission_body(["web-research"]),
        cast(Any, client),
    )

    assert ack.calls == [{}]
    assert repository.updated_agent_ids == ["web-research"]
    assert client.published_views == [
        {
            "user_id": "U123",
            "view": _build_home_view(
                agents=repository.agents,
                settings_available=True,
                can_manage_settings=True,
            ),
        }
    ]


@pytest.mark.asyncio
async def test_handle_agent_settings_action_returns_for_non_admin() -> None:
    """Verify non-admin users cannot open the agent settings modal.

    Returns:
        None.
    """

    class NonAdminInteractionClient(FakeInteractionClient):
        """Fake interaction client returning a non-admin user object."""

        async def users_info(self, *, user: str) -> Mapping[str, Any]:
            """Return a Slack-style non-admin user payload.

            Args:
                user: Slack user id whose role is being requested.

            Returns:
                Slack-style non-admin user payload.
            """
            self.user_info_requests.append(user)
            return {
                "user": {
                    "id": user,
                    "is_admin": False,
                    "is_owner": False,
                    "is_primary_owner": False,
                }
            }

    ack = FakeAck()
    client = NonAdminInteractionClient()

    await agent_settings.handle_agent_settings_action(
        cast(Any, ack),
        {"trigger_id": "trigger-123", "user": {"id": "U123"}},
        cast(Any, client),
    )

    assert ack.calls == [{}]
    assert client.user_info_requests == ["U123"]
    assert client.opened_views == []


@pytest.mark.asyncio
async def test_handle_image_generation_action_opens_modal() -> None:
    """Verify the image-generation action opens the prompt-entry modal.

    Returns:
        None.
    """
    ack = FakeAck()
    client = FakeInteractionClient()

    await image_generation.handle_image_generation_action(
        cast(Any, ack),
        {"trigger_id": "trigger-123"},
        cast(Any, client),
    )

    assert ack.calls == [{}]
    assert client.opened_views == [
        {
            "trigger_id": "trigger-123",
            "view": image_generation._build_image_generation_view(),
        }
    ]


@pytest.mark.asyncio
async def test_handle_image_generation_submission_rejects_blank_prompt() -> None:
    """Verify blank prompts keep the modal open with a field-level error.

    Returns:
        None.
    """
    ack = FakeAck()
    client = FakeInteractionClient()

    await image_generation.handle_image_generation_submission(
        cast(Any, ack),
        _build_submission_body(" "),
        cast(Any, client),
    )

    assert ack.calls == [
        {
            "response_action": "errors",
            "errors": {"image_generation_prompt": "Enter an image prompt."},
        }
    ]
    assert client.uploads == []


@pytest.mark.asyncio
async def test_handle_image_generation_submission_uploads_generated_image(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify successful submissions upload the generated image to Slack.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to inject the fake runner.

    Returns:
        None.
    """
    ack = FakeAck()
    client = FakeInteractionClient()
    fake_runner = FakeImageGenerationRunner(
        BinaryImage(data=b"png-bytes", media_type="image/png")
    )
    monkeypatch.setattr(
        image_generation,
        "run_image_generation",
        fake_runner,
    )

    await image_generation.handle_image_generation_submission(
        cast(Any, ack),
        _build_submission_body("Paint a moonlit forest."),
        cast(Any, client),
    )

    assert ack.calls == [{}]
    assert fake_runner.invocations == [
        ImageGenerationInvocation(
            prompt="Paint a moonlit forest.",
            user_id="U123",
            team_id="T123",
        )
    ]
    assert client.opened_conversations == [{"users": "U123"}]
    assert client.uploads == [
        {
            "channel": "D123",
            "file": b"png-bytes",
            "filename": "generated-image.png",
            "title": "Generated image",
            "alt_txt": "Paint a moonlit forest.",
            "initial_comment": "Generated image for prompt:\nPaint a moonlit forest.",
        }
    ]


@pytest.mark.asyncio
async def test_handle_video_generation_action_opens_modal() -> None:
    """Verify the video-generation action opens the prompt-entry modal.

    Returns:
        None.
    """
    ack = FakeAck()
    client = FakeInteractionClient()

    await video_generation.handle_video_generation_action(
        cast(Any, ack),
        {"trigger_id": "trigger-123"},
        cast(Any, client),
    )

    assert ack.calls == [{}]
    assert client.opened_views == [
        {
            "trigger_id": "trigger-123",
            "view": video_generation._build_video_generation_view(),
        }
    ]


@pytest.mark.asyncio
async def test_handle_video_generation_submission_rejects_blank_prompt() -> None:
    """Verify blank video prompts keep the modal open with a field-level error.

    Returns:
        None.
    """
    ack = FakeAck()
    client = FakeInteractionClient()

    await video_generation.handle_video_generation_submission(
        cast(Any, ack),
        _build_video_submission_body(" "),
        cast(Any, client),
    )

    assert ack.calls == [
        {
            "response_action": "errors",
            "errors": {"video_generation_prompt": "Enter a video prompt."},
        }
    ]
    assert client.uploads == []


@pytest.mark.asyncio
async def test_handle_video_generation_submission_uploads_generated_video(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify successful submissions upload the generated video to Slack.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to inject the fake runner.

    Returns:
        None.
    """
    ack = FakeAck()
    client = FakeInteractionClient()
    fake_runner = FakeVideoGenerationRunner(
        BinaryContent(data=b"mp4-bytes", media_type="video/mp4")
    )
    monkeypatch.setattr(
        video_generation,
        "run_video_generation",
        fake_runner,
    )

    await video_generation.handle_video_generation_submission(
        cast(Any, ack),
        _build_video_submission_body("Create a short teaser of a neon fox."),
        cast(Any, client),
    )

    assert ack.calls == [{}]
    assert fake_runner.invocations == [
        VideoGenerationInvocation(
            prompt="Create a short teaser of a neon fox.",
            user_id="U123",
            team_id="T123",
        )
    ]
    assert client.opened_conversations == [{"users": "U123"}]
    assert client.uploads == [
        {
            "channel": "D123",
            "file": b"mp4-bytes",
            "filename": "generated-video.mp4",
            "title": "Generated video",
            "initial_comment": (
                "Generated video for prompt:\nCreate a short teaser of a neon fox."
            ),
        }
    ]


@pytest.mark.asyncio
async def test_handle_video_generation_submission_returns_when_dm_channel_cannot_open() -> (
    None
):
    """Verify video generation quietly returns when a DM channel cannot be opened.

    Returns:
        None.
    """

    class MissingDmClient(FakeInteractionClient):
        """Fake Slack client that cannot open a DM channel."""

        async def conversations_open(self, *, users: str) -> Mapping[str, Any]:
            """Return a payload without a usable DM channel id.

            Args:
                users: Slack user id used to open the direct-message conversation.

            Returns:
                Slack response payload without a usable channel id.
            """
            self.opened_conversations.append({"users": users})
            return {"channel": {}}

    ack = FakeAck()
    client = MissingDmClient()

    await video_generation.handle_video_generation_submission(
        cast(Any, ack),
        _build_video_submission_body("Create a short teaser of a neon fox."),
        cast(Any, client),
    )

    assert ack.calls == [{}]
    assert client.opened_conversations == [{"users": "U123"}]
    assert client.messages == []
    assert client.uploads == []
