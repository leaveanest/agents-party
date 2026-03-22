from __future__ import annotations

import json
from enum import StrEnum
from typing import Any, Mapping, cast

from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai import Agent, RunContext
from pydantic_ai.models import KnownModelName, Model

from agents_party.agents.skills import build_builtin_skills_toolset
from agents_party.config import settings


class AgentSelectorCandidate(BaseModel):
    """Candidate agent metadata used by the selector model."""

    model_config = ConfigDict(extra="forbid")

    agent_id: str
    name: str
    description: str
    when_to_use: str | None = None
    supported_skill_names: list[str] = Field(default_factory=list)
    enabled: bool = True


class AgentSelectorInvocation(BaseModel):
    """Selector input containing the request text and available agent candidates."""

    model_config = ConfigDict(extra="forbid")

    text: str
    candidates: list[AgentSelectorCandidate]
    team_id: str | None = None
    channel_id: str | None = None
    thread_ts: str | None = None
    context_summary: str | None = None

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any]) -> AgentSelectorInvocation:
        """Validate a generic mapping into a typed selector invocation.

        Args:
            data: Untrusted invocation payload supplied by callers.

        Returns:
            Validated selector invocation model.
        """
        return cls.model_validate(data)


class AgentSelectorAction(StrEnum):
    SELECTED = "selected"
    CLARIFICATION_NEEDED = "clarification_needed"
    NO_MATCH = "no_match"


class AgentSelectorResult(BaseModel):
    """Structured selector decision returned by the model."""

    model_config = ConfigDict(extra="forbid")

    action: AgentSelectorAction
    recommended_agent_id: str | None = None
    matched_skill_names: list[str] = Field(default_factory=list)
    reasoning_summary: str
    needs_clarification: bool = False
    follow_up_question: str | None = None


AGENT_SELECTOR_SELECTION_SECTION = """
Choose the most specific enabled agent that can handle the request.
Use candidate descriptions, `when_to_use`, and `supported_skill_names` together.
Do not recommend an agent id that is not present in the provided candidate list.
"""


AGENT_SELECTOR_SKILLS_SECTION = """
Use the built-in skills tools when capability overlap exists or when the right skill is not obvious.
Inspect relevant skills before deciding, and include the matched skill names in the final output when they informed the decision.
Do not use `run_skill_script`; this selector only needs skill discovery and reading.
"""


AGENT_SELECTOR_CLARIFIER_SECTION = """
If no candidate is a clear fit, ask one short blocking question and return `clarification_needed`.
If none of the candidates should handle the request, return `no_match`.
Keep the reasoning summary short and operational.
"""


def build_agent_selector_instructions() -> tuple[str, ...]:
    """Return the instruction blocks used by the agent selector.

    Returns:
        Ordered instruction strings fed into the selector agent.
    """
    return (
        "You choose which agent should handle an incoming Slack request.",
        "Treat the provided candidate list as the full set of available agents for this decision.",
        AGENT_SELECTOR_SELECTION_SECTION.strip(),
        AGENT_SELECTOR_SKILLS_SECTION.strip(),
        AGENT_SELECTOR_CLARIFIER_SECTION.strip(),
    )


def build_agent_selector_prompt(invocation: AgentSelectorInvocation) -> str:
    """Render a stable JSON prompt payload for selector inference.

    Args:
        invocation: Validated selector invocation to encode into the prompt.

    Returns:
        Prompt text containing the serialized routing context.
    """
    payload = {
        "request_text": invocation.text,
        "team_id": invocation.team_id,
        "channel_id": invocation.channel_id,
        "thread_ts": invocation.thread_ts,
        "context_summary": invocation.context_summary,
        "candidates": [
            candidate.model_dump(mode="python") for candidate in invocation.candidates
        ],
    }
    return (
        "Select the best agent for this request.\n"
        "Return a structured recommendation.\n"
        f"{json.dumps(payload, ensure_ascii=True, indent=2)}"
    )


