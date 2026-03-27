"""Runtime helpers for the image-generation agent package."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, cast

from pydantic_ai import Agent, BinaryContent, BinaryImage, ImageGenerationTool
from pydantic_ai.messages import UserContent
from pydantic_ai.models import KnownModelName, Model
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.providers.google import GoogleProvider

from agents_party.config import read_non_blank_text, settings
from agents_party.domain import ThreadMessage

from .models import ImageGenerationInvocation

DEFAULT_IMAGE_GENERATION_MODEL = "gemini-2.5-flash-image"

IMAGE_GENERATION_SCOPE_SECTION = """
Generate exactly one Slack-ready image that matches the user's prompt.
Prefer clear visual composition, strong subject fidelity, and safe outputs.
Do not add explanatory prose because the caller expects an image file.
"""

IMAGE_GENERATION_STYLE_SECTION = """
When the prompt is underspecified, make reasonable artistic choices instead of asking follow-up questions.
Preserve explicit style, medium, composition, color, and framing instructions when they are present.
Avoid embedding text into the image unless the prompt explicitly asks for visible lettering.
Use Slack thread context when it clarifies references like "that idea" or "same composition as above".
Treat prior thread images as descriptive references only; you cannot inspect image pixels unless they were already described in the thread metadata.
"""


def _describe_thread_images(message: ThreadMessage) -> str | None:
    """Render image metadata from a normalized thread message.

    Args:
        message: Normalized thread message that may carry Slack image metadata.

    Returns:
        Human-readable image reference text, or `None` when no image metadata exists.
    """
    raw_images = message.metadata.get("slack_images")
    if not isinstance(raw_images, list) or not raw_images:
        return None

    descriptions: list[str] = []
    for index, raw_image in enumerate(raw_images, start=1):
        if not isinstance(raw_image, Mapping):
            continue
        image_payload = cast(Mapping[str, Any], raw_image)
        source = str(image_payload.get("source") or "image").strip() or "image"
        title = str(image_payload.get("title") or "").strip()
        alt_text = str(image_payload.get("alt_text") or "").strip()
        mime_type = str(image_payload.get("mime_type") or "").strip()
        details: list[str] = []
        if title:
            details.append(f'title="{title}"')
        if alt_text:
            details.append(f'alt="{alt_text}"')
        if mime_type:
            details.append(f"type={mime_type}")
        if details:
            descriptions.append(f"{source} image {index} ({', '.join(details)})")
        else:
            descriptions.append(f"{source} image {index}")

    if not descriptions:
        return None
    return "; ".join(descriptions)


def _format_thread_transcript(thread_messages: list[ThreadMessage]) -> str:
    """Render normalized Slack thread messages for image-generation context.

    Args:
        thread_messages: Normalized Slack thread messages in chronological order.

    Returns:
        Plain-text transcript used as optional prompt context.
    """
    lines: list[str] = []
    for message in thread_messages:
        speaker = message.role.value
        if message.user_id:
            speaker = f"{speaker}:{message.user_id}"
        parts: list[str] = []
        text = message.text.strip()
        if text:
            parts.append(text)
        image_description = _describe_thread_images(message)
        if image_description:
            parts.append(f"Attached images: {image_description}")
        if not parts:
            continue
        lines.append(f"[{message.ts}] {speaker} {' | '.join(parts)}")
    return "\n".join(lines)


def _format_thread_message_context(
    message: ThreadMessage,
    *,
    attached_reference_count: int,
) -> str | None:
    """Render one Slack thread message as a chronological context block.

    Args:
        message: Normalized Slack thread message to render.
        attached_reference_count: Number of binary reference images that will be
            appended immediately after this message block.

    Returns:
        Plain-text message block, or `None` when the message contributes no
        usable text or image metadata.
    """
    speaker = message.role.value
    if message.user_id:
        speaker = f"{speaker}:{message.user_id}"

    parts: list[str] = []
    text = message.text.strip()
    if text:
        parts.append(text)
    image_description = _describe_thread_images(message)
    if image_description:
        parts.append(f"Attached images: {image_description}")
    if attached_reference_count:
        noun = "image" if attached_reference_count == 1 else "images"
        parts.append(
            f"{attached_reference_count} binary reference {noun} follow immediately after this message."
        )
    if not parts:
        return None
    return f"[{message.ts}] {speaker} {' | '.join(parts)}"


def _group_reference_images_by_message_ts(
    invocation: ImageGenerationInvocation,
) -> tuple[dict[str, list[BinaryContent]], list[BinaryContent]]:
    """Group binary reference images by their source message timestamp.

    Args:
        invocation: Validated image-generation invocation carrying references.

    Returns:
        Tuple of per-message binary images and unordered fallback images.
    """
    grouped: dict[str, list[BinaryContent]] = {}
    unordered: list[BinaryContent] = []
    for reference_image in invocation.reference_images:
        binary_image = BinaryContent(
            data=reference_image.data,
            media_type=reference_image.media_type,
            identifier=reference_image.identifier,
        )
        if reference_image.message_ts:
            grouped.setdefault(reference_image.message_ts, []).append(binary_image)
        else:
            unordered.append(binary_image)
    return grouped, unordered


def build_image_generation_instructions() -> tuple[str, ...]:
    """Return the instruction blocks used by the image-generation agent.

    Returns:
        Ordered instruction strings fed into the image-generation agent.
    """
    return (
        "You generate images for Slack users.",
        IMAGE_GENERATION_SCOPE_SECTION.strip(),
        IMAGE_GENERATION_STYLE_SECTION.strip(),
    )


def build_image_generation_prompt(invocation: ImageGenerationInvocation) -> str:
    """Render the image-generation prompt from a validated invocation.

    Args:
        invocation: Validated image-generation invocation to encode into the prompt.

    Returns:
        Prompt text containing the user image request.
    """
    sections = [f"Image request:\n{invocation.prompt}"]
    transcript = _format_thread_transcript(invocation.thread_messages)
    if transcript:
        sections.append(
            "Slack thread context is provided in chronological order as separate prompt parts after this header."
        )
    if invocation.user_id:
        sections.append(f"Requesting Slack user:\n{invocation.user_id}")
    if invocation.team_id:
        sections.append(f"Slack workspace:\n{invocation.team_id}")
    if invocation.reference_images:
        sections.append(
            f"Attached reference images:\n{len(invocation.reference_images)} binary image(s) accompany this request."
        )
    sections.append("Generate exactly one image for this request.")
    return "\n\n".join(sections)


def build_image_generation_user_prompt(
    invocation: ImageGenerationInvocation,
) -> Sequence[UserContent]:
    """Render multimodal prompt content for image generation.

    Args:
        invocation: Validated image-generation invocation to encode into the prompt.

    Returns:
        Ordered user content parts combining text instructions and binary references.
    """
    prompt_parts: list[UserContent] = [build_image_generation_prompt(invocation)]
    grouped_reference_images, unordered_reference_images = (
        _group_reference_images_by_message_ts(invocation)
    )

    for message in invocation.thread_messages:
        message_reference_images = grouped_reference_images.get(message.ts, [])
        message_block = _format_thread_message_context(
            message,
            attached_reference_count=len(message_reference_images),
        )
        if message_block is not None:
            prompt_parts.append(message_block)
        prompt_parts.extend(message_reference_images)

    if unordered_reference_images:
        prompt_parts.append(
            "Unordered reference images without a source Slack message are attached below."
        )
        prompt_parts.extend(unordered_reference_images)
    return prompt_parts


def _build_default_google_image_model(model_name: str) -> GoogleModel:
    """Build the default Vertex AI Gemini model for image generation.

    Args:
        model_name: Bare Gemini image model name without a provider prefix.

    Returns:
        Configured Google model bound to Vertex AI.

    Raises:
        ValueError: If the Google Cloud project id or model name is missing.
    """
    project_id = read_non_blank_text(
        settings.google_cloud_project,
        env_name="GOOGLE_CLOUD_PROJECT",
    )
    normalized_model_name = model_name.strip()
    if not normalized_model_name:
        raise ValueError("IMAGE_GENERATION_MODEL is not configured.")

    provider = GoogleProvider(
        project=project_id,
        location=settings.google_cloud_location,
    )
    return GoogleModel(
        model_name=normalized_model_name,
        provider=provider,
    )


def _resolve_image_generation_model(
    model: Model | KnownModelName | str | None,
) -> Model | KnownModelName | str:
    """Resolve the configured model for the image-generation agent.

    Args:
        model: Optional provider-qualified override or explicit model instance.

    Returns:
        Model object or provider-qualified model identifier understood by Pydantic AI.

    Raises:
        ValueError: If the resolved model name is blank or configuration is incomplete.
    """
    if model is None:
        configured_model = (
            settings.image_generation_model or DEFAULT_IMAGE_GENERATION_MODEL
        )
        if ":" in configured_model:
            return configured_model
        return _build_default_google_image_model(configured_model)
    if isinstance(model, str) and ":" not in model:
        return _build_default_google_image_model(model)
    return model


def build_image_generation_agent(
    model: Model | KnownModelName | str | None = None,
) -> Agent[None, BinaryImage]:
    """Build the image-generation agent.

    Args:
        model: Optional provider-qualified Gemini model override for the agent.

    Returns:
        Configured image-generation agent instance.

    Raises:
        ValueError: If the default Google Cloud configuration is incomplete.
    """
    agent = cast(
        Agent[None, BinaryImage],
        Agent(
            _resolve_image_generation_model(model),
            name="image_generation",
            deps_type=type(None),
            output_type=BinaryImage,
            instructions=build_image_generation_instructions(),
            builtin_tools=[ImageGenerationTool(output_format="png")],
            defer_model_check=True,
        ),
    )
    return agent


async def run_image_generation(
    invocation: Mapping[str, Any] | ImageGenerationInvocation,
    *,
    model: Model | KnownModelName | str | None = None,
) -> BinaryImage:
    """Run the image-generation agent for a Slack-originated request.

    Args:
        invocation: Raw or validated image-generation invocation payload.
        model: Optional provider-qualified model override for this run.

    Returns:
        Binary image generated by the model.
    """
    parsed_invocation = (
        invocation
        if isinstance(invocation, ImageGenerationInvocation)
        else ImageGenerationInvocation.from_mapping(invocation)
    )
    agent = build_image_generation_agent(model=model)
    result = await agent.run(build_image_generation_user_prompt(parsed_invocation))
    return result.output


__all__ = [
    "DEFAULT_IMAGE_GENERATION_MODEL",
    "build_image_generation_agent",
    "build_image_generation_instructions",
    "build_image_generation_prompt",
    "build_image_generation_user_prompt",
    "run_image_generation",
]
