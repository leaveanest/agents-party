"""Tests for the agent-router runtime."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic_ai import BinaryImage
from pydantic_ai.models.test import TestModel

import agents_party.agents.agent_router.runtime as agent_router_runtime
from agents_party.agents.agent_router import (
    AgentRouterAction,
    AgentRouterDeps,
    build_agent_router_agent,
    build_agent_router_instructions,
    build_agent_router_prompt,
    run_agent_router,
)
from agents_party.agents.slack_runtime import SlackAgentInvocation
from agents_party.domain import MessageRole, ThreadMessage


def make_invocation() -> SlackAgentInvocation:
    """Build a representative Slack invocation for router tests.

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
async def test_build_agent_router_agent_registers_expected_tools() -> None:
    """Verify the agent router exposes the expected specialist tools.

    Returns:
        None.
    """
    model = TestModel(
        call_tools=[],
        custom_output_args={
            "action": "responded",
            "message": "ok",
            "selected_specialist_ids": [],
            "follow_up_question": None,
        },
    )
    agent = build_agent_router_agent(model=model)

    result = await agent.run(
        build_agent_router_prompt(make_invocation()),
        deps=AgentRouterDeps(invocation=make_invocation()),
    )

    assert result.output.message == "ok"
    params = model.last_model_request_parameters
    assert params is not None
    assert {tool.name for tool in params.function_tools} == {
        "delegate_google_maps",
        "delegate_image_generation",
        "delegate_translation",
        "delegate_video_generation",
        "delegate_web_research",
        "delegate_work_manager",
    }


def test_build_agent_router_instructions_include_orchestration_guidance() -> None:
    """Verify router instructions describe orchestration and media behavior.

    Returns:
        None.
    """
    instructions = "\n".join(build_agent_router_instructions())

    assert "You may call multiple text specialists" in instructions
    assert "at most one media specialist" in instructions
    assert "`delegate_google_maps`" in instructions
    assert "`delegate_image_generation`" in instructions
    assert "`delegate_video_generation`" in instructions


@pytest.mark.asyncio
async def test_run_agent_router_delegates_to_google_maps_specialist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify the router can delegate place and route requests to Google Maps.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub specialist runtimes.

    Returns:
        None.
    """

    async def fake_run_google_maps(invocation: Any, **_: Any) -> Any:
        """Return a deterministic Google Maps result for routing tests.

        Args:
            invocation: Google Maps invocation received from the router.
            **_: Unused keyword arguments.

        Returns:
            Lightweight result object with a fixed route answer.
        """
        assert invocation.channel_id == "C123"
        return type(
            "GoogleMapsResult",
            (),
            {
                "answer": "東京駅から渋谷駅まで車で約18分です。",
                "places": [],
                "route": None,
                "caveats": [],
                "follow_up_question": None,
            },
        )()

    monkeypatch.setattr(agent_router_runtime, "run_google_maps", fake_run_google_maps)
    model = TestModel(
        call_tools=["delegate_google_maps"],
        custom_output_args={
            "action": "responded",
            "message": "東京駅から渋谷駅まで車で約18分です。",
            "selected_specialist_ids": [],
            "follow_up_question": None,
        },
    )

    result = await run_agent_router(make_invocation(), model=model)

    assert result.action == AgentRouterAction.ORCHESTRATED
    assert result.selected_specialist_ids == ["google-maps"]
    assert result.message == "東京駅から渋谷駅まで車で約18分です。"


@pytest.mark.asyncio
async def test_run_agent_router_orchestrates_multiple_text_specialists(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify the router can orchestrate multiple text specialists in one run.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub specialist runtimes.

    Returns:
        None.
    """

    async def fake_run_web_research(invocation: Any, **_: Any) -> Any:
        """Return a deterministic web-research result for orchestration tests.

        Args:
            invocation: Web-research invocation received from the router.
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

    async def fake_run_translation(invocation: Any, **_: Any) -> Any:
        """Return a deterministic translation result for orchestration tests.

        Args:
            invocation: Translation invocation received from the router.
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

    monkeypatch.setattr(agent_router_runtime, "run_web_research", fake_run_web_research)
    monkeypatch.setattr(agent_router_runtime, "run_translation", fake_run_translation)
    model = TestModel(
        call_tools=["delegate_web_research", "delegate_translation"],
        custom_output_args={
            "action": "responded",
            "message": (
                "Latest policy is unchanged.\n\n"
                "Japanese translation:\n財務部門にフォローアップしてください。"
            ),
            "selected_specialist_ids": [],
            "follow_up_question": None,
        },
    )

    result = await run_agent_router(make_invocation(), model=model)

    assert result.action == AgentRouterAction.ORCHESTRATED
    assert result.selected_specialist_ids == ["web-research", "translation"]
    assert (
        result.message
        == "Latest policy is unchanged.\n\nJapanese translation:\n財務部門にフォローアップしてください。"
    )


