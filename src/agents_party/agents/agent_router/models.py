"""Typed models and dependency containers for the agent-router package."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

from pydantic_ai import BinaryContent, BinaryImage
from pydantic import BaseModel, ConfigDict, Field

from agents_party.agents.slack_runtime import SlackAgentInvocation
from agents_party.repositories import WorkItemRepository


class AgentRouterAction(StrEnum):
    """High-level outcomes produced by the agent router."""

    RESPONDED = "responded"
    ORCHESTRATED = "orchestrated"
    CLARIFICATION_NEEDED = "clarification_needed"


class AgentRouterResult(BaseModel):
    """Structured response returned by the agent-router runtime."""

    model_config = ConfigDict(extra="forbid")

    action: AgentRouterAction
    message: str = ""
    selected_specialist_ids: list[str] = Field(default_factory=list)
    follow_up_question: str | None = None
    generated_image: BinaryImage | None = None
    generated_video: BinaryContent | None = None


class SpecialistOutcome(BaseModel):
    """Normalized specialist result captured during router orchestration."""

    model_config = ConfigDict(extra="forbid")

    specialist_id: str
    message: str = ""
    follow_up_question: str | None = None
    generated_image: BinaryImage | None = None
    generated_video: BinaryContent | None = None


@dataclass(slots=True)
class AgentRouterDeps:
    """Dependency bundle used while the agent router runs.

    Attributes:
        invocation: Normalized Slack request passed to the router.
        work_item_repository: Optional repository override used by the work-manager
            specialist.
        specialist_outcomes: Ordered normalized outcomes produced by invoked
            specialists during the current run.
    """

    invocation: SlackAgentInvocation
    work_item_repository: WorkItemRepository | None = None
    specialist_outcomes: list[SpecialistOutcome] = field(default_factory=list)


__all__ = [
    "AgentRouterAction",
    "AgentRouterDeps",
    "AgentRouterResult",
]
