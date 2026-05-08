from __future__ import annotations

from datetime import datetime
import hashlib

from pydantic_ai import RunContext

from agents_party.agents.tools.common import (
    build_participants,
    default_visibility_kind,
    generate_work_item_id,
    get_work_item_or_none,
    make_event,
    missing_item_result,
    now,
    status_event_type,
)
from agents_party.agents.work_manager import (
    WorkManagerAction,
    WorkManagerDeps,
    WorkManagerResult,
    WorkManagerWorkItem,
    build_created_message,
    build_updated_message,
)
from agents_party.domain import (
    CalendarProviderKind,
    VisibilityPolicyKind,
    WorkEventDocument,
    WorkEventType,
    WorkItemCalendarLinkDocument,
    WorkItemCalendarSyncStatus,
    WorkItemDocument,
    WorkItemMutation,
    WorkItemPatch,
    WorkItemPriority,
    WorkItemStatus,
)


def capture_work_item(
    ctx: RunContext[WorkManagerDeps],
    title: str,
    description: str | None = None,
    visibility_kind: VisibilityPolicyKind | None = None,
    named_visibility_user_ids: list[str] | None = None,
    primary_assignee_user_id: str | None = None,
    collaborator_user_ids: list[str] | None = None,
    follower_user_ids: list[str] | None = None,
    due_at: datetime | None = None,
    next_attention_at_for_me: datetime | None = None,
    priority: WorkItemPriority = WorkItemPriority.MEDIUM,
    tags: list[str] | None = None,
    home_channel_id: str | None = None,
) -> WorkManagerResult:
    """Create a new work item from the current Slack context.

    Args:
        ctx: Tool execution context carrying work-manager dependencies.
        title: Short actionable title for the work item.
        description: Optional longer description for the work item.
        visibility_kind: Optional visibility override for the work item.
        named_visibility_user_ids: Optional named viewers for `named` visibility.
        primary_assignee_user_id: Optional primary assignee user id.
        collaborator_user_ids: Optional collaborator user ids.
        follower_user_ids: Optional follower user ids.
        due_at: Optional due date for the work item.
        next_attention_at_for_me: Optional next attention time for the creator.
        priority: Priority assigned to the new work item.
        tags: Optional tag list.
        home_channel_id: Optional home channel used for context visibility.

    Returns:
        Work-manager result describing the created work item.
    """

    current_time = now(ctx)
    request_context = ctx.deps.request_context
    work_item_id = generate_work_item_id()
    resolved_visibility_kind = visibility_kind or default_visibility_kind(
        request_context.channel_id
    )
    participants = build_participants(
        work_item_id=work_item_id,
        creator_user_id=request_context.user_id,
        primary_assignee_user_id=primary_assignee_user_id,
        collaborator_user_ids=collaborator_user_ids or [],
        follower_user_ids=follower_user_ids or [],
        next_attention_at_for_creator=next_attention_at_for_me,
        current_time=current_time,
    )
    item = WorkItemDocument(
        work_item_id=work_item_id,
        team_id=request_context.team_id,
        title=title.strip(),
        description=description,
        priority=priority,
        due_at=due_at,
        visibility_kind=resolved_visibility_kind,
        named_visibility_user_ids=named_visibility_user_ids or [],
        primary_assignee_user_id=primary_assignee_user_id,
        source_channel_id=request_context.channel_id,
        source_thread_ts=request_context.thread_ts,
        source_message_ts=request_context.message_ts,
        home_channel_id=home_channel_id,
        tags=tags or [],
        created_by_user_id=request_context.user_id,
        created_at=current_time,
        updated_at=current_time,
    )
    events = [
        make_event(
            work_item_id=work_item_id,
            event_type=WorkEventType.WORK_ITEM_CREATED,
            actor_user_id=request_context.user_id,
            payload={"title": item.title},
            occurred_at=current_time,
        )
    ]
    if primary_assignee_user_id:
        events.append(
            make_event(
                work_item_id=work_item_id,
                event_type=WorkEventType.PRIMARY_ASSIGNEE_CHANGED,
                actor_user_id=request_context.user_id,
                affected_user_ids=[primary_assignee_user_id],
                payload={"primary_assignee_user_id": primary_assignee_user_id},
                occurred_at=current_time,
            )
        )
    for collaborator_user_id in collaborator_user_ids or []:
        events.append(
            make_event(
                work_item_id=work_item_id,
                event_type=WorkEventType.COLLABORATOR_ADDED,
                actor_user_id=request_context.user_id,
                affected_user_ids=[collaborator_user_id],
                occurred_at=current_time,
            )
        )
    for follower_user_id in follower_user_ids or []:
        events.append(
            make_event(
                work_item_id=work_item_id,
                event_type=WorkEventType.FOLLOWER_ADDED,
                actor_user_id=request_context.user_id,
                affected_user_ids=[follower_user_id],
                occurred_at=current_time,
            )
        )
    if next_attention_at_for_me is not None:
        events.append(
            make_event(
                work_item_id=work_item_id,
                event_type=WorkEventType.ATTENTION_SCHEDULED,
                actor_user_id=request_context.user_id,
                affected_user_ids=[request_context.user_id],
                payload={"next_attention_at": next_attention_at_for_me.isoformat()},
                occurred_at=current_time,
            )
        )

    aggregate = ctx.deps.work_item_repository.create_work_item(
        item=item,
        participants=participants,
        initial_events=events,
    )
    summary = WorkManagerWorkItem.from_aggregate(aggregate, now=current_time)
    return WorkManagerResult(
        action=WorkManagerAction.CREATED,
        message=build_created_message(
            summary,
            timezone_name=ctx.deps.default_timezone,
            source_is_thread=request_context.thread_ts is not None,
        ),
        work_items=[summary],
    )


