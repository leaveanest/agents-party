from __future__ import annotations

from datetime import datetime

from pydantic_ai import RunContext

from agents_party.agents.tools.common import (
    get_work_item_or_none,
    make_event,
    missing_item_result,
    now,
)
from agents_party.agents.work_manager import (
    WorkManagerAction,
    WorkManagerDeps,
    WorkManagerResult,
    WorkManagerWorkItem,
    build_updated_message,
)
from agents_party.domain import (
    AttentionProfile,
    ParticipantAttentionUpdate,
    WorkEventDocument,
    WorkEventType,
    WorkItemMutation,
)


def update_participants(
    ctx: RunContext[WorkManagerDeps],
    work_item_id: str,
    primary_assignee_user_id: str | None = None,
    clear_primary_assignee: bool = False,
    collaborator_user_ids_to_add: list[str] | None = None,
    collaborator_user_ids_to_remove: list[str] | None = None,
    follower_user_ids_to_add: list[str] | None = None,
    follower_user_ids_to_remove: list[str] | None = None,
) -> WorkManagerResult:
    """Update assignees, collaborators, and followers for a work item.

    Args:
        ctx: Tool execution context carrying work-manager dependencies.
        work_item_id: Work item identifier to mutate.
        primary_assignee_user_id: Optional new primary assignee user id.
        clear_primary_assignee: Whether to remove the current primary assignee.
        collaborator_user_ids_to_add: Collaborator user ids to add.
        collaborator_user_ids_to_remove: Collaborator user ids to remove.
        follower_user_ids_to_add: Follower user ids to add.
        follower_user_ids_to_remove: Follower user ids to remove.

    Returns:
        Work-manager result describing the updated work item.
    """

    current = get_work_item_or_none(ctx, work_item_id)
    if current is None:
        return missing_item_result()

    current_time = now(ctx)
    request_context = ctx.deps.request_context
    events: list[WorkEventDocument] = []
    if primary_assignee_user_id is not None or clear_primary_assignee:
        events.append(
            make_event(
                work_item_id=work_item_id,
                event_type=WorkEventType.PRIMARY_ASSIGNEE_CHANGED,
                actor_user_id=request_context.user_id,
                affected_user_ids=(
                    [primary_assignee_user_id] if primary_assignee_user_id else []
                ),
                payload={
                    "from_primary_assignee_user_id": current.item.primary_assignee_user_id,
                    "to_primary_assignee_user_id": primary_assignee_user_id,
                },
                occurred_at=current_time,
            )
        )
    for collaborator_user_id in collaborator_user_ids_to_add or []:
        events.append(
            make_event(
                work_item_id=work_item_id,
                event_type=WorkEventType.COLLABORATOR_ADDED,
                actor_user_id=request_context.user_id,
                affected_user_ids=[collaborator_user_id],
                occurred_at=current_time,
            )
        )
    for collaborator_user_id in collaborator_user_ids_to_remove or []:
        events.append(
            make_event(
                work_item_id=work_item_id,
                event_type=WorkEventType.COLLABORATOR_REMOVED,
                actor_user_id=request_context.user_id,
                affected_user_ids=[collaborator_user_id],
                occurred_at=current_time,
            )
        )
    for follower_user_id in follower_user_ids_to_add or []:
        events.append(
            make_event(
                work_item_id=work_item_id,
                event_type=WorkEventType.FOLLOWER_ADDED,
                actor_user_id=request_context.user_id,
                affected_user_ids=[follower_user_id],
                occurred_at=current_time,
            )
        )
    for follower_user_id in follower_user_ids_to_remove or []:
        events.append(
            make_event(
                work_item_id=work_item_id,
                event_type=WorkEventType.FOLLOWER_REMOVED,
                actor_user_id=request_context.user_id,
                affected_user_ids=[follower_user_id],
                occurred_at=current_time,
            )
        )

    mutation = WorkItemMutation(
        primary_assignee_user_id=primary_assignee_user_id,
        clear_primary_assignee=clear_primary_assignee,
        collaborator_user_ids_to_add=collaborator_user_ids_to_add or [],
        collaborator_user_ids_to_remove=collaborator_user_ids_to_remove or [],
        follower_user_ids_to_add=follower_user_ids_to_add or [],
        follower_user_ids_to_remove=follower_user_ids_to_remove or [],
        events=events,
    )
    aggregate = ctx.deps.work_item_repository.mutate_work_item(
        work_item_id=work_item_id,
        team_id=request_context.team_id,
        mutation=mutation,
        actor_user_id=request_context.user_id,
    )
    summary = WorkManagerWorkItem.from_aggregate(aggregate, now=current_time)
    return WorkManagerResult(
        action=WorkManagerAction.UPDATED,
        message=build_updated_message(
            summary,
            timezone_name=ctx.deps.default_timezone,
        ),
        work_items=[summary],
    )


def set_my_attention(
    ctx: RunContext[WorkManagerDeps],
    work_item_id: str,
    attention_profile: AttentionProfile | None = None,
    next_attention_at: datetime | None = None,
    muted_until: datetime | None = None,
    clear_next_attention_at: bool = False,
    clear_muted_until: bool = False,
) -> WorkManagerResult:
    """Update the current viewer's attention settings for a work item.

    Args:
        ctx: Tool execution context carrying work-manager dependencies.
        work_item_id: Work item identifier to mutate.
        attention_profile: Optional new attention profile for the viewer.
        next_attention_at: Optional next scheduled attention time.
        muted_until: Optional mute-until timestamp.
        clear_next_attention_at: Whether to clear the stored next attention time.
        clear_muted_until: Whether to clear the stored mute-until time.

    Returns:
        Work-manager result describing the updated attention settings.
    """

    current = get_work_item_or_none(ctx, work_item_id)
    if current is None:
        return missing_item_result()

    current_time = now(ctx)
    request_context = ctx.deps.request_context
    mutation = WorkItemMutation(
        attention_updates=[
            ParticipantAttentionUpdate(
                user_id=request_context.user_id,
                attention_profile=attention_profile,
                next_attention_at=next_attention_at,
                muted_until=muted_until,
                clear_next_attention_at=clear_next_attention_at,
                clear_muted_until=clear_muted_until,
            )
        ],
        events=[
            make_event(
                work_item_id=work_item_id,
                event_type=WorkEventType.ATTENTION_SCHEDULED,
                actor_user_id=request_context.user_id,
                affected_user_ids=[request_context.user_id],
                payload={
                    "attention_profile": attention_profile.value
                    if attention_profile
                    else None,
                    "next_attention_at": next_attention_at.isoformat()
                    if next_attention_at
                    else None,
                    "muted_until": muted_until.isoformat() if muted_until else None,
                },
                occurred_at=current_time,
            )
        ],
    )
    aggregate = ctx.deps.work_item_repository.mutate_work_item(
        work_item_id=work_item_id,
        team_id=request_context.team_id,
        mutation=mutation,
        actor_user_id=request_context.user_id,
    )
    summary = WorkManagerWorkItem.from_aggregate(aggregate, now=current_time)
    return WorkManagerResult(
        action=WorkManagerAction.UPDATED,
        message=build_updated_message(
            summary,
            timezone_name=ctx.deps.default_timezone,
            action_word="Updated attention for",
        ),
        work_items=[summary],
    )


__all__ = [
    "set_my_attention",
    "update_participants",
]
