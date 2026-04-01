"""Runtime helpers for the video-generation agent package."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Mapping
from typing import Any, cast

from google import genai
from google.genai import types
from pydantic_ai import Agent, BinaryContent
from pydantic_ai.models import KnownModelName, Model
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.providers.google import GoogleProvider

from agents_party.config import read_non_blank_text, settings
from agents_party.domain import ThreadMessage

from .models import VideoGenerationInvocation, VideoGenerationPlan

DEFAULT_VIDEO_GENERATION_MODEL = "veo-3.1-fast-generate-001"
DEFAULT_VIDEO_GENERATION_PROMPT_MODEL = "gemini-2.5-flash"
_VIDEO_GENERATION_API_VERSION = "v1"
_VIDEO_GENERATION_POLL_INTERVAL_SECONDS = 10
_VIDEO_GENERATION_TIMEOUT_SECONDS = 6 * 60 + 30

VIDEO_GENERATION_SCOPE_SECTION = """
Generate exactly one Slack-ready text-to-video request plan for Veo.
This feature is text-to-video only for now; do not assume image, first-frame, or last-frame inputs.
Prefer prompts that preserve the user's requested subject, action, style, camera language, and audio cues.
"""

VIDEO_GENERATION_STYLE_SECTION = """
Keep the final Veo prompt vivid but compact.
Use `9:16` only when the user clearly asks for a vertical, portrait, short-form, or reels-style video.
Otherwise default to `16:9`.
Use 8 seconds unless the user explicitly asks for 4 or 6 seconds.
Only set `negative_prompt` when the user explicitly excludes content or style.
"""


def _format_thread_transcript(thread_messages: list[ThreadMessage]) -> str:
    """Render Slack thread messages into a stable transcript block.

    Args:
        thread_messages: Normalized Slack thread messages in chronological order.

    Returns:
        Plain-text transcript used as optional video-generation context.
    """
    lines: list[str] = []
    for message in thread_messages:
        speaker = message.role.value
        if message.user_id:
            speaker = f"{speaker}:{message.user_id}"
        text = message.text.strip()
        if not text:
            continue
        lines.append(f"[{message.ts}] {speaker} {text}")
    return "\n".join(lines)


def build_video_generation_instructions() -> tuple[str, ...]:
    """Return the instruction blocks used by the video-generation planner.

    Returns:
        Ordered instruction strings fed into the planning agent.
    """
    return (
        "You prepare text-to-video generation plans for Slack users.",
        VIDEO_GENERATION_SCOPE_SECTION.strip(),
        VIDEO_GENERATION_STYLE_SECTION.strip(),
    )


def build_video_generation_prompt(invocation: VideoGenerationInvocation) -> str:
    """Render the video-generation prompt from a validated invocation.

    Args:
        invocation: Validated video-generation invocation to encode into the prompt.

    Returns:
        Prompt text containing the user video request and optional Slack context.
    """
    sections = [f"Video request:\n{invocation.prompt}"]
    transcript = _format_thread_transcript(invocation.thread_messages)
    if transcript:
        sections.append(f"Slack thread context:\n{transcript}")
    if invocation.user_id:
        sections.append(f"Requesting Slack user:\n{invocation.user_id}")
    if invocation.team_id:
        sections.append(f"Slack workspace:\n{invocation.team_id}")
    sections.append(
        "Return a Veo plan with one prompt, one aspect ratio, one duration, and an optional negative prompt."
    )
    return "\n\n".join(sections)


def _build_default_google_prompt_model(model_name: str) -> GoogleModel:
    """Build the default Vertex AI Gemini model for prompt preparation.

    Args:
        model_name: Bare Gemini model name without a provider prefix.

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
        raise ValueError("VIDEO_GENERATION_PROMPT_MODEL is not configured.")

    provider = GoogleProvider(
        project=project_id,
        location=settings.google_cloud_location,
    )
    return GoogleModel(
        model_name=normalized_model_name,
        provider=provider,
    )


def _resolve_video_generation_prompt_model(
    model: Model | KnownModelName | str | None,
) -> Model | KnownModelName | str:
    """Resolve the configured model for video-generation prompt preparation.

    Args:
        model: Optional provider-qualified override or explicit model instance.

    Returns:
        Model object or provider-qualified model identifier understood by Pydantic AI.

    Raises:
        ValueError: If the resolved model name is blank or configuration is incomplete.
    """
    if model is None:
        configured_model = (
            settings.video_generation_prompt_model
            or DEFAULT_VIDEO_GENERATION_PROMPT_MODEL
        )
        if ":" in configured_model:
            return configured_model
        return _build_default_google_prompt_model(configured_model)
    if isinstance(model, str) and ":" not in model:
        return _build_default_google_prompt_model(model)
    return model


def build_video_generation_agent(
    model: Model | KnownModelName | str | None = None,
) -> Agent[None, VideoGenerationPlan]:
    """Build the video-generation planning agent.

    Args:
        model: Optional provider-qualified Gemini model override for the planner.

    Returns:
        Configured video-generation planning agent instance.

    Raises:
        ValueError: If the default Google Cloud configuration is incomplete.
    """
    agent = cast(
        Agent[None, VideoGenerationPlan],
        Agent(
            _resolve_video_generation_prompt_model(model),
            name="video_generation",
            deps_type=type(None),
            output_type=VideoGenerationPlan,
            instructions=build_video_generation_instructions(),
            defer_model_check=True,
        ),
    )
    return agent


