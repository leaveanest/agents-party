"""Runtime helpers for the agent-router package."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Literal, cast

from pydantic_ai import Agent, RunContext
from pydantic_ai.models import KnownModelName, Model

from agents_party.agents.image_generation import (
    ImageGenerationInvocation,
    run_image_generation,
)
from agents_party.agents.slack_runtime import SlackAgentInvocation
from agents_party.agents.translation import TranslationInvocation, run_translation
from agents_party.agents.video_generation import (
    VideoGenerationInvocation,
    run_video_generation,
)
from agents_party.agents.web_research import (
    WebResearchInvocation,
    render_web_research_response,
    run_web_research,
)
from agents_party.agents.work_manager import WorkManagerInvocation, run_work_manager
from agents_party.config import settings
from agents_party.domain import ThreadMessage
from agents_party.repositories import WorkItemRepository

from .models import (
    AgentRouterAction,
    AgentRouterDeps,
    AgentRouterResult,
    SpecialistOutcome,
)

SpecialistMediaKind = Literal["text", "image", "video"]
SpecialistRunner = Callable[[AgentRouterDeps], Awaitable[SpecialistOutcome]]

AGENT_ROUTER_SCOPE_SECTION = """
You are the public Slack-facing agent router for this application.
You may answer greetings, general help, and lightweight conversation directly.
When the request clearly needs specialist execution, call one or more specialist tools
as subroutines and then return one concise final Slack-ready response.
"""

AGENT_ROUTER_ORCHESTRATION_SECTION = """
You may call multiple text specialists in a single run when combining their results helps.
You may call at most one media specialist, and if you call it, it must be the last specialist tool call.
If any specialist returns a follow-up question, stop orchestration and return `clarification_needed`.
Do not expose internal routing metadata in the final answer.
"""

AGENT_ROUTER_OUTPUT_SECTION = """
Return `responded` when you answer directly without specialists.
Return `orchestrated` when you used at least one specialist tool.
Return `clarification_needed` only when you need one short blocking question.
When orchestrating, synthesize the specialist outcomes into one concise Slack-ready reply.
"""

AGENT_ROUTER_DIRECT_HELP = (
    "I can help with general questions, task management, web research, "
    "translation, image generation, and video generation.\n"
    "Try asking me to summarize what you need, verify a current fact, "
    "translate part of the thread, or create an image or video."
)


@dataclass(frozen=True, slots=True)
class SpecialistSpec:
    """Registry entry describing a specialist exposed to the agent router."""

    specialist_id: str
    tool_name: str
    description: str
    media_kind: SpecialistMediaKind
    runner: SpecialistRunner


def _format_thread_transcript(thread_messages: list[ThreadMessage]) -> str:
    """Render Slack thread messages into a stable transcript block.

    Args:
        thread_messages: Normalized Slack thread messages in chronological order.

    Returns:
        Plain-text transcript used as agent-router context.
    """
    lines: list[str] = []
    for message in thread_messages:
        speaker = message.role.value
        if message.user_id:
            speaker = f"{speaker}:{message.user_id}"
        lines.append(f"[{message.ts}] {speaker} {message.text}")
    return "\n".join(lines)


async def _run_work_manager_specialist(
    deps: AgentRouterDeps,
) -> SpecialistOutcome:
    """Run the work-manager specialist and normalize its outcome.

    Args:
        deps: Current router dependencies and invocation context.

    Returns:
        Normalized specialist outcome for work-manager execution.
    """
    result = await run_work_manager(
        WorkManagerInvocation.model_validate(deps.invocation.model_dump(mode="python")),
        repository=deps.work_item_repository,
    )
    return SpecialistOutcome(
        specialist_id="work-manager",
        message=result.message,
        follow_up_question=result.follow_up_question,
    )


async def _run_web_research_specialist(
    deps: AgentRouterDeps,
) -> SpecialistOutcome:
    """Run the web-research specialist and normalize its outcome.

    Args:
        deps: Current router dependencies and invocation context.

    Returns:
        Normalized specialist outcome for web-research execution.
    """
    result = await run_web_research(
        WebResearchInvocation.model_validate(deps.invocation.model_dump(mode="python"))
    )
    return SpecialistOutcome(
        specialist_id="web-research",
        message=render_web_research_response(result),
        follow_up_question=result.follow_up_question,
    )


async def _run_translation_specialist(
    deps: AgentRouterDeps,
) -> SpecialistOutcome:
    """Run the translation specialist and normalize its outcome.

    Args:
        deps: Current router dependencies and invocation context.

    Returns:
        Normalized specialist outcome for translation execution.
    """
    result = await run_translation(
        TranslationInvocation.model_validate(deps.invocation.model_dump(mode="python"))
    )
    return SpecialistOutcome(
        specialist_id="translation",
        message=result.translated_text,
        follow_up_question=result.follow_up_question,
    )


async def _run_image_generation_specialist(
    deps: AgentRouterDeps,
) -> SpecialistOutcome:
    """Run the image-generation specialist and normalize its outcome.

    Args:
        deps: Current router dependencies and invocation context.

    Returns:
        Normalized specialist outcome for image-generation execution.
    """
    image = await run_image_generation(
        ImageGenerationInvocation(
            prompt=deps.invocation.text,
            user_id=deps.invocation.user_id,
            team_id=deps.invocation.team_id,
            thread_messages=deps.invocation.thread_messages,
            reference_images=deps.invocation.reference_images,
        )
    )
    return SpecialistOutcome(
        specialist_id="image-generation",
        message=f"Generated image for prompt:\n{deps.invocation.text}",
        generated_image=image,
    )


async def _run_video_generation_specialist(
    deps: AgentRouterDeps,
) -> SpecialistOutcome:
    """Run the video-generation specialist and normalize its outcome.

    Args:
        deps: Current router dependencies and invocation context.

    Returns:
        Normalized specialist outcome for video-generation execution.
    """
    video = await run_video_generation(
        VideoGenerationInvocation(
            prompt=deps.invocation.text,
            user_id=deps.invocation.user_id,
            team_id=deps.invocation.team_id,
            thread_messages=deps.invocation.thread_messages,
        )
    )
    return SpecialistOutcome(
        specialist_id="video-generation",
        message=f"Generated video for prompt:\n{deps.invocation.text}",
        generated_video=video,
    )


SPECIALIST_REGISTRY: tuple[SpecialistSpec, ...] = (
    SpecialistSpec(
        specialist_id="work-manager",
        tool_name="delegate_work_manager",
        description=(
            "Use for task capture, work-item updates, ownership, due dates, "
            "follow-up actions, or operational task summaries."
        ),
        media_kind="text",
        runner=_run_work_manager_specialist,
    ),
    SpecialistSpec(
        specialist_id="web-research",
        tool_name="delegate_web_research",
        description=(
            "Use for current facts, latest information, public-web verification, "
            "citations, or source-backed research."
        ),
        media_kind="text",
        runner=_run_web_research_specialist,
    ),
    SpecialistSpec(
        specialist_id="translation",
        tool_name="delegate_translation",
        description=(
            "Use for translation, bilingual rewriting, or converting content from "
            "one language to another."
        ),
        media_kind="text",
        runner=_run_translation_specialist,
    ),
    SpecialistSpec(
        specialist_id="image-generation",
        tool_name="delegate_image_generation",
        description=(
            "Use when the user wants an image, mockup, illustration, concept art, "
            "diagram image, or other visual asset."
        ),
        media_kind="image",
        runner=_run_image_generation_specialist,
    ),
    SpecialistSpec(
        specialist_id="video-generation",
        tool_name="delegate_video_generation",
        description=(
            "Use when the user wants a video, animation, teaser clip, motion "
            "mockup, or text-to-video output."
        ),
        media_kind="video",
        runner=_run_video_generation_specialist,
    ),
)


def _build_specialist_routing_section() -> str:
    """Render the registry-driven routing instructions for specialist tools.

    Returns:
        Instruction block enumerating the available specialist tools and their uses.
    """
    lines = ["Specialist tools:"]
    for spec in SPECIALIST_REGISTRY:
        lines.append(f"- `{spec.tool_name}`: {spec.description}")
    return "\n".join(lines)


def build_agent_router_instructions() -> tuple[str, ...]:
    """Return the instruction blocks used by the agent router.

    Returns:
        Ordered instruction strings fed into the agent router.
    """
    return (
        "You handle the public Slack entrypoint for Agents Party.",
        AGENT_ROUTER_SCOPE_SECTION.strip(),
        AGENT_ROUTER_ORCHESTRATION_SECTION.strip(),
        _build_specialist_routing_section(),
        AGENT_ROUTER_OUTPUT_SECTION.strip(),
    )


def build_agent_router_prompt(invocation: SlackAgentInvocation) -> str:
    """Render the agent-router prompt from a validated Slack invocation.

    Args:
        invocation: Validated Slack invocation to encode into the prompt.

    Returns:
        Prompt text containing the current request and optional transcript context.
    """
    sections = [f"Slack request:\n{invocation.text}"]
    transcript = _format_thread_transcript(invocation.thread_messages)
    if transcript:
        sections.append(f"Slack thread transcript:\n{transcript}")
    sections.append("Return the structured agent-router result for this request.")
    return "\n\n".join(sections)


def _configuration_error_result() -> AgentRouterResult:
    """Return a stable fallback when the agent-router model is unavailable.

    Returns:
        Agent-router result describing the missing model configuration.
    """
    return AgentRouterResult(
        action=AgentRouterAction.RESPONDED,
        message=(
            "Agent router is not configured. Set AGENT_SELECTOR_MODEL before using it."
        ),
    )


def _has_media_outcome(outcomes: list[SpecialistOutcome]) -> bool:
    """Return whether any prior specialist outcome produced media.

    Args:
        outcomes: Ordered specialist outcomes accumulated so far.

    Returns:
        `True` when a prior specialist produced an image or video payload.
    """
    return any(
        outcome.generated_image is not None or outcome.generated_video is not None
        for outcome in outcomes
    )


def _specialist_invocation_is_blocked(
    spec: SpecialistSpec,
    outcomes: list[SpecialistOutcome],
) -> str | None:
    """Return a blocking message when a later specialist call should no-op.

    Args:
        spec: Specialist about to be invoked.
        outcomes: Ordered specialist outcomes accumulated so far.

    Returns:
        Blocking text that should be returned to the model, or `None` when the
        specialist can proceed.
    """
    for outcome in outcomes:
        if outcome.follow_up_question:
            return outcome.follow_up_question

    if _has_media_outcome(outcomes):
        for outcome in reversed(outcomes):
            if (
                outcome.generated_image is not None
                or outcome.generated_video is not None
            ):
                return outcome.message
        return "A media specialist has already completed this request."

    if spec.media_kind != "text" and any(
        outcome.generated_image is not None or outcome.generated_video is not None
        for outcome in outcomes
    ):
        return outcomes[-1].message
    return None


def _final_media_outcome(
    outcomes: list[SpecialistOutcome],
) -> SpecialistOutcome | None:
    """Return the last specialist outcome carrying media, if any.

    Args:
        outcomes: Ordered specialist outcomes accumulated during the run.

    Returns:
        The last media-producing specialist outcome, or `None` when absent.
    """
    for outcome in reversed(outcomes):
        if outcome.generated_image is not None or outcome.generated_video is not None:
            return outcome
    return None


def _fallback_orchestrated_message(outcomes: list[SpecialistOutcome]) -> str:
    """Build a deterministic fallback response from specialist outcomes.

    Args:
        outcomes: Ordered normalized outcomes produced by specialists.

    Returns:
        Slack-ready fallback response used when the model leaves `message` blank.
    """
    messages = [
        outcome.message.strip() for outcome in outcomes if outcome.message.strip()
    ]
    if not messages:
        return AGENT_ROUTER_DIRECT_HELP
    return "\n\n".join(messages)


def _selected_specialist_ids(outcomes: list[SpecialistOutcome]) -> list[str]:
    """Return ordered deduplicated specialist ids from accumulated outcomes.

    Args:
        outcomes: Ordered normalized outcomes produced by specialists.

    Returns:
        Specialist ids in first-seen order.
    """
    selected_ids: list[str] = []
    seen_ids: set[str] = set()
    for outcome in outcomes:
        if outcome.specialist_id in seen_ids:
            continue
        seen_ids.add(outcome.specialist_id)
        selected_ids.append(outcome.specialist_id)
    return selected_ids


def build_agent_router_agent(
    model: Model | KnownModelName | str | None = None,
) -> Agent[AgentRouterDeps, AgentRouterResult]:
    """Build the agent router.

    Args:
        model: Optional provider-qualified Gemini model override for the router.

    Returns:
        Configured agent-router instance.

    Raises:
        ValueError: If no router model can be resolved from configuration or
            arguments.
    """
    resolved_model = model or settings.agent_selector_model
    if resolved_model is None:
        raise ValueError(
            "Agent router model is not configured. Set AGENT_SELECTOR_MODEL or "
            "pass a model explicitly."
        )

    agent = cast(
        Agent[AgentRouterDeps, AgentRouterResult],
        Agent(
            resolved_model,
            name="agent_router",
            deps_type=AgentRouterDeps,
            output_type=AgentRouterResult,
            instructions=build_agent_router_instructions(),
            defer_model_check=True,
        ),
    )

    def register_specialist_tool(spec: SpecialistSpec) -> None:
        """Register one registry-driven specialist tool on the router.

        Args:
            spec: Specialist registry entry to expose as a function tool.

        Returns:
            None.
        """

        async def tool(ctx: RunContext[AgentRouterDeps]) -> str:
            """Delegate the current Slack request to a specialist subroutine.

            Args:
                ctx: Runtime context containing the current Slack invocation and
                    specialist outcomes.

            Returns:
                Slack-ready response text returned by the specialist or produced by
                the short-circuit guard.
            """
            blocked_message = _specialist_invocation_is_blocked(
                spec, ctx.deps.specialist_outcomes
            )
            if blocked_message is not None:
                return blocked_message

            outcome = await spec.runner(ctx.deps)
            ctx.deps.specialist_outcomes.append(outcome)
            return outcome.follow_up_question or outcome.message

        tool.__name__ = spec.tool_name
        tool.__doc__ = (
            f"Delegate the current Slack request to the {spec.specialist_id} "
            "specialist."
        )
        agent.tool(tool)

    for spec in SPECIALIST_REGISTRY:
        register_specialist_tool(spec)

    @agent.output_validator
    def _validate_output(
        ctx: RunContext[AgentRouterDeps],
        output: AgentRouterResult,
    ) -> AgentRouterResult:
        """Normalize agent-router output before returning it to callers.

        Args:
            ctx: Pydantic AI run context carrying the current dependencies.
            output: Raw agent-router result generated by the model.

        Returns:
            Normalized agent-router result.
        """
        specialist_outcomes = ctx.deps.specialist_outcomes
        selected_specialist_ids = _selected_specialist_ids(specialist_outcomes)
        follow_up_question = next(
            (
                outcome.follow_up_question
                for outcome in specialist_outcomes
                if outcome.follow_up_question
            ),
            None,
        )
        media_outcome = _final_media_outcome(specialist_outcomes)

        if output.action == AgentRouterAction.CLARIFICATION_NEEDED:
            output.message = ""
            output.selected_specialist_ids = selected_specialist_ids
            output.generated_image = None
            output.generated_video = None
            if not output.follow_up_question:
                output.follow_up_question = "What would you like me to help with?"
            return output

        if follow_up_question is not None:
            output.action = AgentRouterAction.CLARIFICATION_NEEDED
            output.message = ""
            output.selected_specialist_ids = selected_specialist_ids
            output.follow_up_question = follow_up_question
            output.generated_image = None
            output.generated_video = None
            return output

        if selected_specialist_ids:
            output.action = AgentRouterAction.ORCHESTRATED
            output.selected_specialist_ids = selected_specialist_ids
            output.follow_up_question = None
            output.generated_image = (
                media_outcome.generated_image if media_outcome is not None else None
            )
            output.generated_video = (
                media_outcome.generated_video if media_outcome is not None else None
            )
            if not output.message.strip():
                output.message = _fallback_orchestrated_message(specialist_outcomes)
        else:
            output.action = AgentRouterAction.RESPONDED
            output.selected_specialist_ids = []
            output.follow_up_question = None
            output.generated_image = None
            output.generated_video = None
            if not output.message.strip():
                output.message = AGENT_ROUTER_DIRECT_HELP
        return output

    return agent


async def run_agent_router(
    invocation: Mapping[str, object] | SlackAgentInvocation,
    *,
    work_item_repository: WorkItemRepository | None = None,
    model: Model | KnownModelName | str | None = None,
) -> AgentRouterResult:
    """Run the agent router for a Slack-originated request.

    Args:
        invocation: Raw or validated Slack invocation payload.
        work_item_repository: Optional repository override used by the work-manager
            specialist.
        model: Optional provider-qualified model override for this run.

    Returns:
        Structured agent-router result.
    """
    parsed_invocation = (
        invocation
        if isinstance(invocation, SlackAgentInvocation)
        else SlackAgentInvocation.from_mapping(invocation)
    )
    resolved_model = model or settings.agent_selector_model
    if resolved_model is None:
        return _configuration_error_result()

    deps = AgentRouterDeps(
        invocation=parsed_invocation,
        work_item_repository=work_item_repository,
    )
    agent = build_agent_router_agent(model=resolved_model)
    result = await agent.run(build_agent_router_prompt(parsed_invocation), deps=deps)
    return result.output


__all__ = [
    "build_agent_router_agent",
    "build_agent_router_instructions",
    "build_agent_router_prompt",
    "run_agent_router",
]
