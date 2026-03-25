"""Runtime helpers for the translation agent package."""

from __future__ import annotations

from collections.abc import Mapping
from typing import cast

from pydantic_ai import Agent, RunContext
from pydantic_ai.models import KnownModelName, Model

from agents_party.domain import ThreadMessage

from .models import TranslationAction, TranslationInvocation, TranslationResult

DEFAULT_TRANSLATION_MODEL = "google-gla:gemini-3-flash-preview"

TRANSLATION_SCOPE_SECTION = """
Translate only the content the user wants translated.
Preserve meaning, tone, formatting, markdown, bullet structure, line breaks, and code fences.
Do not add explanations before or after the translated text unless the user explicitly asks for them.
"""

TRANSLATION_CONTEXT_SECTION = """
When the request refers to `this`, `above`, `below`, or `latest message`,
use the provided Slack transcript to identify the text that should be translated.
Prefer quoted or clearly pasted source text over translating the user's instruction itself.
When `Source Slack message` is provided, translate that content instead of the request text.
"""

TRANSLATION_CLARIFIER_SECTION = """
If the target language is missing, ambiguous, or asks for multiple targets at once,
ask one short blocking question.
If there is no source text to translate and it cannot be inferred from the request or transcript,
ask one short blocking question.
"""

TRANSLATION_OUTPUT_SECTION = """
For successful translations, set `action` to `translated` and put only the translated content in `translated_text`.
Populate `source_language` and `target_language` when you can infer them reliably.
For clarification, set `action` to `clarification_needed`, leave `translated_text` empty,
and set `follow_up_question`.
"""


def _format_thread_transcript(thread_messages: list[ThreadMessage]) -> str:
    """Render Slack thread messages into a stable transcript block.

    Args:
        thread_messages: Normalized Slack thread messages in chronological order.

    Returns:
        Plain-text transcript used as translation context.
    """
    lines: list[str] = []
    for message in thread_messages:
        speaker = message.role.value
        if message.user_id:
            speaker = f"{speaker}:{message.user_id}"
        lines.append(f"[{message.ts}] {speaker} {message.text}")
    return "\n".join(lines)


def build_translation_instructions() -> tuple[str, ...]:
    """Return the instruction blocks used by the translation agent.

    Returns:
        Ordered instruction strings fed into the translation agent.
    """
    return (
        "You translate Slack conversations between languages for end users.",
        TRANSLATION_SCOPE_SECTION.strip(),
        TRANSLATION_CONTEXT_SECTION.strip(),
        TRANSLATION_CLARIFIER_SECTION.strip(),
        TRANSLATION_OUTPUT_SECTION.strip(),
    )


def build_translation_prompt(invocation: TranslationInvocation) -> str:
    """Render the translation prompt from a validated Slack invocation.

    Args:
        invocation: Validated translation invocation to encode into the prompt.

    Returns:
        Prompt text containing the current request and optional transcript context.
    """
    sections = [f"Slack request:\n{invocation.text}"]
    if invocation.requested_target_language:
        sections.append(
            f"Requested target language:\n{invocation.requested_target_language}"
        )
    if invocation.reaction_name:
        sections.append(f"Slack reaction trigger:\n{invocation.reaction_name}")
    if invocation.target_message_ts:
        sections.append(
            f"Target Slack message timestamp:\n{invocation.target_message_ts}"
        )
    if invocation.source_message_text:
        sections.append(f"Source Slack message:\n{invocation.source_message_text}")
    transcript = _format_thread_transcript(invocation.thread_messages)
    if transcript:
        sections.append(f"Slack thread transcript:\n{transcript}")
    sections.append("Return the structured translation result for this request.")
    return "\n\n".join(sections)


def build_translation_agent(
    model: Model | KnownModelName | str | None = None,
) -> Agent[None, TranslationResult]:
    """Build the translation agent.

    Args:
        model: Optional provider-qualified Gemini model override for the agent.

    Returns:
        Configured translation agent instance.
    """
    resolved_model = model or DEFAULT_TRANSLATION_MODEL
    agent = cast(
        Agent[None, TranslationResult],
        Agent(
            resolved_model,
            name="translation",
            deps_type=type(None),
            output_type=TranslationResult,
            instructions=build_translation_instructions(),
            defer_model_check=True,
        ),
    )

    @agent.output_validator
    def _validate_output(
        _ctx: RunContext[None],
        output: TranslationResult,
    ) -> TranslationResult:
        """Normalize translation output before returning it to callers.

        Args:
            _ctx: Pydantic AI run context, unused during normalization.
            output: Raw translation result generated by the model.

        Returns:
            Normalized translation result.
        """
        if output.action == TranslationAction.CLARIFICATION_NEEDED:
            output.translated_text = ""
            if not output.follow_up_question:
                output.follow_up_question = "Which language should I translate into?"
            return output

        output.follow_up_question = None
        if not output.translated_text.strip():
            output.translated_text = (
                "The translation agent did not produce a translation."
            )
        return output

    return agent


async def run_translation(
    invocation: Mapping[str, object] | TranslationInvocation,
    *,
    model: Model | KnownModelName | str | None = None,
) -> TranslationResult:
    """Run the translation agent for a Slack-originated request.

    Args:
        invocation: Raw or validated translation invocation payload.
        model: Optional provider-qualified model override for this run.

    Returns:
        Structured translation result.
    """
    parsed_invocation = (
        invocation
        if isinstance(invocation, TranslationInvocation)
        else TranslationInvocation.from_mapping(invocation)
    )
    agent = build_translation_agent(model=model)
    result = await agent.run(build_translation_prompt(parsed_invocation))
    return result.output


__all__ = [
    "DEFAULT_TRANSLATION_MODEL",
    "build_translation_agent",
    "build_translation_instructions",
    "build_translation_prompt",
    "run_translation",
]
