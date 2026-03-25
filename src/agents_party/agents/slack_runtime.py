"""Shared Slack invocation models used by agent runtimes."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field

from agents_party.domain import ThreadMessage


class SlackAgentInvocation(BaseModel):
    """Common Slack request envelope used by executable agents.

    Attributes:
        team_id: Slack workspace identifier owning the request.
        user_id: Slack user identifier for the requester.
        channel_id: Slack channel identifier where the request was made.
        viewer_context_channel_ids: Channels used for repository visibility lookups.
        text: User request text after Slack-specific normalization.
        thread_ts: Optional thread timestamp for thread-aware routing and replies.
        message_ts: Optional originating message timestamp.
        thread_messages: Normalized Slack thread transcript used for execution.
    """

    model_config = ConfigDict(extra="forbid")

    team_id: str
    user_id: str
    channel_id: str
    viewer_context_channel_ids: list[str] = Field(default_factory=list)
    text: str
    thread_ts: str | None = None
    message_ts: str | None = None
    thread_messages: list[ThreadMessage] = Field(default_factory=list)

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any]) -> Self:
        """Validate a generic mapping into a typed Slack agent invocation.

        Args:
            data: Untrusted invocation payload supplied by callers.

        Returns:
            Validated Slack agent invocation model.
        """
        return cls.model_validate(data)


__all__ = ["SlackAgentInvocation"]
