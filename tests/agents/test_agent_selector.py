from __future__ import annotations

import pytest
from pydantic_ai.models.test import TestModel

from agents_party.agents.agent_selector import (
    AgentSelectorAction,
    AgentSelectorCandidate,
    AgentSelectorInvocation,
    build_agent_selector_agent,
    build_agent_selector_prompt,
    run_agent_selector,
)


def make_invocation() -> AgentSelectorInvocation:
    """Build a representative selector invocation for tests.

    Returns:
        Selector invocation containing a handoff-oriented request and candidates.
    """
    return AgentSelectorInvocation(
        text="Need a concise handoff summary for the next shift.",
        team_id="T1",
        channel_id="C123",
        thread_ts="1712345678.000100",
        candidates=[
            AgentSelectorCandidate(
                agent_id="handover-agent",
                name="Handover Agent",
                description="Builds handoff briefs from thread context.",
                when_to_use="Use for shift changes and operational handovers.",
                supported_skill_names=["handover-brief-builder"],
            ),
            AgentSelectorCandidate(
                agent_id="work-manager",
                name="Work Manager",
                description="Captures and updates work items.",
                when_to_use="Use for task tracking and ownership updates.",
                supported_skill_names=[],
            ),
        ],
    )


@pytest.mark.asyncio
async def test_build_agent_selector_agent_registers_builtin_skill_tools() -> None:
    """Verify the selector agent exposes builtin skill discovery tools.

    Returns:
        None.
    """
    model = TestModel(
        call_tools=[],
        custom_output_args={
            "action": "selected",
            "recommended_agent_id": "handover-agent",
            "matched_skill_names": ["handover-brief-builder"],
            "reasoning_summary": "The request is a handoff brief.",
            "needs_clarification": False,
            "follow_up_question": None,
        },
    )
    agent = build_agent_selector_agent(model=model)

    result = await agent.run(build_agent_selector_prompt(make_invocation()))

    assert result.output.action == AgentSelectorAction.SELECTED
    params = model.last_model_request_parameters
    assert params is not None
    assert {tool.name for tool in params.function_tools} == {
        "list_skills",
        "load_skill",
        "read_skill_resource",
    }


@pytest.mark.asyncio
async def test_run_agent_selector_returns_structured_selection() -> None:
    """Verify selector execution returns the model's structured recommendation.

    Returns:
        None.
    """
    model = TestModel(
        call_tools=[],
        custom_output_args={
            "action": "selected",
            "recommended_agent_id": "handover-agent",
            "matched_skill_names": ["handover-brief-builder"],
            "reasoning_summary": "The request is asking for a shift handoff.",
            "needs_clarification": False,
            "follow_up_question": None,
        },
    )

    result = await run_agent_selector(make_invocation(), model=model)

    assert result.recommended_agent_id == "handover-agent"
    assert result.matched_skill_names == ["handover-brief-builder"]
