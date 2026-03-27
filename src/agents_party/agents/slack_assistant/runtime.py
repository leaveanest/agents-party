"""Runtime helpers for the Slack assistant package."""

from __future__ import annotations

from collections.abc import Mapping
from typing import cast

from pydantic_ai import Agent, BinaryImage, RunContext
from pydantic_ai.models import KnownModelName, Model

from agents_party.agents.image_generation import (
    ImageGenerationInvocation,
    run_image_generation,
)
from agents_party.agents.slack_runtime import SlackAgentInvocation
from agents_party.agents.translation import TranslationInvocation, run_translation
from agents_party.agents.web_research import (
    WebResearchInvocation,
    render_web_research_response,
    run_web_research,
)
from agents_party.agents.work_manager import WorkManagerInvocation, run_work_manager
from agents_party.config import settings
from agents_party.domain import ThreadMessage
from agents_party.repositories import WorkItemRepository

from .models import SlackAssistantAction, SlackAssistantDeps, SlackAssistantResult

SLACK_ASSISTANT_SCOPE_SECTION = """
You are the single public Slack assistant for this application.
Answer greetings, help requests, and capability questions directly.
Use exactly one delegation tool when the request clearly belongs to task management,
web research/current information, translation, or image generation.
"""

SLACK_ASSISTANT_DELEGATION_SECTION = """
Use `delegate_work_manager` for task capture, action items, ownership, status, due dates,
project follow-ups, and operational summaries that should become tracked work.
Use `delegate_web_research` for requests that depend on public web information,
verification, current facts, or cited research.
Use `delegate_translation` for language translation or rewriting one language into another.
Use `delegate_image_generation` when the user wants you to create or generate an image, illustration,
concept art, mockup, diagram image, or visual from a prompt.
"""

SLACK_ASSISTANT_IMAGE_ROUTING_SECTION = """
Treat visual-asset requests as image generation even when phrased indirectly.
Examples that should route to `delegate_image_generation` include:
- "make a mockup"
- "turn this into a visual"
- "draw a poster"
- "create a wireframe"
- "図にして"
- "モックにして"
- "ラフを出して"
- "この案をビジュアル化して"
If the user wants a poster, banner, thumbnail, logo, icon, wireframe, storyboard,
sketch, diagram image, concept art, or similar visual deliverable, prefer image generation.
"""

SLACK_ASSISTANT_OUTPUT_SECTION = """
If you answer directly, set `action` to `responded`.
If you use a delegation tool, set `action` to `delegated`, keep the delegated reply in `message`,
and keep the response concise.
If the request is missing a key detail, ask one short blocking question and set `action` to `clarification_needed`.
"""

SLACK_ASSISTANT_DIRECT_HELP = (
    "I can help with task management, web research, translation, and image generation.\n"
    "Try asking me to summarize follow-up actions, verify a current fact, translate part of the thread, or generate an image."
)

_DIRECT_IMAGE_GENERATION_PHRASES = (
    "generate an image",
    "generate image",
    "create an image",
    "make an image",
    "make a mockup",
    "create a mockup",
    "turn this into a visual",
    "draw a poster",
    "create a wireframe",
    "visualize this",
    "visualise this",
    "diagram this",
    "画像生成",
    "画像を生成",
    "画像にして",
    "イラスト化",
    "イラストにして",
    "図にして",
    "図を作って",
    "モックにして",
    "モックアップにして",
    "ラフを出して",
    "ビジュアル化して",
    "絵にして",
    "描いて",
)

_IMAGE_GENERATION_ACTION_PHRASES = (
    "generate",
    "create",
    "make",
    "draw",
    "render",
    "visualize",
    "visualise",
    "sketch",
    "生成",
    "作って",
    "作成",
    "描いて",
    "出して",
    "化して",
)

_IMAGE_GENERATION_VISUAL_NOUNS = (
    "image",
    "illustration",
    "mockup",
    "wireframe",
    "diagram",
    "poster",
    "banner",
    "thumbnail",
    "logo",
    "icon",
    "visual",
    "concept art",
    "storyboard",
    "moodboard",
    "画像",
    "イラスト",
    "モック",
    "モックアップ",
    "ワイヤーフレーム",
    "図",
    "ポスター",
    "バナー",
    "サムネ",
    "ロゴ",
    "アイコン",
    "ビジュアル",
    "ラフ",
    "絵",
)


def _format_thread_transcript(thread_messages: list[ThreadMessage]) -> str:
    """Render Slack thread messages into a stable transcript block.

    Args:
        thread_messages: Normalized Slack thread messages in chronological order.

    Returns:
        Plain-text transcript used as Slack assistant context.
    """
    lines: list[str] = []
    for message in thread_messages:
        speaker = message.role.value
        if message.user_id:
            speaker = f"{speaker}:{message.user_id}"
        lines.append(f"[{message.ts}] {speaker} {message.text}")
    return "\n".join(lines)


def _contains_any_phrase(text: str, phrases: tuple[str, ...]) -> bool:
    """Return whether the normalized text contains any routing phrase.

    Args:
        text: Normalized request text to inspect.
        phrases: Candidate phrases used for intent routing.

    Returns:
        `True` when any candidate phrase appears in the text.
    """
    return any(phrase in text for phrase in phrases)