@pytest.mark.asyncio
async def test_run_agent_router_short_circuits_after_specialist_follow_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify a specialist follow-up question blocks later specialist execution.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub specialist runtimes.

    Returns:
        None.
    """

    async def fake_run_work_manager(invocation: Any, **_: Any) -> Any:
        """Return a clarification response for work-manager routing tests.

        Args:
            invocation: Work-manager invocation received from the router.
            **_: Unused keyword arguments.

        Returns:
            Lightweight result object carrying a follow-up question.
        """
        assert invocation.channel_id == "C123"
        return type(
            "WorkManagerResult",
            (),
            {
                "message": "",
                "follow_up_question": "Which finance owner should I use?",
            },
        )()

    async def fail_run_translation(*_: Any, **__: Any) -> Any:
        """Fail the test if translation runs after a specialist follow-up.

        Args:
            *_: Unused positional arguments.
            **__: Unused keyword arguments.

        Returns:
            None.

        Raises:
            AssertionError: Always raised when the function is called.
        """
        raise AssertionError("translation should not run after follow-up")

    monkeypatch.setattr(agent_router_runtime, "run_work_manager", fake_run_work_manager)
    monkeypatch.setattr(agent_router_runtime, "run_translation", fail_run_translation)
    model = TestModel(
        call_tools=["delegate_work_manager", "delegate_translation"],
        custom_output_args={
            "action": "responded",
            "message": "",
            "selected_specialist_ids": [],
            "follow_up_question": None,
        },
    )

    result = await run_agent_router(make_invocation(), model=model)

    assert result.action == AgentRouterAction.CLARIFICATION_NEEDED
    assert result.selected_specialist_ids == ["work-manager"]
    assert result.follow_up_question == "Which finance owner should I use?"


@pytest.mark.asyncio
async def test_run_agent_router_stops_after_google_maps_follow_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify Google Maps follow-up questions block later specialist execution.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub specialist runtimes.

    Returns:
        None.
    """

    async def fake_run_google_maps(invocation: Any, **_: Any) -> Any:
        """Return a clarification response for Google Maps routing tests.

        Args:
            invocation: Google Maps invocation received from the router.
            **_: Unused keyword arguments.

        Returns:
            Lightweight result object carrying a follow-up question.
        """
        assert invocation.channel_id == "C123"
        return type(
            "GoogleMapsResult",
            (),
            {
                "answer": "",
                "places": [],
                "route": None,
                "caveats": [],
                "follow_up_question": "出発地を教えてください。",
            },
        )()

    async def fail_run_translation(*_: Any, **__: Any) -> Any:
        """Fail the test if translation runs after a Google Maps follow-up.

        Args:
            *_: Unused positional arguments.
            **__: Unused keyword arguments.

        Returns:
            None.

        Raises:
            AssertionError: Always raised when the function is called.
        """
        raise AssertionError("translation should not run after Google Maps follow-up")

    monkeypatch.setattr(agent_router_runtime, "run_google_maps", fake_run_google_maps)
    monkeypatch.setattr(agent_router_runtime, "run_translation", fail_run_translation)
    model = TestModel(
        call_tools=["delegate_google_maps", "delegate_translation"],
        custom_output_args={
            "action": "responded",
            "message": "",
            "selected_specialist_ids": [],
            "follow_up_question": None,
        },
    )

    result = await run_agent_router(make_invocation(), model=model)

    assert result.action == AgentRouterAction.CLARIFICATION_NEEDED
    assert result.selected_specialist_ids == ["google-maps"]
    assert result.follow_up_question == "出発地を教えてください。"


