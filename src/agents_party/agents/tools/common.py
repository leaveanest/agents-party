from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import datetime
from typing import Any
from uuid import uuid4

from pydantic_ai import RunContext

from agents_party.agents.work_manager import (
    WorkManagerAction,
    WorkManagerDeps,
    WorkManagerResult,
    WorkManagerTimeContext,
    WorkManagerWorkItem,
    _timezone_or_utc,
)
from agents_party.domain import (
    ParticipantRelationDocument,
    ParticipantRole,
    VisibilityPolicyKind,
    WorkEventDocument,
    WorkEventType,
    WorkItemAggregate,
    WorkItemStatus,
    default_attention_profile_for_role,
)


def now(ctx: RunContext[WorkManagerDeps]) -> datetime:
    """Return the current time using the dependency-provided clock.

    Args:
        ctx: Tool execution context carrying work-manager dependencies.

    Returns:
        Current timestamp from the configured clock.
    """
    return ctx.deps.now()


def get_time_context(ctx: RunContext[WorkManagerDeps]) -> WorkManagerTimeContext:
    """Return localized time context for relative scheduling expressions.

    Args:
        ctx: Tool execution context carrying work-manager dependencies.

    Returns:
        Localized timestamp details that help the model resolve relative dates.
    """
    timezone = _timezone_or_utc(ctx.deps.default_timezone)
    localized_now = now(ctx).astimezone(timezone)
    return WorkManagerTimeContext(
        now=localized_now,
        timezone_name=getattr(timezone, "key", str(timezone)),
        current_date=localized_now.strftime("%Y-%m-%d"),
        current_time=localized_now.strftime("%H:%M"),
        current_day_of_week=localized_now.strftime("%A"),
    )


def summaries(
    aggregates: Sequence[WorkItemAggregate],
    *,
    current_time: datetime,
) -> list[WorkManagerWorkItem]:
    """Convert repository aggregates into work-manager summary items.

    Args:
        aggregates: Aggregates to summarize for Slack responses.
        current_time: Current time used to evaluate attention state.

    Returns:
        Work-manager summary objects for each aggregate.
    """
    return [
        WorkManagerWorkItem.from_aggregate(aggregate, now=current_time)
        for aggregate in aggregates
    ]


def missing_item_result() -> WorkManagerResult:
    """Build the standard result for a missing or inaccessible work item.

    Returns:
        Work-manager result requesting clarification about the target item.
    """
    return WorkManagerResult(
        action=WorkManagerAction.NO_OP,
        message="I could not find that task.",
        needs_confirmation=True,
        follow_up_question="Which task do you mean?",
    )


def make_event(
    *,
    work_item_id: str,
    event_type: WorkEventType,
    actor_user_id: str,
    affected_user_ids: Iterable[str] = (),
    payload: dict[str, Any] | None = None,
    occurred_at: datetime,
) -> WorkEventDocument:
    """Create a work-event document with a generated event id.

    Args:
        work_item_id: Work item the event belongs to.
        event_type: Event type to record.
        actor_user_id: User id responsible for the event.
        affected_user_ids: User ids directly affected by the event.
        payload: Optional structured event payload.
        occurred_at: Timestamp when the event occurred.

    Returns:
        Newly constructed work-event document.
    """
    return WorkEventDocument(
        event_id=uuid4().hex,
        work_item_id=work_item_id,
        type=event_type,
        actor_user_id=actor_user_id,
        affected_user_ids=list(affected_user_ids),
        payload=payload or {},
        occurred_at=occurred_at,
    )


def generate_work_item_id() -> str:
    """Generate a new opaque work-item identifier.

    Returns:
        Hex-encoded unique work-item id.
    """
    return uuid4().hex


def default_visibility_kind(channel_id: str) -> VisibilityPolicyKind:
    """Choose the default visibility policy for a Slack channel.

    Args:
        channel_id: Slack channel id where the work item was requested.

    Returns:
        Private visibility for DMs, otherwise context visibility.
    """
    if channel_id.startswith("D"):
        return VisibilityPolicyKind.PRIVATE
    return VisibilityPolicyKind.CONTEXT


def get_work_item_or_none(
    ctx: RunContext[WorkManagerDeps],
    work_item_id: str,
) -> WorkItemAggregate | None:
    """Load a work item visible to the current request context.

    Args:
        ctx: Tool execution context carrying work-manager dependencies.
        work_item_id: Work item identifier to fetch.

    Returns:
        Visible work-item aggregate, or `None` when missing or inaccessible.
    """
    request_context = ctx.deps.request_context
    return ctx.deps.work_item_repository.get_work_item(
        work_item_id=work_item_id,
        team_id=request_context.team_id,
        viewer_user_id=request_context.user_id,
        viewer_context_channel_ids=request_context.viewer_context_channel_ids,
    )