def _resolve_video_generation_model_name(model_name: str | None) -> str:
    """Resolve the configured Veo model name used for final rendering.

    Args:
        model_name: Optional explicit Veo model override.

    Returns:
        Bare Veo model name suitable for the Google Gen AI SDK.

    Raises:
        ValueError: If the configured model name is missing or blank.
    """
    configured_model_name = model_name or settings.video_generation_model
    normalized_model_name = configured_model_name.strip()
    if not normalized_model_name:
        raise ValueError("VIDEO_GENERATION_MODEL is not configured.")
    if ":" in normalized_model_name:
        _, normalized_model_name = normalized_model_name.split(":", 1)
        normalized_model_name = normalized_model_name.strip()
    if not normalized_model_name:
        raise ValueError("VIDEO_GENERATION_MODEL is not configured.")
    return normalized_model_name


def _build_vertex_genai_client() -> genai.Client:
    """Build a Vertex AI Google Gen AI client for Veo requests.

    Returns:
        Configured synchronous Google Gen AI client bound to Vertex AI.

    Raises:
        ValueError: If the Google Cloud project id is missing.
    """
    project_id = read_non_blank_text(
        settings.google_cloud_project,
        env_name="GOOGLE_CLOUD_PROJECT",
    )
    return genai.Client(
        vertexai=True,
        project=project_id,
        location=settings.google_cloud_location,
        http_options=types.HttpOptions(api_version=_VIDEO_GENERATION_API_VERSION),
    )


def _generate_video_from_plan_sync(
    plan: VideoGenerationPlan,
    *,
    model_name: str,
) -> BinaryContent:
    """Run a blocking Veo text-to-video request and download the rendered video.

    Args:
        plan: Prepared Veo request plan generated by the planning agent.
        model_name: Bare Veo model name used for the rendering request.

    Returns:
        Downloaded binary video payload suitable for Slack upload.

    Raises:
        RuntimeError: If Veo returns an error or no downloadable video.
        TimeoutError: If the long-running operation exceeds the expected timeout.
        ValueError: If required Google Cloud configuration is missing.
    """
    client = _build_vertex_genai_client()
    operation = client.models.generate_videos(
        model=model_name,
        prompt=plan.prompt,
        config=types.GenerateVideosConfig(
            number_of_videos=1,
            aspect_ratio=plan.aspect_ratio,
            duration_seconds=plan.duration_seconds,
            negative_prompt=plan.negative_prompt,
        ),
    )

    deadline = time.monotonic() + _VIDEO_GENERATION_TIMEOUT_SECONDS
    while not operation.done:
        if time.monotonic() >= deadline:
            raise TimeoutError("Video generation timed out.")
        time.sleep(_VIDEO_GENERATION_POLL_INTERVAL_SECONDS)
        operation = client.operations.get(operation)

    if operation.error is not None:
        error_message = str(operation.error.get("message") or operation.error)
        raise RuntimeError(f"Video generation failed: {error_message}")

    response = operation.response or operation.result
    if response is None or not response.generated_videos:
        raise RuntimeError("Video generation returned no videos.")

    generated_video = response.generated_videos[0].video
    if generated_video is None:
        raise RuntimeError("Video generation returned no downloadable video.")

    video_bytes = client.files.download(file=generated_video)
    media_type = generated_video.mime_type or "video/mp4"
    return BinaryContent(data=video_bytes, media_type=media_type)


async def prepare_video_generation_plan(
    invocation: Mapping[str, Any] | VideoGenerationInvocation,
    *,
    model: Model | KnownModelName | str | None = None,
) -> VideoGenerationPlan:
    """Run the planning agent that converts a Slack request into a Veo plan.

    Args:
        invocation: Raw or validated video-generation invocation payload.
        model: Optional provider-qualified Gemini model override for planning.

    Returns:
        Structured Veo generation plan.
    """
    parsed_invocation = (
        invocation
        if isinstance(invocation, VideoGenerationInvocation)
        else VideoGenerationInvocation.from_mapping(invocation)
    )
    agent = build_video_generation_agent(model=model)
    result = await agent.run(build_video_generation_prompt(parsed_invocation))
    return result.output


async def run_video_generation(
    invocation: Mapping[str, Any] | VideoGenerationInvocation,
    *,
    prompt_model: Model | KnownModelName | str | None = None,
    generation_model: str | None = None,
) -> BinaryContent:
    """Run the text-to-video generation flow for a Slack-originated request.

    Args:
        invocation: Raw or validated video-generation invocation payload.
        prompt_model: Optional provider-qualified Gemini model override for planning.
        generation_model: Optional Veo model override for final rendering.

    Returns:
        Binary video generated by Veo and downloaded for Slack upload.
    """
    plan = await prepare_video_generation_plan(invocation, model=prompt_model)
    model_name = _resolve_video_generation_model_name(generation_model)
    return await asyncio.to_thread(
        _generate_video_from_plan_sync,
        plan,
        model_name=model_name,
    )


__all__ = [
    "DEFAULT_VIDEO_GENERATION_MODEL",
    "DEFAULT_VIDEO_GENERATION_PROMPT_MODEL",
    "build_video_generation_agent",
    "build_video_generation_instructions",
    "build_video_generation_prompt",
    "prepare_video_generation_plan",
    "run_video_generation",
]
