"""Typed models for the image-generation agent package."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field

from agents_party.agents.slack_runtime import SlackReferenceImage
from agents_party.domain import ThreadMessage


class ImageGenerationInvocation(BaseModel):
    """Request envelope specialized for image-generation execution.

    Attributes:
        prompt: Natural-language prompt describing the requested image.
        user_id: Optional Slack user identifier associated with the request.
        team_id: Optional Slack workspace identifier associated with the request.
        thread_messages: Normalized Slack thread transcript available to the agent.
        reference_images: Binary reference images downloaded from the Slack thread.
    """

    model_config = ConfigDict(extra="forbid")

    prompt: str
    user_id: str | None = None
    team_id: str | None = None
    thread_messages: list[ThreadMessage] = Field(default_factory=list)
    reference_images: list[SlackReferenceImage] = Field(default_factory=list)

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any]) -> Self:
        """Validate a generic mapping into an image-generation invocation.

        Args:
            data: Untrusted invocation payload supplied by callers.

        Returns:
            Validated image-generation invocation model.
        """
        return cls.model_validate(data)


__all__ = ["ImageGenerationInvocation"]
