"""Tests for the Slack assistant runtime."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic_ai import BinaryContent, BinaryImage
from pydantic_ai.models.test import TestModel

import agents_party.agents.slack_assistant.runtime as slack_assistant_runtime
from agents_party.agents.slack_assistant import (
    SlackAssistantAction,
    SlackAssistantDeps,
    build_slack_assistant_agent,
    build_slack_assistant_instructions,
    build_slack_assistant_prompt,
    run_slack_assistant,
)
from agents_party.agents.slack_runtime import SlackAgentInvocation
from agents_party.domain import MessageRole, ThreadMessage


def make_invocation() -> SlackAgentInvocation:
    """Build a representative Slack invocation for assistant tests.

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
        thread_messages=[
            ThreadMessage(
                ts="1712345678.000100",
                role=MessageRole.USER,
                text="follow up with finance",
                user_id="U1",
            )
        ],
    )


@pytest.mark.asyncio
async def test_build_slack_assistant_agent_registers_expected_tools() -> None:
    """Verify the Slack assistant exposes the expected delegation tools.

    Returns:
        None.
    """
    model = TestModel(
        call_tools=[],
        custom_output_args={
            "action": "responded",
            "message": "ok",
            "delegated_agent_id": None,
            "follow_up_question": None,
        },
    )
    agent = build_slack_assistant_agent(model=model)

    result = await agent.run(
        build_slack_assistant_prompt(make_invocation()),
        deps=SlackAssistantDeps(invocation=make_invocation()),
    )

    assert result.output.message == "ok"
    params = model.last_model_request_parameters
    assert params is not None
    assert {tool.name for tool in params.function_tools} == {
        "delegate_image_generation",
        "delegate_translation",
        "delegate_video_generation",
        "delegate_web_research",
        "delegate_work_manager",
    }


def test_build_slack_assistant_instructions_include_indirect_image_examples() -> None:
    """Verify assistant instructions explicitly call out indirect image requests.

    Returns:
        None.
    """
    instructions = "\n".join(build_slack_assistant_instructions())

    assert "turn this into a visual" in instructions
    assert "図にして" in instructions
    assert "この案をビジュアル化して" in instructions
    assert "animate this concept" in instructions
    assert "動画にして" in instructions