def update_work_item_status(
    ctx: RunContext[WorkManagerDeps],
    work_item_id: str,
    status: WorkItemStatus,
) -> WorkManagerResult:
    """Update the status of a specific work item.

    Args:
        ctx: Tool execution context carrying work-manager dependencies.
        work_item_id: Work item identifier to mutate.
        status: New work-item status to persist.

    Returns:
        Work-manager result describing the updated work item.
    """

    current = get_work_item_or_none(ctx, work_item_id)
    if current is None:
        return missing_item_result()

    current_time = now(ctx)
    request_context = ctx.deps.request_context
    event_type = status_event_type(current.item.status, status)
    mutation = WorkItemMutation(
        item_patch=WorkItemPatch(status=status),
        events=[
            make_event(
                work_item_id=work_item_id,
                event_type=event_type,
                actor_user_id=request_context.user_id,
                occurred_at=current_time,
                payload={
                    "from_status": current.item.status.value,
                    "to_status": status.value,
                },
            )
        ],
    )
    aggregate = ctx.deps.work_item_repository.mutate_work_item(
        work_item_id=work_item_id,
        team_id=request_context.team_id,
        mutation=mutation,
        actor_user_id=request_context.user_id,
    )
    action = (
        WorkManagerAction.COMPLETED
        if status == WorkItemStatus.DONE
        else WorkManagerAction.UPDATED
    )
    action_word = "Completed" if action == WorkManagerAction.COMPLETED else "Updated"
    summary = WorkManagerWorkItem.from_aggregate(aggregate, now=current_time)
    return WorkManagerResult(
        action=action,
        message=build_updated_message(
            summary,
            timezone_name=ctx.deps.default_timezone,
            action_word=action_word,
        ),
        work_items=[summary],
    )