@pytest.mark.asyncio
async def test_run_agent_router_keeps_media_result_final(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify media specialists win the final payload and block later calls.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub specialist runtimes.

    Returns:
        None.
    """

    async def fake_run_web_research(invocation: Any, **_: Any) -> Any:
        """Return a deterministic web-research result for media tests.

        Args:
            invocation: Web-research invocation received from the router.
            **_: Unused keyword arguments.

        Returns:
            Lightweight result object with a fixed answer.
        """
        assert invocation.channel_id == "C123"
        return type(
            "WebResearchResult",
            (),
            {
                "answer": "Brand positioning is playful.",
                "sources": [],
                "caveats": [],
                "follow_up_question": None,
            },
        )()

    async def fake_run_image_generation(invocation: Any, **_: Any) -> BinaryImage:
        """Return a deterministic image result for media routing tests.

        Args:
            invocation: Image-generation invocation received from the router.
            **_: Unused keyword arguments.

        Returns:
            Binary image payload for the generated image.
        """
        assert invocation.prompt == "follow up with finance"
        return BinaryImage(data=b"png-bytes", media_type="image/png")

    async def fail_run_translation(*_: Any, **__: Any) -> Any:
        """Fail the test if translation runs after image generation.

        Args:
            *_: Unused positional arguments.
            **__: Unused keyword arguments.

        Returns:
            None.

        Raises:
            AssertionError: Always raised when the function is called.
        """
        raise AssertionError("translation should not run after image generation")

    monkeypatch.setattr(agent_router_runtime, "run_web_research", fake_run_web_research)
    monkeypatch.setattr(
        agent_router_runtime,
        "run_image_generation",
        fake_run_image_generation,
    )
    monkeypatch.setattr(agent_router_runtime, "run_translation", fail_run_translation)
    model = TestModel(
        call_tools=[
            "delegate_web_research",
            "delegate_image_generation",
            "delegate_translation",
        ],
        custom_output_args={
            "action": "responded",
            "message": "",
            "selected_specialist_ids": [],
            "follow_up_question": None,
        },
    )

    result = await run_agent_router(make_invocation(), model=model)

    assert result.action == AgentRouterAction.ORCHESTRATED
    assert result.selected_specialist_ids == ["web-research", "image-generation"]
    assert result.generated_image == BinaryImage(
        data=b"png-bytes", media_type="image/png"
    )
    assert result.generated_video is None
    assert result.message == (
        "Brand positioning is playful.\n\nGenerated image for prompt:\n"
        "follow up with finance"
    )


@pytest.mark.asyncio
async def test_run_agent_router_requires_model_for_unconfigured_router(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify router execution requires `AGENT_SELECTOR_MODEL` when no model is passed.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to clear configured models.

    Returns:
        None.
    """
    monkeypatch.setattr(agent_router_runtime.settings, "agent_selector_model", None)

    result = await run_agent_router(make_invocation(), model=None)

    assert result.action == AgentRouterAction.RESPONDED
    assert result.selected_specialist_ids == []
    assert (
        result.message
        == "Agent router is not configured. Set AGENT_SELECTOR_MODEL before using it."
    )


@pytest.mark.asyncio
async def test_run_agent_router_returns_direct_help_without_delegation() -> None:
    """Verify simple help requests can be answered without specialist delegation.

    Returns:
        None.
    """
    model = TestModel(
        call_tools=[],
        custom_output_args={
            "action": "responded",
            "message": "I can help with tasks, research, translation, and visuals.",
            "selected_specialist_ids": [],
            "follow_up_question": None,
        },
    )

    result = await run_agent_router(make_invocation(), model=model)

    assert result.action == AgentRouterAction.RESPONDED
    assert result.selected_specialist_ids == []
    assert (
        result.message == "I can help with tasks, research, translation, and visuals."
    )
