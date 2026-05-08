"""Work-management domain models and derived state helpers."""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Iterable

from pydantic import Field, model_validator

from agents_party.domain.slack_documents import DocumentModel


class WorkItemStatus(StrEnum):
    CAPTURED = "captured"
    PLANNED = "planned"
    IN_PROGRESS = "in_progress"
    BLOCKED = "blocked"
    DONE = "done"
    CANCELED = "canceled"
    ARCHIVED = "archived"


class WorkItemPriority(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    URGENT = "urgent"


class CalendarProviderKind(StrEnum):
    """External calendar providers that can be linked to work items."""

    GOOGLE_CALENDAR = "google_calendar"


class WorkItemCalendarSyncStatus(StrEnum):
    """Cached synchronization state for a linked external calendar event."""

    ACTIVE = "active"
    CANCELED = "canceled"
    NOT_FOUND = "not_found"


class VisibilityPolicyKind(StrEnum):
    PRIVATE = "private"
    CONTEXT = "context"
    NAMED = "named"


class ParticipantRole(StrEnum):
    PRIMARY_ASSIGNEE = "primary_assignee"
    COLLABORATOR = "collaborator"
    FOLLOWER = "follower"


class AttentionProfile(StrEnum):
    FOCUS = "focus"
    TRACK = "track"
    MUTE = "mute"


class WorkEventType(StrEnum):
    WORK_ITEM_CREATED = "work_item_created"
    STATUS_CHANGED = "status_changed"
    PRIMARY_ASSIGNEE_CHANGED = "primary_assignee_changed"
    COLLABORATOR_ADDED = "collaborator_added"
    COLLABORATOR_REMOVED = "collaborator_removed"
    FOLLOWER_ADDED = "follower_added"
    FOLLOWER_REMOVED = "follower_removed"
    DUE_AT_CHANGED = "due_at_changed"
    BLOCKED = "blocked"
    UNBLOCKED = "unblocked"
    ATTENTION_SCHEDULED = "attention_scheduled"
    MENTIONED = "mentioned"
    COMPLETED = "completed"
    REOPENED = "reopened"
    CALENDAR_EVENT_LINKED = "calendar_event_linked"
    CALENDAR_EVENT_UNLINKED = "calendar_event_unlinked"
    CALENDAR_EVENT_RESCHEDULED = "calendar_event_rescheduled"
    CALENDAR_EVENT_CANCELED = "calendar_event_canceled"


class WorkItemQueryView(StrEnum):
    INBOX = "inbox"
    MY_TASKS = "my_tasks"
    NEEDS_ATTENTION = "needs_attention"
    CHANNEL_OPEN = "channel_open"
    DONE_RECENTLY = "done_recently"


DIRECTED_ATTENTION_EVENT_TYPES = frozenset(
    {
        WorkEventType.MENTIONED,
        WorkEventType.PRIMARY_ASSIGNEE_CHANGED,
        WorkEventType.COLLABORATOR_ADDED,
        WorkEventType.FOLLOWER_ADDED,
    }
)

RELEVANT_ATTENTION_EVENT_TYPES = frozenset(
    {
        WorkEventType.WORK_ITEM_CREATED,
        WorkEventType.STATUS_CHANGED,
        WorkEventType.DUE_AT_CHANGED,
        WorkEventType.BLOCKED,
        WorkEventType.UNBLOCKED,
        WorkEventType.ATTENTION_SCHEDULED,
        WorkEventType.COMPLETED,
        WorkEventType.REOPENED,
        WorkEventType.CALENDAR_EVENT_LINKED,
        WorkEventType.CALENDAR_EVENT_UNLINKED,
        WorkEventType.CALENDAR_EVENT_RESCHEDULED,
        WorkEventType.CALENDAR_EVENT_CANCELED,
    }
    | DIRECTED_ATTENTION_EVENT_TYPES
)


def utc_now() -> datetime:
    """Return the current UTC timestamp for work-management defaults.

    Returns:
        Timezone-aware UTC timestamp.
    """
    return datetime.now(tz=UTC)


class WorkItemDocument(DocumentModel):
    work_item_id: str
    team_id: str
    title: str
    description: str | None = None
    status: WorkItemStatus = WorkItemStatus.CAPTURED
    priority: WorkItemPriority = WorkItemPriority.MEDIUM
    due_at: datetime | None = None
    visibility_kind: VisibilityPolicyKind
    named_visibility_user_ids: list[str] = Field(default_factory=list)
    primary_assignee_user_id: str | None = None
    source_channel_id: str
    source_thread_ts: str | None = None
    source_message_ts: str | None = None
    home_channel_id: str | None = None
    audience_channel_id: str | None = None
    tags: list[str] = Field(default_factory=list)
    blocked_by_work_item_ids: list[str] = Field(default_factory=list)
    project_ref: str | None = None
    created_by_user_id: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    completed_at: datetime | None = None

    @model_validator(mode="after")
    def sync_audience_channel_id(self) -> WorkItemDocument:
        """Synchronize the derived audience channel after validation.

        Returns:
            The validated work-item document with `audience_channel_id` updated.
        """
        self.audience_channel_id = derive_audience_channel_id(
            visibility_kind=self.visibility_kind,
            home_channel_id=self.home_channel_id,
            source_channel_id=self.source_channel_id,
        )
        return self


class ParticipantRelationDocument(DocumentModel):
    work_item_id: str
    user_id: str
    role: ParticipantRole
    attention_profile: AttentionProfile
    next_attention_at: datetime | None = None
    muted_until: datetime | None = None
    last_seen_event_id: str | None = None
    joined_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    @model_validator(mode="after")
    def validate_primary_assignee_attention(self) -> ParticipantRelationDocument:
        """Reject invalid primary-assignee attention combinations.

        Returns:
            The validated participant relation document.

        Raises:
            ValueError: If a primary assignee is assigned the `mute` attention profile.
        """
        if (
            self.role == ParticipantRole.PRIMARY_ASSIGNEE
            and self.attention_profile == AttentionProfile.MUTE
        ):
            raise ValueError(
                "primary_assignee relations cannot use attention_profile=mute"
            )
        return self


class WorkItemAttentionIndexDocument(DocumentModel):
    team_id: str
    user_id: str
    work_item_id: str
    status: WorkItemStatus
    visibility_kind: VisibilityPolicyKind
    audience_channel_id: str | None = None
    home_channel_id: str | None = None
    primary_assignee_user_id: str | None = None
    attention_profile: AttentionProfile
    next_attention_at: datetime | None = None
    needs_attention_now: bool = False
    attention_reason: str | None = None
    last_seen_event_id: str | None = None
    updated_at: datetime = Field(default_factory=utc_now)


class WorkEventDocument(DocumentModel):
    event_id: str
    work_item_id: str
    type: WorkEventType
    actor_user_id: str
    affected_user_ids: list[str] = Field(default_factory=list)
    payload: dict[str, Any] = Field(default_factory=dict)
    occurred_at: datetime = Field(default_factory=utc_now)


class WorkItemCalendarLinkDocument(DocumentModel):
    """Cached external calendar event linked to a work item.

    Attributes:
        link_id: Stable local identifier for this work item to calendar event link.
        team_id: Slack workspace id that owns the work item.
        work_item_id: Work item identifier the external event is linked to.
        provider_kind: Calendar provider backing the external event.
        external_calendar_id: Provider-side calendar identifier.
        external_event_id: Provider-side event identifier.
        event_title_snapshot: Cached event title or summary for display and search.
        starts_at: Cached event start timestamp when available.
        ends_at: Cached event end timestamp when available.
        is_all_day: Whether the linked event is an all-day event.
        response_status: Cached viewer response status when known.
        sync_status: Cached synchronization state for the external event.
        last_synced_at: Timestamp of the most recent external calendar sync.
        created_at: Timestamp when the local link was first created.
        updated_at: Timestamp when the local link cache was last updated.
    """

    link_id: str
    team_id: str
    work_item_id: str
    provider_kind: CalendarProviderKind
    external_calendar_id: str
    external_event_id: str
    event_title_snapshot: str | None = None
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    is_all_day: bool = False
    response_status: str | None = None
    sync_status: WorkItemCalendarSyncStatus = WorkItemCalendarSyncStatus.ACTIVE
    last_synced_at: datetime | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class WorkItemAggregate(DocumentModel):
    """Hydrated work item with participants, events, and external links."""

    item: WorkItemDocument
    participants: list[ParticipantRelationDocument] = Field(default_factory=list)
    recent_events: list[WorkEventDocument] = Field(default_factory=list)
    calendar_links: list[WorkItemCalendarLinkDocument] = Field(default_factory=list)
    viewer_relation: ParticipantRelationDocument | None = None


class WorkItemPatch(DocumentModel):
    title: str | None = None
    description: str | None = None
    status: WorkItemStatus | None = None
    priority: WorkItemPriority | None = None
    due_at: datetime | None = None
    visibility_kind: VisibilityPolicyKind | None = None
    named_visibility_user_ids: list[str] | None = None
    home_channel_id: str | None = None
    tags: list[str] | None = None
    project_ref: str | None = None
    clear_fields: list[str] = Field(default_factory=list)


class ParticipantAttentionUpdate(DocumentModel):
    user_id: str
    attention_profile: AttentionProfile | None = None
    next_attention_at: datetime | None = None
    muted_until: datetime | None = None
    clear_next_attention_at: bool = False
    clear_muted_until: bool = False
    create_if_missing: bool = True
    role_if_missing: ParticipantRole = ParticipantRole.FOLLOWER


class WorkItemMutation(DocumentModel):
    item_patch: WorkItemPatch = Field(default_factory=WorkItemPatch)
    primary_assignee_user_id: str | None = None
    clear_primary_assignee: bool = False
    collaborator_user_ids_to_add: list[str] = Field(default_factory=list)
    collaborator_user_ids_to_remove: list[str] = Field(default_factory=list)
    follower_user_ids_to_add: list[str] = Field(default_factory=list)
    follower_user_ids_to_remove: list[str] = Field(default_factory=list)
    attention_updates: list[ParticipantAttentionUpdate] = Field(default_factory=list)
    events: list[WorkEventDocument] = Field(default_factory=list)


class WorkItemQuery(DocumentModel):
    team_id: str
    viewer_user_id: str | None = None
    viewer_channel_id: str | None = None
    viewer_context_channel_ids: list[str] = Field(default_factory=list)
    view: WorkItemQueryView = WorkItemQueryView.INBOX
    status_in: list[WorkItemStatus] = Field(default_factory=list)
    visibility_kind: VisibilityPolicyKind | None = None
    primary_assignee_user_id: str | None = None
    participant_user_id: str | None = None
    audience_channel_id: str | None = None
    text_query: str | None = None
    due_before: datetime | None = None
    needs_attention_only: bool = False
    include_completed: bool = False
    limit: int = Field(default=20, ge=1)


def default_attention_profile_for_role(role: ParticipantRole) -> AttentionProfile:
    """Return the default attention profile for a participant role.

    Args:
        role: Participant role to map to a default attention profile.

    Returns:
        Default attention profile for the supplied role.
    """
    if role == ParticipantRole.PRIMARY_ASSIGNEE:
        return AttentionProfile.FOCUS
    return AttentionProfile.TRACK


def derive_audience_channel_id(
    *,
    visibility_kind: VisibilityPolicyKind,
    home_channel_id: str | None,
    source_channel_id: str,
) -> str | None:
    """Derive the channel used to expose a work item in context views.

    Args:
        visibility_kind: Visibility policy applied to the work item.
        home_channel_id: Optional home channel chosen for the work item.
        source_channel_id: Channel where the work item was originally captured.

    Returns:
        Channel id visible to context-based viewers, or `None` for non-context items.
    """
    if visibility_kind != VisibilityPolicyKind.CONTEXT:
        return None
    return home_channel_id or source_channel_id


def is_directed_attention_event_type(event_type: WorkEventType) -> bool:
    """Return whether an event directly targets a participant's attention.

    Args:
        event_type: Event type to classify.

    Returns:
        `True` when the event is considered a direct attention trigger.
    """
    return event_type in DIRECTED_ATTENTION_EVENT_TYPES


def is_relevant_attention_event_type(event_type: WorkEventType) -> bool:
    """Return whether an event contributes to general attention calculations.

    Args:
        event_type: Event type to classify.

    Returns:
        `True` when the event should affect attention evaluation.
    """
    return event_type in RELEVANT_ATTENTION_EVENT_TYPES


def derive_attention_state(
    *,
    attention_profile: AttentionProfile,
    now: datetime,
    next_attention_at: datetime | None = None,
    muted_until: datetime | None = None,
    unseen_event_types: Iterable[WorkEventType] = (),
) -> tuple[bool, str | None]:
    """Derive whether a participant currently needs attention and why.

    Args:
        attention_profile: Participant's configured attention mode.
        now: Current time used to compare scheduled attention windows.
        next_attention_at: Optional next scheduled attention check time.
        muted_until: Optional mute-until time that suppresses reminders.
        unseen_event_types: Event types unseen by the participant in chronological order.

    Returns:
        Tuple of `needs_attention_now` and a machine-readable attention reason.
    """
    event_types = tuple(unseen_event_types)
    if any(is_directed_attention_event_type(event_type) for event_type in event_types):
        return True, "directed_event"
    if attention_profile == AttentionProfile.MUTE:
        return False, "mute"
    if attention_profile == AttentionProfile.FOCUS:
        return True, "focus"
    if muted_until is not None and muted_until > now:
        return False, "muted_until"
    if next_attention_at is not None and next_attention_at <= now:
        return True, "next_attention_at"
    if any(is_relevant_attention_event_type(event_type) for event_type in event_types):
        return True, "relevant_event"
    return False, None


def derive_needs_attention_now(
    *,
    attention_profile: AttentionProfile,
    now: datetime,
    next_attention_at: datetime | None = None,
    muted_until: datetime | None = None,
    unseen_event_types: Iterable[WorkEventType] = (),
) -> bool:
    """Return only the boolean attention state for a participant.

    Args:
        attention_profile: Participant's configured attention mode.
        now: Current time used to compare scheduled attention windows.
        next_attention_at: Optional next scheduled attention check time.
        muted_until: Optional mute-until time that suppresses reminders.
        unseen_event_types: Event types unseen by the participant in chronological order.

    Returns:
        `True` when the participant should currently see the work item as needing attention.
    """
    needs_attention_now, _ = derive_attention_state(
        attention_profile=attention_profile,
        now=now,
        next_attention_at=next_attention_at,
        muted_until=muted_until,
        unseen_event_types=unseen_event_types,
    )
    return needs_attention_now


def derive_attention_reason(
    *,
    attention_profile: AttentionProfile,
    now: datetime,
    next_attention_at: datetime | None = None,
    muted_until: datetime | None = None,
    unseen_event_types: Iterable[WorkEventType] = (),
) -> str | None:
    """Return only the reason explaining the current attention state.

    Args:
        attention_profile: Participant's configured attention mode.
        now: Current time used to compare scheduled attention windows.
        next_attention_at: Optional next scheduled attention check time.
        muted_until: Optional mute-until time that suppresses reminders.
        unseen_event_types: Event types unseen by the participant in chronological order.

    Returns:
        Machine-readable attention reason, or `None` when no reason applies.
    """
    _, attention_reason = derive_attention_state(
        attention_profile=attention_profile,
        now=now,
        next_attention_at=next_attention_at,
        muted_until=muted_until,
        unseen_event_types=unseen_event_types,
    )
    return attention_reason


__all__ = [
    "AttentionProfile",
    "DIRECTED_ATTENTION_EVENT_TYPES",
    "ParticipantAttentionUpdate",
    "ParticipantRelationDocument",
    "ParticipantRole",
    "RELEVANT_ATTENTION_EVENT_TYPES",
    "VisibilityPolicyKind",
    "WorkEventDocument",
    "WorkEventType",
    "WorkItemAggregate",
    "WorkItemAttentionIndexDocument",
    "WorkItemDocument",
    "WorkItemMutation",
    "WorkItemPatch",
    "WorkItemPriority",
    "WorkItemQuery",
    "WorkItemQueryView",
    "WorkItemStatus",
    "default_attention_profile_for_role",
    "derive_audience_channel_id",
    "derive_attention_reason",
    "derive_attention_state",
    "derive_needs_attention_now",
    "is_directed_attention_event_type",
    "is_relevant_attention_event_type",
    "utc_now",
]