def build_agent_selector_agent(
    model: Model | KnownModelName | str | None = None,
) -> Agent[None, AgentSelectorResult]:
    """Build the selector agent with built-in skill discovery tools enabled.

    Args:
        model: Optional model override for the selector agent.

    Returns:
        Configured selector agent.

    Raises:
        ValueError: If no selector model can be resolved from configuration or arguments.
    """
    resolved_model = (
        model or settings.agent_selector_model or settings.work_manager_model
    )
    if resolved_model is None:
        raise ValueError(
            "Agent selector model is not configured. Set AGENT_SELECTOR_MODEL, "
            "WORK_MANAGER_MODEL, or pass a model explicitly."
        )

    agent = cast(
        Agent[None, AgentSelectorResult],
        Agent(
            resolved_model,
            name="agent_selector",
            deps_type=type(None),
            output_type=AgentSelectorResult,
            instructions=build_agent_selector_instructions(),
            toolsets=[
                build_builtin_skills_toolset(
                    exclude_tools={"run_skill_script"},
                )
            ],
            defer_model_check=True,
        ),
    )

    @agent.output_validator
    def _validate_selector_output(
        ctx: RunContext[None],
        output: AgentSelectorResult,
    ) -> AgentSelectorResult:
        """Normalize selector output before it is returned to callers.

        Args:
            ctx: Pydantic AI run context for the selector execution.
            output: Raw selector output generated by the model.

        Returns:
            Normalized selector output ready for callers.
        """
        return _validate_output(ctx, output)

    return agent


def _validate_output(
    _ctx: RunContext[None],
    output: AgentSelectorResult,
) -> AgentSelectorResult:
    """Normalize selector output fields for each action type.

    Args:
        _ctx: Pydantic AI run context, unused during normalization.
        output: Selector output to normalize in place.

    Returns:
        Normalized selector output.
    """
    if output.action == AgentSelectorAction.SELECTED:
        output.needs_clarification = False
        output.follow_up_question = None
    elif output.action == AgentSelectorAction.CLARIFICATION_NEEDED:
        output.needs_clarification = True
        if not output.follow_up_question:
            output.follow_up_question = "Which agent capability do you want to use?"
    else:
        output.needs_clarification = False
        output.recommended_agent_id = None
        output.follow_up_question = None

    if not output.reasoning_summary.strip():
        output.reasoning_summary = "No selector reasoning was provided."
    return output


def _configuration_error_result() -> AgentSelectorResult:
    """Return a stable fallback when the selector model is not configured.

    Returns:
        Selector result explaining the missing model configuration.
    """
    return AgentSelectorResult(
        action=AgentSelectorAction.NO_MATCH,
        reasoning_summary=(
            "Agent selector is not configured. Set AGENT_SELECTOR_MODEL or "
            "WORK_MANAGER_MODEL before using it."
        ),
    )


async def run_agent_selector(
    invocation: Mapping[str, Any] | AgentSelectorInvocation,
    *,
    model: Model | KnownModelName | str | None = None,
) -> AgentSelectorResult:
    """Run the selector agent and return a structured routing decision.

    Args:
        invocation: Raw or validated selector invocation payload.
        model: Optional model override for this selector run.

    Returns:
        Structured selector decision.
    """
    parsed_invocation = (
        invocation
        if isinstance(invocation, AgentSelectorInvocation)
        else AgentSelectorInvocation.from_mapping(invocation)
    )
    resolved_model = (
        model or settings.agent_selector_model or settings.work_manager_model
    )
    if resolved_model is None:
        return _configuration_error_result()

    agent = build_agent_selector_agent(model=resolved_model)
    result = await agent.run(build_agent_selector_prompt(parsed_invocation))
    return result.output


__all__ = [
    "AGENT_SELECTOR_CLARIFIER_SECTION",
    "AGENT_SELECTOR_SELECTION_SECTION",
    "AGENT_SELECTOR_SKILLS_SECTION",
    "AgentSelectorAction",
    "AgentSelectorCandidate",
    "AgentSelectorInvocation",
    "AgentSelectorResult",
    "build_agent_selector_agent",
    "build_agent_selector_instructions",
    "build_agent_selector_prompt",
    "run_agent_selector",
]
