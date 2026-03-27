"""Tests for the video-generation agent runtime."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic_ai import BinaryContent
from pydantic_ai.models.google import GoogleModel

import agents_party.agents.video_generation.runtime as video_generation_runtime
from agents_party.agents.video_generation import (
    VideoGenerationInvocation,
    VideoGenerationPlan,
    build_video_generation_agent,
    build_video_generation_prompt,
    prepare_video_generation_plan,
    run_video_generation,
)
from agents_party.domain import MessageRole, ThreadMessage


def make_invocation() -> VideoGenerationInvocation:
    """Build a representative invocation for video-generation tests.

    Returns:
        Video-generation invocation containing a Slack prompt and requester ids.
    """
    return VideoGenerationInvocation(
        prompt="Create a cinematic teaser of a fox running through a neon city.",
        user_id="U1",
        team_id="T1",
        thread_messages=[
            ThreadMessage(
                ts="1712345678.000100",
                role=MessageRole.USER,
                text="Make it feel like a sci-fi trailer with city reflections.",
                user_id="U1",
            )
        ],
    )


def test_build_video_generation_prompt_includes_request_context() -> None:
    """Verify the prompt includes the video request, thread context, and Slack ids.

    Returns:
        None.
    """
    prompt = build_video_generation_prompt(make_invocation())

    assert (
        "Video request:\nCreate a cinematic teaser of a fox running through a neon city."
        in prompt
    )
    assert "Slack thread context:" in prompt
    assert "Requesting Slack user:\nU1" in prompt
    assert "Slack workspace:\nT1" in prompt


def test_build_video_generation_agent_defaults_to_vertex_google_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify the planner defaults to a Vertex AI Gemini text model.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to override settings values.

    Returns:
        None.
    """
    monkeypatch.setattr(
        video_generation_runtime.settings,
        "google_cloud_project",
        "demo-project",
        raising=False,
    )
    monkeypatch.setattr(
        video_generation_runtime.settings,
        "google_cloud_location",
        "global",
        raising=False,
    )
    monkeypatch.setattr(
        video_generation_runtime.settings,
        "video_generation_prompt_model",
        "gemini-2.5-flash",
        raising=False,
    )

    agent = build_video_generation_agent()

    assert isinstance(agent.model, GoogleModel)
    assert agent.model.system == "google-vertex"
    assert agent.model.model_name == "gemini-2.5-flash"


def test_build_video_generation_agent_preserves_provider_qualified_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify provider-qualified model strings are passed through unchanged.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to override settings values.

    Returns:
        None.
    """
    monkeypatch.setattr(
        video_generation_runtime.settings,
        "video_generation_prompt_model",
        "google-gla:gemini-3-flash-preview",
        raising=False,
    )

    agent = build_video_generation_agent()

    assert agent.model == "google-gla:gemini-3-flash-preview"


@pytest.mark.asyncio
async def test_prepare_video_generation_plan_uses_rendered_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify planning execution passes the rendered prompt to the agent.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to inject a fake agent.

    Returns:
        None.
    """
    captured: dict[str, Any] = {}

    class FakeAgent:
        """Fake Pydantic AI agent used to capture runtime calls."""

        async def run(self, prompt: str) -> Any:
            """Record the prompt and return a deterministic Veo plan.

            Args:
                prompt: Prompt passed by the runtime.

            Returns:
                Lightweight result object exposing a fixed Veo plan.
            """
            captured["prompt"] = prompt
            return type(
                "FakeRunResult",
                (),
                {
                    "output": VideoGenerationPlan(
                        prompt="Refined teaser prompt.",
                        aspect_ratio="9:16",
                        duration_seconds=6,
                        negative_prompt="text overlays",
                    )
                },
            )()

    monkeypatch.setattr(
        video_generation_runtime,
        "build_video_generation_agent",
        lambda model=None: FakeAgent(),
    )

    result = await prepare_video_generation_plan(make_invocation())

    assert result == VideoGenerationPlan(
        prompt="Refined teaser prompt.",
        aspect_ratio="9:16",
        duration_seconds=6,
        negative_prompt="text overlays",
    )
    assert (
        "Create a cinematic teaser of a fox running through a neon city."
        in captured["prompt"]
    )
    assert "Make it feel like a sci-fi trailer" in captured["prompt"]


@pytest.mark.asyncio
async def test_run_video_generation_uses_prepared_plan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify the runtime passes the planned Veo request into the sync executor.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to inject deterministic helpers.

    Returns:
        None.
    """
    captured: dict[str, Any] = {}

    async def fake_prepare_plan(
        invocation: Any,
        *,
        model: Any = None,
    ) -> VideoGenerationPlan:
        """Return a deterministic Veo plan for runtime tests.

        Args:
            invocation: Video-generation invocation received by the runtime.
            model: Optional prompt model override.

        Returns:
            Fixed Veo plan.
        """
        del model
        assert (
            invocation.prompt
            == "Create a cinematic teaser of a fox running through a neon city."
        )
        return VideoGenerationPlan(
            prompt="Refined teaser prompt.",
            aspect_ratio="16:9",
            duration_seconds=8,
        )

    def fake_generate_sync(
        plan: VideoGenerationPlan,
        *,
        model_name: str,
    ) -> BinaryContent:
        """Record the Veo plan and return deterministic video bytes.

        Args:
            plan: Prepared Veo plan received by the sync executor.
            model_name: Bare Veo model name received by the sync executor.

        Returns:
            Binary video payload.
        """
        captured["plan"] = plan
        captured["model_name"] = model_name
        return BinaryContent(data=b"mp4-bytes", media_type="video/mp4")

    monkeypatch.setattr(
        video_generation_runtime,
        "prepare_video_generation_plan",
        fake_prepare_plan,
    )
    monkeypatch.setattr(
        video_generation_runtime,
        "_generate_video_from_plan_sync",
        fake_generate_sync,
    )

    result = await run_video_generation(make_invocation())

    assert result == BinaryContent(data=b"mp4-bytes", media_type="video/mp4")
    assert captured["plan"] == VideoGenerationPlan(
        prompt="Refined teaser prompt.",
        aspect_ratio="16:9",
        duration_seconds=8,
    )
    assert (
        captured["model_name"]
        == video_generation_runtime.DEFAULT_VIDEO_GENERATION_MODEL
    )
