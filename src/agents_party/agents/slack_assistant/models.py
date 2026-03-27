"""Typed models and dependency containers for the Slack assistant package."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from pydantic_ai import BinaryContent, BinaryImage
from pydantic import BaseModel, ConfigDict

from agents_party.agents.slack_runtime import SlackAgentInvocation
from agents_party.repositories import WorkItemRepository


class SlackAssistantAction(StrEnum):
    """High-level outcomes produced by the Slack assistant."""

    RESPONDED = "responded"
    DELEGATED = "delegated"
    CLARIFICATION_NEEDED = "clarification_needed"


class SlackAssistantResult(BaseModel):
    """Structured response returned by the Slack assistant runtime."""

    model_config = ConfigDict(extra="forbid")

    action: SlackAssistantAction
    message: str = ""
    delegated_agent_id: str | None = None
    follow_up_question: str | None = None
    generated_image: BinaryImage | None = None
    generated_video: BinaryContent | None = None


@dataclass(slots=True)
class SlackAssistantDeps:
    """Dependency bundle used while the Slack assistant runs.

    Attributes:
        invocation: Normalized Slack request passed to the assistant.
        work_item_repository: Optional repository override used by work-manager.
        last_delegated_agent_id: Specialist agent id used by the latest tool call.
        last_delegated_message: Slack-ready response returned by the latest tool call.
        last_follow_up_question: Optional clarification returned by the latest tool call.
        last_generated_image: Optional binary image returned by the latest tool call.
        last_generated_video: Optional binary video returned by the latest tool call.
    """

    invocation: SlackAgentInvocation
    work_item_repository: WorkItemRepository | None = None
    last_delegated_agent_id: str | None = None
    last_delegated_message: str | None = None
    last_follow_up_question: str | None = None
    last_generated_image: BinaryImage | None = None
    last_generated_video: BinaryContent | None = None


__all__ = [
    "SlackAssistantAction",
    "SlackAssistantDeps",
    "SlackAssistantResult",
]
