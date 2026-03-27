"""Tests for the image-generation agent runtime."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic_ai import BinaryContent, BinaryImage, ImageGenerationTool
from pydantic_ai.models.google import GoogleModel

import agents_party.agents.image_generation.runtime as image_generation_runtime
from agents_party.agents.image_generation import (
    ImageGenerationInvocation,
    build_image_generation_agent,
    build_image_generation_prompt,
    build_image_generation_user_prompt,
    run_image_generation,
)
from agents_party.agents.slack_runtime import SlackReferenceImage
from agents_party.domain import MessageRole, ThreadMessage


def make_invocation() -> ImageGenerationInvocation:
    """Build a representative invocation for image-generation tests.

    Returns:
        Image-generation invocation containing a Slack prompt and requester ids.
    """
    return ImageGenerationInvocation(
        prompt="Paint a moonlit forest with fireflies.",
        user_id="U1",
        team_id="T1",
        thread_messages=[
            ThreadMessage(
                ts="1712345678.000100",
                role=MessageRole.USER,
                text="Use the same cozy composition we discussed earlier.",
                user_id="U1",
            ),
            ThreadMessage(
                ts="1712345679.000100",
                role=MessageRole.USER,
                text="",
                user_id="U1",
                metadata={
                    "slack_images": [
                        {
                            "source": "file",
                            "title": "forest reference",
                            "alt_text": "misty forest with warm lantern light",
                            "mime_type": "image/png",
                        }
                    ]
                },
            ),
        ],
        reference_images=[
            SlackReferenceImage(
                identifier="thread-image-1712345679-000100-1",
                data=b"reference-png",
                media_type="image/png",
                title="forest reference",
                alt_text="misty forest with warm lantern light",
                source="file",
                message_ts="1712345679.000100",
            )
        ],
    )


def test_build_image_generation_prompt_includes_request_context() -> None:
    """Verify the prompt includes the image request, thread context, and Slack ids.

    Returns:
        None.
    """
    prompt = build_image_generation_prompt(make_invocation())

    assert "Image request:\nPaint a moonlit forest with fireflies." in prompt
    assert (
        "Slack thread context is provided in chronological order as separate prompt parts after this header."
        in prompt
    )
    assert "Requesting Slack user:\nU1" in prompt
    assert "Slack workspace:\nT1" in prompt
    assert (
        "Attached reference images:\n1 binary image(s) accompany this request."
        in prompt
    )


def test_build_image_generation_user_prompt_includes_binary_reference_images() -> None:
    """Verify the multimodal prompt interleaves messages and binary references.

    Returns:
        None.
    """
    prompt_parts = build_image_generation_user_prompt(make_invocation())

    assert isinstance(prompt_parts[0], str)
    assert isinstance(prompt_parts[1], str)
    assert "Use the same cozy composition we discussed earlier." in prompt_parts[1]
    assert isinstance(prompt_parts[2], str)
    assert "[1712345679.000100] user:U1" in prompt_parts[2]
    assert (
        "1 binary reference image follow immediately after this message."
        in prompt_parts[2]
    )
    assert prompt_parts[3] == BinaryContent(
        data=b"reference-png",
        media_type="image/png",
        identifier="thread-image-1712345679-000100-1",
    )


def test_build_image_generation_agent_defaults_to_vertex_google_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify the agent defaults to a Vertex AI Gemini image model.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to override settings values.

    Returns:
        None.
    """
    monkeypatch.setattr(
        image_generation_runtime.settings,
        "google_cloud_project",
        "demo-project",
        raising=False,
    )
    monkeypatch.setattr(
        image_generation_runtime.settings,
        "google_cloud_location",
        "global",
        raising=False,
    )
    monkeypatch.setattr(
        image_generation_runtime.settings,
        "image_generation_model",
        "gemini-2.5-flash-image",
        raising=False,
    )

    agent = build_image_generation_agent()

    assert isinstance(agent.model, GoogleModel)
    assert agent.model.system == "google-vertex"
    assert agent.model.model_name == "gemini-2.5-flash-image"
    assert agent.output_type is BinaryImage
    assert len(agent._builtin_tools) == 1
    assert isinstance(agent._builtin_tools[0], ImageGenerationTool)
    assert agent._builtin_tools[0].output_format == "png"


def test_build_image_generation_agent_preserves_provider_qualified_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify provider-qualified model strings are passed through unchanged.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to override settings values.

    Returns:
        None.
    """
    monkeypatch.setattr(
        image_generation_runtime.settings,
        "image_generation_model",
        "google-gla:gemini-3-pro-image-preview",
        raising=False,
    )

    agent = build_image_generation_agent()

    assert agent.model == "google-gla:gemini-3-pro-image-preview"


@pytest.mark.asyncio
async def test_run_image_generation_uses_built_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify runtime execution passes the rendered prompt to the agent.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to inject a fake agent.

    Returns:
        None.
    """
    captured: dict[str, Any] = {}

    class FakeAgent:
        """Fake Pydantic AI agent used to capture runtime calls."""

        async def run(self, prompt: Any) -> Any:
            """Record the prompt and return a deterministic binary image.

            Args:
                prompt: Prompt passed by the runtime.

            Returns:
                Lightweight result object exposing a fixed binary image.
            """
            captured["prompt"] = prompt
            return type(
                "FakeRunResult",
                (),
                {"output": BinaryImage(data=b"png-bytes", media_type="image/png")},
            )()

    monkeypatch.setattr(
        image_generation_runtime,
        "build_image_generation_agent",
        lambda model=None: FakeAgent(),
    )

    result = await run_image_generation(make_invocation())

    assert result == BinaryImage(data=b"png-bytes", media_type="image/png")
    assert "Paint a moonlit forest with fireflies." in captured["prompt"][0]
    assert (
        "Use the same cozy composition we discussed earlier." in captured["prompt"][1]
    )
    assert "misty forest with warm lantern light" in captured["prompt"][2]
    assert captured["prompt"][3] == BinaryContent(
        data=b"reference-png",
        media_type="image/png",
        identifier="thread-image-1712345679-000100-1",
    )