def build_participants(
    *,
    work_item_id: str,
    creator_user_id: str,
    primary_assignee_user_id: str | None,
    collaborator_user_ids: Sequence[str],
    follower_user_ids: Sequence[str],
    next_attention_at_for_creator: datetime | None,
    current_time: datetime,
) -> list[ParticipantRelationDocument]:
    """Build the initial participant list for a newly captured work item.

    Args:
        work_item_id: Work item identifier being created.
        creator_user_id: User who created the work item.
        primary_assignee_user_id: Optional primary assignee user id.
        collaborator_user_ids: Collaborator user ids to include.
        follower_user_ids: Follower user ids to include.
        next_attention_at_for_creator: Optional next attention time for the creator.
        current_time: Timestamp used for participant creation fields.

    Returns:
        Deduplicated participant relation documents for the new work item.
    """
    participants: dict[str, ParticipantRelationDocument] = {}

    if primary_assignee_user_id:
        participants[primary_assignee_user_id] = ParticipantRelationDocument(
            work_item_id=work_item_id,
            user_id=primary_assignee_user_id,
            role=ParticipantRole.PRIMARY_ASSIGNEE,
            attention_profile=default_attention_profile_for_role(
                ParticipantRole.PRIMARY_ASSIGNEE
            ),
            next_attention_at=(
                next_attention_at_for_creator
                if primary_assignee_user_id == creator_user_id
                else None
            ),
            joined_at=current_time,
            updated_at=current_time,
        )

    for collaborator_user_id in collaborator_user_ids:
        participants[collaborator_user_id] = ParticipantRelationDocument(
            work_item_id=work_item_id,
            user_id=collaborator_user_id,
            role=ParticipantRole.COLLABORATOR,
            attention_profile=default_attention_profile_for_role(
                ParticipantRole.COLLABORATOR
            ),
            next_attention_at=(
                next_attention_at_for_creator
                if collaborator_user_id == creator_user_id
                else None
            ),
            joined_at=current_time,
            updated_at=current_time,
        )

    for follower_user_id in follower_user_ids:
        if follower_user_id in participants:
            continue
        participants[follower_user_id] = ParticipantRelationDocument(
            work_item_id=work_item_id,
            user_id=follower_user_id,
            role=ParticipantRole.FOLLOWER,
            attention_profile=default_attention_profile_for_role(
                ParticipantRole.FOLLOWER
            ),
            next_attention_at=(
                next_attention_at_for_creator
                if follower_user_id == creator_user_id
                else None
            ),
            joined_at=current_time,
            updated_at=current_time,
        )

    if creator_user_id not in participants:
        participants[creator_user_id] = ParticipantRelationDocument(
            work_item_id=work_item_id,
            user_id=creator_user_id,
            role=ParticipantRole.FOLLOWER,
            attention_profile=default_attention_profile_for_role(
                ParticipantRole.FOLLOWER
            ),
            next_attention_at=next_attention_at_for_creator,
            joined_at=current_time,
            updated_at=current_time,
        )

    return list(participants.values())


def status_event_type(
    current_status: WorkItemStatus,
    next_status: WorkItemStatus,
) -> WorkEventType:
    """Choose the event type that corresponds to a status transition.

    Args:
        current_status: Current persisted work-item status.
        next_status: New status requested by the caller.

    Returns:
        Event type describing the status transition.
    """
    if next_status == WorkItemStatus.DONE:
        return WorkEventType.COMPLETED
    if current_status == WorkItemStatus.DONE and next_status != WorkItemStatus.DONE:
        return WorkEventType.REOPENED
    if (
        next_status == WorkItemStatus.BLOCKED
        and current_status != WorkItemStatus.BLOCKED
    ):
        return WorkEventType.BLOCKED
    if (
        current_status == WorkItemStatus.BLOCKED
        and next_status != WorkItemStatus.BLOCKED
    ):
        return WorkEventType.UNBLOCKED
    return WorkEventType.STATUS_CHANGED


__all__ = [
    "build_participants",
    "default_visibility_kind",
    "generate_work_item_id",
    "get_work_item_or_none",
    "get_time_context",
    "make_event",
    "missing_item_result",
    "now",
    "status_event_type",
    "summaries",
]
