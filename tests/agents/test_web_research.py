"""Tests for the web-research agent package."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from pydantic_ai import CodeExecutionTool, WebFetchTool, WebSearchTool

import agents_party.agents.web_research.runtime as web_research_runtime_module
from agents_party.agents.web_research import (
    WebResearchAction,
    WebResearchInvocation,
    WebResearchResult,
    WebResearchSource,
    build_web_research_agent,
    build_web_research_prompt,
    render_web_research_response,
    run_web_research,
)
from agents_party.domain import MessageRole, ThreadMessage


def make_invocation() -> WebResearchInvocation:
    """Build a representative Slack invocation for web-research tests.

    Returns:
        Web-research invocation containing request and thread context.
    """
    return WebResearchInvocation(
        team_id="T1",
        user_id="U1",
        channel_id="C123",
        viewer_context_channel_ids=["C123"],
        text="What changed in the latest Gemini provider docs?",
        thread_ts="1712345678.000100",
        message_ts="1712345678.000100",
        thread_messages=[
            ThreadMessage(
                ts="1712345678.000100",
                role=MessageRole.USER,
                text="Check the latest Gemini provider docs.",
                user_id="U1",
            )
        ],
    )


def test_build_web_research_agent_registers_expected_builtin_tools() -> None:
    """Verify the web-research agent exposes the intended builtin tools.

    Returns:
        None.
    """
    agent = build_web_research_agent(model="google-vertex:gemini-3-flash-preview")

    builtin_tool_types = {type(tool) for tool in agent._builtin_tools}

    assert builtin_tool_types == {
        WebSearchTool,
        WebFetchTool,
        CodeExecutionTool,
    }


def test_build_web_research_prompt_includes_request_and_transcript() -> None:
    """Verify the web-research prompt preserves request and thread context.

    Returns:
        None.
    """
    prompt = build_web_research_prompt(make_invocation())

    assert "Slack request:\nWhat changed in the latest Gemini provider docs?" in prompt
    assert (
        "Slack thread transcript:\n"
        "[1712345678.000100] user:U1 Check the latest Gemini provider docs." in prompt
    )
    assert prompt.endswith(
        "Return the structured web-research result for this request."
    )


def test_render_web_research_response_appends_sources_and_caveats() -> None:
    """Verify rendered Slack output includes citations and caveats.

    Returns:
        None.
    """
    result = WebResearchResult(
        action=WebResearchAction.ANSWERED,
        answer="Gemini docs now describe Vertex AI configuration separately.",
        sources=[
            WebResearchSource(
                title="Google Model Docs",
                url="https://ai.pydantic.dev/models/google/",
                publisher="Pydantic AI",
            )
        ],
        caveats=["I did not compare archived versions before this release."],
    )

    rendered = render_web_research_response(result)

    assert rendered.startswith(
        "Gemini docs now describe Vertex AI configuration separately."
    )
    assert (
        "- Google Model Docs (Pydantic AI): https://ai.pydantic.dev/models/google/"
        in rendered
    )
    assert (
        "Caveats:\n- I did not compare archived versions before this release."
        in rendered
    )


@pytest.mark.asyncio
async def test_run_web_research_uses_rendered_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify runtime execution builds a prompt from the invocation payload.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub agent construction.

    Returns:
        None.
    """
    captured_prompt: str | None = None

    class FakeAgent:
        async def run(self, prompt: str) -> SimpleNamespace:
            nonlocal captured_prompt
            captured_prompt = prompt
            return SimpleNamespace(
                output=WebResearchResult(
                    action=WebResearchAction.ANSWERED,
                    answer="Verified answer.",
                    sources=[],
                    caveats=[],
                    follow_up_question=None,
                )
            )

    def fake_build_web_research_agent(*, model: str | None = None) -> FakeAgent:
        assert model == "google-vertex:gemini-3-flash-preview"
        return FakeAgent()

    monkeypatch.setattr(
        web_research_runtime_module,
        "build_web_research_agent",
        fake_build_web_research_agent,
    )

    result = await run_web_research(
        make_invocation(),
        model="google-vertex:gemini-3-flash-preview",
    )

    assert result.answer == "Verified answer."
    assert captured_prompt is not None
    assert (
        "Slack request:\nWhat changed in the latest Gemini provider docs?"
        in captured_prompt
    )