@pytest.mark.asyncio
async def test_run_slack_assistant_delegates_work_manager(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify task-management requests delegate through the work-manager tool.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub work-manager execution.

    Returns:
        None.
    """

    async def fake_run_work_manager(invocation: Any, **_: Any) -> Any:
        """Return a deterministic work-manager result for delegation tests.

        Args:
            invocation: Work-manager invocation received from the assistant.
            **_: Unused keyword arguments.

        Returns:
            Lightweight result object with a fixed message.
        """
        assert invocation.channel_id == "C123"
        return type(
            "WorkManagerResult",
            (),
            {"message": "Handled by work manager.", "follow_up_question": None},
        )()

    monkeypatch.setattr(
        slack_assistant_runtime, "run_work_manager", fake_run_work_manager
    )
    model = TestModel(
        call_tools=["delegate_work_manager"],
        custom_output_args={
            "action": "responded",
            "message": "",
            "delegated_agent_id": None,
            "follow_up_question": None,
        },
    )

    result = await run_slack_assistant(make_invocation(), model=model)

    assert result.action == SlackAssistantAction.DELEGATED
    assert result.delegated_agent_id == "work-manager"
    assert result.message == "Handled by work manager."


@pytest.mark.asyncio
async def test_run_slack_assistant_delegates_web_research(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify current-information requests delegate through the web-research tool.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub web-research execution.

    Returns:
        None.
    """

    async def fake_run_web_research(invocation: Any, **_: Any) -> Any:
        """Return a deterministic web-research result for delegation tests.

        Args:
            invocation: Web-research invocation received from the assistant.
            **_: Unused keyword arguments.

        Returns:
            Lightweight result object with a fixed answer.
        """
        assert invocation.channel_id == "C123"
        return type(
            "WebResearchResult",
            (),
            {
                "answer": "Latest policy is unchanged.",
                "sources": [],
                "caveats": [],
                "follow_up_question": None,
            },
        )()

    monkeypatch.setattr(
        slack_assistant_runtime,
        "run_web_research",
        fake_run_web_research,
    )
    model = TestModel(
        call_tools=["delegate_web_research"],
        custom_output_args={
            "action": "responded",
            "message": "",
            "delegated_agent_id": None,
            "follow_up_question": None,
        },
    )

    result = await run_slack_assistant(make_invocation(), model=model)

    assert result.action == SlackAssistantAction.DELEGATED
    assert result.delegated_agent_id == "web-research"
    assert result.message == "Latest policy is unchanged."


@pytest.mark.asyncio
async def test_run_slack_assistant_delegates_translation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify translation requests delegate through the translation tool.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub translation execution.

    Returns:
        None.
    """

    async def fake_run_translation(invocation: Any, **_: Any) -> Any:
        """Return a deterministic translation result for delegation tests.

        Args:
            invocation: Translation invocation received from the assistant.
            **_: Unused keyword arguments.

        Returns:
            Lightweight result object with a fixed translation.
        """
        assert invocation.channel_id == "C123"
        return type(
            "TranslationResult",
            (),
            {
                "translated_text": "財務部門にフォローアップしてください。",
                "follow_up_question": None,
            },
        )()

    monkeypatch.setattr(
        slack_assistant_runtime, "run_translation", fake_run_translation
    )
    model = TestModel(
        call_tools=["delegate_translation"],
        custom_output_args={
            "action": "responded",
            "message": "",
            "delegated_agent_id": None,
            "follow_up_question": None,
        },
    )

    result = await run_slack_assistant(make_invocation(), model=model)

    assert result.action == SlackAssistantAction.DELEGATED
    assert result.delegated_agent_id == "translation"
    assert result.message == "財務部門にフォローアップしてください。"


@pytest.mark.asyncio
async def test_run_slack_assistant_delegates_image_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify image requests delegate through the image-generation tool.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub image generation.

    Returns:
        None.
    """

    async def fake_run_image_generation(invocation: Any, **_: Any) -> BinaryImage:
        """Return a deterministic image result for delegation tests.

        Args:
            invocation: Image-generation invocation received from the assistant.
            **_: Unused keyword arguments.

        Returns:
            Binary image payload for the generated image.
        """
        assert invocation.prompt == "follow up with finance"
        assert invocation.user_id == "U1"
        assert len(invocation.thread_messages) == 1
        assert invocation.thread_messages[0].text == "follow up with finance"
        assert invocation.reference_images == []
        return BinaryImage(data=b"png-bytes", media_type="image/png")

    monkeypatch.setattr(
        slack_assistant_runtime,
        "run_image_generation",
        fake_run_image_generation,
    )
    model = TestModel(
        call_tools=["delegate_image_generation"],
        custom_output_args={
            "action": "responded",
            "message": "",
            "delegated_agent_id": None,
            "follow_up_question": None,
        },
    )

    result = await run_slack_assistant(make_invocation(), model=model)

    assert result.action == SlackAssistantAction.DELEGATED
    assert result.delegated_agent_id == "image-generation"
    assert result.message == "Generated image for prompt:\nfollow up with finance"
    assert result.generated_image == BinaryImage(
        data=b"png-bytes", media_type="image/png"
    )


@pytest.mark.asyncio
async def test_run_slack_assistant_delegates_video_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify video requests delegate through the video-generation tool.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub video generation.

    Returns:
        None.
    """

    async def fake_run_video_generation(invocation: Any, **_: Any) -> BinaryContent:
        """Return a deterministic video result for delegation tests.

        Args:
            invocation: Video-generation invocation received from the assistant.
            **_: Unused keyword arguments.

        Returns:
            Binary video payload for the generated video.
        """
        assert invocation.prompt == "follow up with finance"
        assert invocation.user_id == "U1"
        assert len(invocation.thread_messages) == 1
        assert invocation.thread_messages[0].text == "follow up with finance"
        return BinaryContent(data=b"mp4-bytes", media_type="video/mp4")

    monkeypatch.setattr(
        slack_assistant_runtime,
        "run_video_generation",
        fake_run_video_generation,
    )
    model = TestModel(
        call_tools=["delegate_video_generation"],
        custom_output_args={
            "action": "responded",
            "message": "",
            "delegated_agent_id": None,
            "follow_up_question": None,
        },
    )

    result = await run_slack_assistant(make_invocation(), model=model)

    assert result.action == SlackAssistantAction.DELEGATED
    assert result.delegated_agent_id == "video-generation"
    assert result.message == "Generated video for prompt:\nfollow up with finance"
    assert result.generated_video == BinaryContent(
        data=b"mp4-bytes", media_type="video/mp4"
    )


@pytest.mark.asyncio
async def test_run_slack_assistant_clears_stale_generated_video_after_later_tool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify later delegated tools clear a previously generated video payload.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub delegated runtimes.

    Returns:
        None.
    """

    async def fake_run_video_generation(invocation: Any, **_: Any) -> BinaryContent:
        """Return a deterministic video result for delegation tests.

        Args:
            invocation: Video-generation invocation received from the assistant.
            **_: Unused keyword arguments.

        Returns:
            Binary video payload for the generated video.
        """
        del invocation
        return BinaryContent(data=b"mp4-bytes", media_type="video/mp4")

    async def fake_run_translation(invocation: Any, **_: Any) -> Any:
        """Return a deterministic translation result for delegation tests.

        Args:
            invocation: Translation invocation received from the assistant.
            **_: Unused keyword arguments.

        Returns:
            Lightweight result object with a fixed translation.
        """
        del invocation
        return type(
            "TranslationResult",
            (),
            {
                "translated_text": "財務部門にフォローアップしてください。",
                "follow_up_question": None,
            },
        )()

    monkeypatch.setattr(
        slack_assistant_runtime,
        "run_video_generation",
        fake_run_video_generation,
    )
    monkeypatch.setattr(
        slack_assistant_runtime,
        "run_translation",
        fake_run_translation,
    )
    model = TestModel(
        call_tools=["delegate_video_generation", "delegate_translation"],
        custom_output_args={
            "action": "responded",
            "message": "",
            "delegated_agent_id": None,
            "follow_up_question": None,
        },
    )

    result = await run_slack_assistant(make_invocation(), model=model)

    assert result.action == SlackAssistantAction.DELEGATED
    assert result.delegated_agent_id == "translation"
    assert result.message == "財務部門にフォローアップしてください。"
    assert result.generated_video is None


@pytest.mark.asyncio
async def test_run_slack_assistant_requires_model_for_indirect_visual_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify indirect visual requests no longer bypass model-based routing.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to clear configured models.

    Returns:
        None.
    """
    monkeypatch.setattr(slack_assistant_runtime.settings, "slack_assistant_model", None)
    monkeypatch.setattr(slack_assistant_runtime.settings, "work_manager_model", None)
    invocation = make_invocation().model_copy(
        update={"text": "この案をモックアップにして"}
    )

    result = await run_slack_assistant(invocation, model=None)

    assert result.action == SlackAssistantAction.RESPONDED
    assert result.delegated_agent_id is None
    assert (
        result.message == "Slack assistant is not configured. Set "
        "SLACK_ASSISTANT_MODEL or WORK_MANAGER_MODEL before using it."
    )


@pytest.mark.asyncio
async def test_run_slack_assistant_requires_model_for_indirect_video_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify indirect video requests no longer bypass model-based routing.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to clear configured models.

    Returns:
        None.
    """
    monkeypatch.setattr(slack_assistant_runtime.settings, "slack_assistant_model", None)
    monkeypatch.setattr(slack_assistant_runtime.settings, "work_manager_model", None)
    invocation = make_invocation().model_copy(
        update={"text": "この案をショート動画にして"}
    )

    result = await run_slack_assistant(invocation, model=None)

    assert result.action == SlackAssistantAction.RESPONDED
    assert result.delegated_agent_id is None
    assert (
        result.message == "Slack assistant is not configured. Set "
        "SLACK_ASSISTANT_MODEL or WORK_MANAGER_MODEL before using it."
    )


@pytest.mark.asyncio
async def test_run_slack_assistant_returns_direct_help_without_delegation() -> None:
    """Verify simple help requests can be answered without specialist delegation.

    Returns:
        None.
    """
    model = TestModel(
        call_tools=[],
        custom_output_args={
            "action": "responded",
            "message": "I can help with tasks, web research, and translation.",
            "delegated_agent_id": None,
            "follow_up_question": None,
        },
    )

    result = await run_slack_assistant(make_invocation(), model=model)

    assert result.action == SlackAssistantAction.RESPONDED
    assert result.delegated_agent_id is None
    assert result.message == "I can help with tasks, web research, and translation."