def _looks_like_image_generation_request(invocation: SlackAgentInvocation) -> bool:
    """Return whether a Slack request should route directly to image generation.

    Args:
        invocation: Slack invocation being evaluated for routing.

    Returns:
        `True` when the request strongly resembles visual asset generation.
    """
    normalized_text = " ".join(invocation.text.casefold().split())
    if not normalized_text:
        return False
    if _contains_any_phrase(normalized_text, _DIRECT_IMAGE_GENERATION_PHRASES):
        return True
    return _contains_any_phrase(
        normalized_text, _IMAGE_GENERATION_ACTION_PHRASES
    ) and _contains_any_phrase(normalized_text, _IMAGE_GENERATION_VISUAL_NOUNS)


async def _run_image_generation_for_invocation(
    invocation: SlackAgentInvocation,
) -> tuple[BinaryImage, str]:
    """Generate an image directly from a Slack invocation.

    Args:
        invocation: Slack invocation containing the request and thread context.

    Returns:
        Generated image plus the Slack-ready completion message.
    """
    image = await run_image_generation(
        ImageGenerationInvocation(
            prompt=invocation.text,
            user_id=invocation.user_id,
            team_id=invocation.team_id,
            thread_messages=invocation.thread_messages,
            reference_images=invocation.reference_images,
        )
    )
    return image, f"Generated image for prompt:\n{invocation.text}"


def build_slack_assistant_instructions() -> tuple[str, ...]:
    """Return the instruction blocks used by the Slack assistant.

    Returns:
        Ordered instruction strings fed into the Slack assistant.
    """
    return (
        "You handle the public Slack entrypoint for Agents Party.",
        SLACK_ASSISTANT_SCOPE_SECTION.strip(),
        SLACK_ASSISTANT_DELEGATION_SECTION.strip(),
        SLACK_ASSISTANT_IMAGE_ROUTING_SECTION.strip(),
        SLACK_ASSISTANT_OUTPUT_SECTION.strip(),
    )


def build_slack_assistant_prompt(invocation: SlackAgentInvocation) -> str:
    """Render the Slack assistant prompt from a validated Slack invocation.

    Args:
        invocation: Validated Slack invocation to encode into the prompt.

    Returns:
        Prompt text containing the current request and optional transcript context.
    """
    sections = [f"Slack request:\n{invocation.text}"]
    transcript = _format_thread_transcript(invocation.thread_messages)
    if transcript:
        sections.append(f"Slack thread transcript:\n{transcript}")
    sections.append("Return the structured Slack assistant result for this request.")
    return "\n\n".join(sections)


def _configuration_error_result() -> SlackAssistantResult:
    """Return a stable fallback when the Slack assistant model is unavailable.

    Returns:
        Slack assistant result describing the missing model configuration.
    """
    return SlackAssistantResult(
        action=SlackAssistantAction.RESPONDED,
        message=(
            "Slack assistant is not configured. Set SLACK_ASSISTANT_MODEL or "
            "WORK_MANAGER_MODEL before using it."
        ),
    )


