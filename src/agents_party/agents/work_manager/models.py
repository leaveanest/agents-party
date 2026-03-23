"""Typed models and dependency containers for the work-manager agent."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from agents_party.agents.request_preparation import RequestPreparer
from agents_party.agents.slack_runtime import SlackAgentInvocation
from agents_party.domain import (
    AttentionProfile,
    ThreadMessage,
    WorkItemAggregate,
    WorkItemPriority,
    WorkItemStatus,
    derive_attention_reason,
    derive_needs_attention_now,
)
from agents_party.repositories import WorkItemRepository


class WorkManagerInvocation(SlackAgentInvocation):
    """Slack request envelope specialized for the work-manager runtime."""

    def to_request_context(self) -> WorkManagerRequestContext:
        """Project the invocation into repository-oriented request context.

        Returns:
            Request context carrying workspace, viewer, and Slack source metadata.
        """
        return WorkManagerRequestContext(
            team_id=self.team_id,
            user_id=self.user_id,
            channel_id=self.channel_id,
            viewer_context_channel_ids=self.viewer_context_channel_ids
            or [self.channel_id],
            thread_ts=self.thread_ts,
            message_ts=self.message_ts,
        )


class WorkManagerPreparedRequest(BaseModel):
    """Prepared work-manager input before the executor agent runs.

    Attributes:
        original_text: Original user request text from Slack.
        execution_text: Normalized execution request text for the executor agent.
        planning_notes: Optional notes from an earlier preparation or research stage.
        thread_messages: Normalized Slack transcript supplied by the routing layer.
    """

    model_config = ConfigDict(extra="forbid")

    original_text: str
    execution_text: str
    planning_notes: list[str] = Field(default_factory=list)
    thread_messages: list[ThreadMessage] = Field(default_factory=list)


@dataclass(slots=True)
class WorkManagerRequestContext:
    """Repository-oriented request metadata for a work-manager execution."""

    team_id: str
    user_id: str
    channel_id: str
    viewer_context_channel_ids: list[str]
    thread_ts: str | None = None
    message_ts: str | None = None


@dataclass(slots=True)
class WorkManagerDeps:
    """Dependency bundle passed to work-manager tools during execution."""

    request_context: WorkManagerRequestContext
    work_item_repository: WorkItemRepository
    now: Callable[[], datetime]
    default_timezone: str
    max_list_size: int = 20


class WorkManagerAction(StrEnum):
    """High-level actions the work-manager agent can report back to callers."""

    CREATED = "created"
    LISTED = "listed"
    UPDATED = "updated"
    COMPLETED = "completed"
    CLARIFICATION_NEEDED = "clarification_needed"
    NO_OP = "no_op"


type WorkManagerRequestPreparer = RequestPreparer[
    WorkManagerInvocation,
    WorkManagerPreparedRequest,
]


def _unseen_event_types(aggregate: WorkItemAggregate) -> list[Any]:
    """Return event types the viewer has not seen in an aggregate.

    Args:
        aggregate: Work-item aggregate including recent events and viewer relation.

    Returns:
        Event types that occurred after the viewer's last seen event.
    """
    viewer_relation = aggregate.viewer_relation
    if viewer_relation is None:
        return []
    if viewer_relation.last_seen_event_id is None:
        return [event.type for event in aggregate.recent_events]

    unseen = False
    unseen_event_types: list[Any] = []
    for event in aggregate.recent_events:
        if unseen:
            unseen_event_types.append(event.type)
            continue
        if event.event_id == viewer_relation.last_seen_event_id:
            unseen = True

    if not unseen:
        return [event.type for event in aggregate.recent_events]
    return unseen_event_types


class WorkManagerWorkItem(BaseModel):
    """Work-item view model returned by the work-manager agent."""

    model_config = ConfigDict(extra="forbid")

    work_item_id: str
    title: str
    status: WorkItemStatus
    priority: WorkItemPriority
    due_at: datetime | None = None
    primary_assignee_user_id: str | None = None
    audience_channel_id: str | None = None
    attention_profile: AttentionProfile | None = None
    next_attention_at_for_me: datetime | None = None
    needs_attention_now: bool = False
    attention_reason: str | None = None

    @classmethod
    def from_aggregate(
        cls,
        aggregate: WorkItemAggregate,
        *,
        now: datetime,
    ) -> WorkManagerWorkItem:
        """Build a work-manager view model from a repository aggregate.

        Args:
            aggregate: Repository aggregate to summarize for the work-manager agent.
            now: Current time used to evaluate attention state.

        Returns:
            Work-manager summary item for the aggregate.
        """
        viewer_relation = aggregate.viewer_relation
        if viewer_relation is None:
            return cls(
                work_item_id=aggregate.item.work_item_id,
                title=aggregate.item.title,
                status=aggregate.item.status,
                priority=aggregate.item.priority,
                due_at=aggregate.item.due_at,
                primary_assignee_user_id=aggregate.item.primary_assignee_user_id,
                audience_channel_id=aggregate.item.audience_channel_id,
            )

        unseen_event_types = _unseen_event_types(aggregate)
        return cls(
            work_item_id=aggregate.item.work_item_id,
            title=aggregate.item.title,
            status=aggregate.item.status,
            priority=aggregate.item.priority,
            due_at=aggregate.item.due_at,
            primary_assignee_user_id=aggregate.item.primary_assignee_user_id,
            audience_channel_id=aggregate.item.audience_channel_id,
            attention_profile=viewer_relation.attention_profile,
            next_attention_at_for_me=viewer_relation.next_attention_at,
            needs_attention_now=derive_needs_attention_now(
                attention_profile=viewer_relation.attention_profile,
                now=now,
                next_attention_at=viewer_relation.next_attention_at,
                muted_until=viewer_relation.muted_until,
                unseen_event_types=unseen_event_types,
            ),
            attention_reason=derive_attention_reason(
                attention_profile=viewer_relation.attention_profile,
                now=now,
                next_attention_at=viewer_relation.next_attention_at,
                muted_until=viewer_relation.muted_until,
                unseen_event_types=unseen_event_types,
            ),
        )


class WorkManagerTimeContext(BaseModel):
    """Current local time context used to interpret relative scheduling language.

    Attributes:
        now: Current timestamp converted into the request timezone.
        timezone_name: Resolved IANA timezone name used for interpretation.
        current_date: Local calendar date in `YYYY-MM-DD` format.
        current_time: Local wall-clock time in `HH:MM` format.
        current_day_of_week: Local weekday name such as `Monday`.
    """

    model_config = ConfigDict(extra="forbid")

    now: datetime
    timezone_name: str
    current_date: str
    current_time: str
    current_day_of_week: str


class WorkManagerResult(BaseModel):
    """Structured response returned by the work-manager runtime."""

    model_config = ConfigDict(extra="forbid")

    action: WorkManagerAction
    message: str
    work_items: list[WorkManagerWorkItem] = Field(default_factory=list)
    needs_confirmation: bool = False
    follow_up_question: str | None = None


__all__ = [
    "WorkManagerAction",
    "WorkManagerDeps",
    "WorkManagerInvocation",
    "WorkManagerPreparedRequest",
    "WorkManagerRequestContext",
    "WorkManagerRequestPreparer",
    "WorkManagerResult",
    "WorkManagerTimeContext",
    "WorkManagerWorkItem",
]
