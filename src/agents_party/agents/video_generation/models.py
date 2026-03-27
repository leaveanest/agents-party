"""Typed models for the video-generation agent package."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field

from agents_party.domain import ThreadMessage


class VideoGenerationInvocation(BaseModel):
    """Request envelope specialized for text-to-video execution.

    Attributes:
        prompt: Natural-language prompt describing the requested video.
        user_id: Optional Slack user identifier associated with the request.
        team_id: Optional Slack workspace identifier associated with the request.
        thread_messages: Normalized Slack thread transcript available as context.
    """

    model_config = ConfigDict(extra="forbid")

    prompt: str
    user_id: str | None = None
    team_id: str | None = None
    thread_messages: list[ThreadMessage] = Field(default_factory=list)

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any]) -> Self:
        """Validate a generic mapping into a video-generation invocation.

        Args:
            data: Untrusted invocation payload supplied by callers.

        Returns:
            Validated video-generation invocation model.
        """
        return cls.model_validate(data)


class VideoGenerationPlan(BaseModel):
    """Structured Veo request prepared from a user prompt.

    Attributes:
        prompt: Final positive prompt sent to Veo.
        aspect_ratio: Output aspect ratio for the rendered video.
        duration_seconds: Output video duration in seconds.
        negative_prompt: Optional excluded elements expressed as a negative prompt.
    """

    model_config = ConfigDict(extra="forbid")

    prompt: str
    aspect_ratio: Literal["16:9", "9:16"] = "16:9"
    duration_seconds: Literal[4, 6, 8] = 8
    negative_prompt: str | None = None


__all__ = ["VideoGenerationInvocation", "VideoGenerationPlan"]