def build_slack_assistant_agent(
    model: Model | KnownModelName | str | None = None,
) -> Agent[SlackAssistantDeps, SlackAssistantResult]:
    """Build the Slack assistant agent.

    Args:
        model: Optional provider-qualified Gemini model override for the agent.

    Returns:
        Configured Slack assistant agent instance.

    Raises:
        ValueError: If no assistant model can be resolved from configuration or arguments.
    """
    resolved_model = (
        model or settings.slack_assistant_model or settings.work_manager_model
    )
    if resolved_model is None:
        raise ValueError(
            "Slack assistant model is not configured. Set SLACK_ASSISTANT_MODEL, "
            "WORK_MANAGER_MODEL, or pass a model explicitly."
        )

    agent = cast(
        Agent[SlackAssistantDeps, SlackAssistantResult],
        Agent(
            resolved_model,
            name="slack_assistant",
            deps_type=SlackAssistantDeps,
            output_type=SlackAssistantResult,
            instructions=build_slack_assistant_instructions(),
            defer_model_check=True,
        ),
    )

    @agent.tool
    async def delegate_work_manager(ctx: RunContext[SlackAssistantDeps]) -> str:
        """Delegate the current Slack request to the work-manager specialist.

        Args:
            ctx: Runtime context containing the current Slack invocation and repositories.

        Returns:
            Slack-ready response produced by the work-manager runtime.
        """
        result = await run_work_manager(
            WorkManagerInvocation.model_validate(
                ctx.deps.invocation.model_dump(mode="python")
            ),
            repository=ctx.deps.work_item_repository,
        )
        message = result.follow_up_question or result.message
        ctx.deps.last_delegated_agent_id = "work-manager"
        ctx.deps.last_delegated_message = message
        ctx.deps.last_follow_up_question = result.follow_up_question
        return message

    @agent.tool
    async def delegate_web_research(ctx: RunContext[SlackAssistantDeps]) -> str:
        """Delegate the current Slack request to the web-research specialist.

        Args:
            ctx: Runtime context containing the current Slack invocation.

        Returns:
            Slack-ready response produced by the web-research runtime.
        """
        result = await run_web_research(
            WebResearchInvocation.model_validate(
                ctx.deps.invocation.model_dump(mode="python")
            )
        )
        message = result.follow_up_question or render_web_research_response(result)
        ctx.deps.last_delegated_agent_id = "web-research"
        ctx.deps.last_delegated_message = message
        ctx.deps.last_follow_up_question = result.follow_up_question
        return message

    @agent.tool
    async def delegate_translation(ctx: RunContext[SlackAssistantDeps]) -> str:
        """Delegate the current Slack request to the translation specialist.

        Args:
            ctx: Runtime context containing the current Slack invocation.

        Returns:
            Slack-ready response produced by the translation runtime.
        """
        result = await run_translation(
            TranslationInvocation.model_validate(
                ctx.deps.invocation.model_dump(mode="python")
            )
        )
        message = result.follow_up_question or result.translated_text
        ctx.deps.last_delegated_agent_id = "translation"
        ctx.deps.last_delegated_message = message
        ctx.deps.last_follow_up_question = result.follow_up_question
        return message

    @agent.tool
    async def delegate_image_generation(ctx: RunContext[SlackAssistantDeps]) -> str:
        """Delegate the current Slack request to the image-generation specialist.

        Args:
            ctx: Runtime context containing the current Slack invocation, thread
                transcript, and downloaded reference images.

        Returns:
            Slack-ready status message describing the generated image result.
        """
        image, message = await _run_image_generation_for_invocation(ctx.deps.invocation)
        ctx.deps.last_delegated_agent_id = "image-generation"
        ctx.deps.last_delegated_message = message
        ctx.deps.last_follow_up_question = None
        ctx.deps.last_generated_image = image
        return message

    @agent.output_validator
    def _validate_output(
        ctx: RunContext[SlackAssistantDeps],
        output: SlackAssistantResult,
    ) -> SlackAssistantResult:
        """Normalize Slack assistant output before returning it to callers.

        Args:
            ctx: Pydantic AI run context carrying the current dependencies.
            output: Raw Slack assistant result generated by the model.

        Returns:
            Normalized Slack assistant result.
        """
        delegated_agent_id = ctx.deps.last_delegated_agent_id
        delegated_message = ctx.deps.last_delegated_message
        delegated_follow_up = ctx.deps.last_follow_up_question
        delegated_image = ctx.deps.last_generated_image

        if output.action == SlackAssistantAction.CLARIFICATION_NEEDED:
            output.message = ""
            output.delegated_agent_id = None
            output.generated_image = None
            if not output.follow_up_question:
                output.follow_up_question = "What would you like me to help with?"
            return output

        if delegated_agent_id is not None:
            output.action = SlackAssistantAction.DELEGATED
            output.delegated_agent_id = delegated_agent_id
            output.follow_up_question = output.follow_up_question or delegated_follow_up
            output.generated_image = delegated_image
            if not output.message.strip() and delegated_message is not None:
                output.message = delegated_message
        else:
            output.action = SlackAssistantAction.RESPONDED
            output.delegated_agent_id = None
            output.follow_up_question = None
            output.generated_image = None

        if not output.message.strip():
            output.message = SLACK_ASSISTANT_DIRECT_HELP
        return output

    return agent


async def run_slack_assistant(
    invocation: Mapping[str, object] | SlackAgentInvocation,
    *,
    work_item_repository: WorkItemRepository | None = None,
    model: Model | KnownModelName | str | None = None,
) -> SlackAssistantResult:
    """Run the Slack assistant for a Slack-originated request.

    Args:
        invocation: Raw or validated Slack invocation payload.
        work_item_repository: Optional repository override used by the work-manager tool.
        model: Optional provider-qualified model override for this run.

    Returns:
        Structured Slack assistant result.
    """
    parsed_invocation = (
        invocation
        if isinstance(invocation, SlackAgentInvocation)
        else SlackAgentInvocation.from_mapping(invocation)
    )
    if _looks_like_image_generation_request(parsed_invocation):
        generated_image, message = await _run_image_generation_for_invocation(
            parsed_invocation
        )
        return SlackAssistantResult(
            action=SlackAssistantAction.DELEGATED,
            message=message,
            delegated_agent_id="image-generation",
            generated_image=generated_image,
        )
    resolved_model = (
        model or settings.slack_assistant_model or settings.work_manager_model
    )
    if resolved_model is None:
        return _configuration_error_result()

    deps = SlackAssistantDeps(
        invocation=parsed_invocation,
        work_item_repository=work_item_repository,
    )
    agent = build_slack_assistant_agent(model=resolved_model)
    result = await agent.run(build_slack_assistant_prompt(parsed_invocation), deps=deps)
    return result.output


__all__ = [
    "build_slack_assistant_agent",
    "build_slack_assistant_instructions",
    "build_slack_assistant_prompt",
    "run_slack_assistant",
]