def update_work_item_fields(
    ctx: RunContext[WorkManagerDeps],
    work_item_id: str,
    title: str | None = None,
    description: str | None = None,
    due_at: datetime | None = None,
    priority: WorkItemPriority | None = None,
    visibility_kind: VisibilityPolicyKind | None = None,
    named_visibility_user_ids: list[str] | None = None,
    tags: list[str] | None = None,
    home_channel_id: str | None = None,
    clear_fields: list[str] | None = None,
) -> WorkManagerResult:
    """Update editable work-item fields without changing participants.

    Args:
        ctx: Tool execution context carrying work-manager dependencies.
        work_item_id: Work item identifier to mutate.
        title: Optional new title.
        description: Optional new description.
        due_at: Optional new due date.
        priority: Optional new priority.
        visibility_kind: Optional new visibility policy.
        named_visibility_user_ids: Optional new named-visibility user ids.
        tags: Optional replacement tags.
        home_channel_id: Optional new home channel id.
        clear_fields: Optional item fields to clear back to empty values.

    Returns:
        Work-manager result describing the updated work item.
    """

    current = get_work_item_or_none(ctx, work_item_id)
    if current is None:
        return missing_item_result()

    clear_field_set = set(clear_fields or [])
    current_time = now(ctx)
    request_context = ctx.deps.request_context
    events: list[WorkEventDocument] = []
    due_at_changed = "due_at" in clear_field_set or (
        due_at is not None and due_at != current.item.due_at
    )
    if due_at_changed:
        events.append(
            make_event(
                work_item_id=work_item_id,
                event_type=WorkEventType.DUE_AT_CHANGED,
                actor_user_id=request_context.user_id,
                occurred_at=current_time,
                payload={
                    "from_due_at": current.item.due_at.isoformat()
                    if current.item.due_at
                    else None,
                    "to_due_at": due_at.isoformat() if due_at else None,
                },
            )
        )

    mutation = WorkItemMutation(
        item_patch=WorkItemPatch(
            title=title,
            description=description,
            due_at=due_at,
            priority=priority,
            visibility_kind=visibility_kind,
            named_visibility_user_ids=named_visibility_user_ids,
            home_channel_id=home_channel_id,
            tags=tags,
            clear_fields=list(clear_field_set),
        ),
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


def complete_work_item(
    ctx: RunContext[WorkManagerDeps],
    work_item_id: str,
) -> WorkManagerResult:
    """Mark a work item as done.

    Args:
        ctx: Tool execution context carrying work-manager dependencies.
        work_item_id: Work item identifier to mark complete.

    Returns:
        Work-manager result describing the completed work item.
    """

    return update_work_item_status(
        ctx,
        work_item_id=work_item_id,
        status=WorkItemStatus.DONE,
    )


def link_google_calendar_event(
    ctx: RunContext[WorkManagerDeps],
    work_item_id: str,
    google_calendar_id: str,
    google_event_id: str,
    event_title_snapshot: str | None = None,
    starts_at: datetime | None = None,
    ends_at: datetime | None = None,
    is_all_day: bool = False,
    response_status: str | None = None,
    sync_status: WorkItemCalendarSyncStatus = WorkItemCalendarSyncStatus.ACTIVE,
    last_synced_at: datetime | None = None,
    apply_starts_at_to_due_at: bool = False,
    apply_starts_at_to_next_attention_at_for_me: bool = False,
) -> WorkManagerResult:
    """Link a Google Calendar event snapshot to a visible work item.

    Args:
        ctx: Tool execution context carrying work-manager dependencies.
        work_item_id: Work item identifier to link.
        google_calendar_id: Google Calendar calendar identifier.
        google_event_id: Google Calendar event identifier.
        event_title_snapshot: Optional cached event title.
        starts_at: Optional cached event start timestamp.
        ends_at: Optional cached event end timestamp.
        is_all_day: Whether the linked event is an all-day event.
        response_status: Optional cached viewer response status.
        sync_status: Cached sync state for the Google Calendar event.
        last_synced_at: Optional timestamp when the snapshot was fetched.
        apply_starts_at_to_due_at: Whether to explicitly copy the event start to
            the work-item due date.
        apply_starts_at_to_next_attention_at_for_me: Whether to explicitly copy the
            event start to the caller's next attention time.

    Returns:
        Work-manager result describing the updated work item.
    """

    current = get_work_item_or_none(ctx, work_item_id)
    if current is None:
        return missing_item_result()
    if (
        apply_starts_at_to_due_at or apply_starts_at_to_next_attention_at_for_me
    ) and starts_at is None:
        return WorkManagerResult(
            action=WorkManagerAction.CLARIFICATION_NEEDED,
            message=(
                "I need the calendar event start time before I can apply it to the task."
            ),
            work_items=[WorkManagerWorkItem.from_aggregate(current, now=now(ctx))],
            needs_confirmation=True,
            follow_up_question="What start time should I apply?",
        )

    current_time = now(ctx)
    request_context = ctx.deps.request_context
    calendar_link = WorkItemCalendarLinkDocument(
        link_id=_stable_google_calendar_link_id(
            google_calendar_id=google_calendar_id,
            google_event_id=google_event_id,
        ),
        team_id=request_context.team_id,
        work_item_id=work_item_id,
        provider_kind=CalendarProviderKind.GOOGLE_CALENDAR,
        external_calendar_id=google_calendar_id,
        external_event_id=google_event_id,
        event_title_snapshot=event_title_snapshot,
        starts_at=starts_at,
        ends_at=ends_at,
        is_all_day=is_all_day,
        response_status=response_status,
        sync_status=sync_status,
        last_synced_at=last_synced_at,
        created_at=current_time,
        updated_at=current_time,
    )
    aggregate = ctx.deps.work_item_repository.link_calendar_event(
        work_item_id=work_item_id,
        team_id=request_context.team_id,
        calendar_link=calendar_link,
        actor_user_id=request_context.user_id,
        apply_starts_at_to_due_at=apply_starts_at_to_due_at,
        apply_starts_at_to_next_attention_at_for_user_id=(
            request_context.user_id
            if apply_starts_at_to_next_attention_at_for_me
            else None
        ),
    )
    summary = WorkManagerWorkItem.from_aggregate(aggregate, now=current_time)
    return WorkManagerResult(
        action=WorkManagerAction.UPDATED,
        message=build_updated_message(
            summary,
            timezone_name=ctx.deps.default_timezone,
            action_word="Linked calendar event to",
        ),
        work_items=[summary],
    )


def _stable_google_calendar_link_id(
    *,
    google_calendar_id: str,
    google_event_id: str,
) -> str:
    """Build a deterministic local link id for one Google Calendar event.

    Args:
        google_calendar_id: Google Calendar calendar identifier.
        google_event_id: Google Calendar event identifier.

    Returns:
        Stable local link id that lets repeated links update the same snapshot.
    """
    digest = hashlib.sha256(
        f"{google_calendar_id}\0{google_event_id}".encode("utf-8")
    ).hexdigest()
    return f"google-{digest[:32]}"


def unlink_google_calendar_event(
    ctx: RunContext[WorkManagerDeps],
    work_item_id: str,
    link_id: str,
) -> WorkManagerResult:
    """Remove a Google Calendar event link from a visible work item.

    Args:
        ctx: Tool execution context carrying work-manager dependencies.
        work_item_id: Work item identifier to unlink.
        link_id: Local calendar link id to remove.

    Returns:
        Work-manager result describing the updated work item.
    """

    current = get_work_item_or_none(ctx, work_item_id)
    if current is None:
        return missing_item_result()

    current_time = now(ctx)
    request_context = ctx.deps.request_context
    try:
        aggregate = ctx.deps.work_item_repository.unlink_calendar_event(
            work_item_id=work_item_id,
            team_id=request_context.team_id,
            link_id=link_id,
            actor_user_id=request_context.user_id,
        )
    except KeyError:
        return missing_item_result()

    summary = WorkManagerWorkItem.from_aggregate(aggregate, now=current_time)
    return WorkManagerResult(
        action=WorkManagerAction.UPDATED,
        message=build_updated_message(
            summary,
            timezone_name=ctx.deps.default_timezone,
            action_word="Unlinked calendar event from",
        ),
        work_items=[summary],
    )


__all__ = [
    "capture_work_item",
    "complete_work_item",
    "link_google_calendar_event",
    "unlink_google_calendar_event",
    "update_work_item_fields",
    "update_work_item_status",
]
