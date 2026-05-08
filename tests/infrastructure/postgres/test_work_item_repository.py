"""Tests for the PostgreSQL-backed work-item repository."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from agents_party.domain.work_management import (
    AttentionProfile,
    CalendarProviderKind,
    ParticipantAttentionUpdate,
    ParticipantRelationDocument,
    ParticipantRole,
    VisibilityPolicyKind,
    WorkEventDocument,
    WorkEventType,
    WorkItemDocument,
    WorkItemCalendarLinkDocument,
    WorkItemCalendarSyncStatus,
    WorkItemMutation,
    WorkItemPatch,
    WorkItemPriority,
    WorkItemQuery,
    WorkItemQueryView,
    WorkItemStatus,
)
from agents_party.infrastructure.postgres import PostgresWorkItemRepository
from agents_party.infrastructure.postgres.models import ensure_schema


def make_engine():
    """Build a reusable in-memory engine for repository tests.

    Returns:
        SQLite engine configured to persist across multiple connections.
    """
    return create_engine(
        "sqlite+pysqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )


def build_seeded_engine():
    """Create an in-memory engine with the relational schema initialized.

    Returns:
        SQLite engine prepared with the repository schema for tests.
    """
    engine = make_engine()
    ensure_schema(engine)
    return engine


def make_item(
    *,
    work_item_id: str,
    visibility_kind: VisibilityPolicyKind = VisibilityPolicyKind.CONTEXT,
    source_channel_id: str = "C123",
    created_by_user_id: str = "U1",
) -> WorkItemDocument:
    """Build a representative work-item document for repository tests.

    Args:
        work_item_id: Work item identifier to assign.
        visibility_kind: Visibility policy to apply to the item.
        source_channel_id: Slack source channel id for the item.
        created_by_user_id: User id that created the item.

    Returns:
        Work-item document configured for repository tests.
    """
    return WorkItemDocument(
        work_item_id=work_item_id,
        team_id="T1",
        title=f"Task {work_item_id}",
        priority=WorkItemPriority.MEDIUM,
        visibility_kind=visibility_kind,
        source_channel_id=source_channel_id,
        created_by_user_id=created_by_user_id,
    )


def make_participant(
    *,
    work_item_id: str,
    user_id: str,
    role: ParticipantRole = ParticipantRole.FOLLOWER,
    attention_profile: AttentionProfile | None = None,
) -> ParticipantRelationDocument:
    """Build a representative participant relation for repository tests.

    Args:
        work_item_id: Work item identifier the participant belongs to.
        user_id: Participant user id.
        role: Participant role to assign.
        attention_profile: Optional explicit attention profile override.

    Returns:
        Participant relation document configured for repository tests.
    """
    resolved_attention = attention_profile or (
        AttentionProfile.FOCUS
        if role == ParticipantRole.PRIMARY_ASSIGNEE
        else AttentionProfile.TRACK
    )
    return ParticipantRelationDocument(
        work_item_id=work_item_id,
        user_id=user_id,
        role=role,
        attention_profile=resolved_attention,
    )


def make_event(
    *,
    event_id: str,
    work_item_id: str,
    event_type: WorkEventType = WorkEventType.WORK_ITEM_CREATED,
    actor_user_id: str = "U1",
    occurred_at: datetime | None = None,
) -> WorkEventDocument:
    """Build a representative work event for repository tests.

    Args:
        event_id: Event identifier to assign.
        work_item_id: Work item identifier the event belongs to.
        event_type: Event type to assign.
        actor_user_id: User id responsible for the event.
        occurred_at: Optional explicit occurrence timestamp.

    Returns:
        Work-event document configured for repository tests.
    """
    return WorkEventDocument(
        event_id=event_id,
        work_item_id=work_item_id,
        type=event_type,
        actor_user_id=actor_user_id,
        occurred_at=occurred_at or datetime(2026, 3, 22, tzinfo=UTC),
    )


def make_calendar_link(
    *,
    link_id: str = "L1",
    work_item_id: str = "W1",
    starts_at: datetime | None = None,
    sync_status: WorkItemCalendarSyncStatus = WorkItemCalendarSyncStatus.ACTIVE,
) -> WorkItemCalendarLinkDocument:
    """Build a representative calendar link for repository tests.

    Args:
        link_id: Local calendar-link identifier to assign.
        work_item_id: Work item identifier the link belongs to.
        starts_at: Optional event start timestamp.
        sync_status: Cached sync state for the linked event.

    Returns:
        Calendar link document configured for repository tests.
    """
    return WorkItemCalendarLinkDocument(
        link_id=link_id,
        team_id="T1",
        work_item_id=work_item_id,
        provider_kind=CalendarProviderKind.GOOGLE_CALENDAR,
        external_calendar_id="primary",
        external_event_id=f"event-{link_id}",
        event_title_snapshot="Planning meeting",
        starts_at=starts_at,
        ends_at=None if starts_at is None else datetime(2026, 3, 24, 10, tzinfo=UTC),
        sync_status=sync_status,
        last_synced_at=datetime(2026, 3, 22, tzinfo=UTC),
    )


def test_create_work_item_writes_source_of_truth_and_attention_index() -> None:
    """Verify creation writes the item, related documents, and attention index.

    Returns:
        None.
    """
    repository = PostgresWorkItemRepository(engine=build_seeded_engine())
    item = make_item(work_item_id="W1")
    participants = [make_participant(work_item_id="W1", user_id="U1")]
    events = [make_event(event_id="E1", work_item_id="W1")]

    aggregate = repository.create_work_item(item, participants, events)
    fetched = repository.get_work_item("W1", "T1", "U1", ["C123"])

    assert aggregate.item.work_item_id == "W1"
    assert fetched is not None
    assert fetched.viewer_relation is not None


def test_mutate_work_item_updates_cached_fields_and_attention() -> None:
    """Verify mutation updates persisted fields and attention index state.

    Returns:
        None.
    """
    repository = PostgresWorkItemRepository(engine=build_seeded_engine())
    repository.create_work_item(
        make_item(work_item_id="W1"),
        [make_participant(work_item_id="W1", user_id="U1")],
        [make_event(event_id="E1", work_item_id="W1")],
    )
    next_attention_at = datetime(2026, 3, 23, tzinfo=UTC)

    aggregate = repository.mutate_work_item(
        work_item_id="W1",
        team_id="T1",
        actor_user_id="U1",
        mutation=WorkItemMutation(
            item_patch=WorkItemPatch(status=WorkItemStatus.DONE),
            primary_assignee_user_id="U2",
            attention_updates=[
                ParticipantAttentionUpdate(
                    user_id="U1",
                    next_attention_at=next_attention_at,
                )
            ],
            events=[
                make_event(
                    event_id="E2",
                    work_item_id="W1",
                    event_type=WorkEventType.COMPLETED,
                )
            ],
        ),
    )

    assert aggregate.item.status == WorkItemStatus.DONE
    assert aggregate.item.primary_assignee_user_id == "U2"
    assert aggregate.viewer_relation is not None
    assert aggregate.viewer_relation.next_attention_at == next_attention_at


def test_link_calendar_event_persists_snapshot_without_changing_due_at() -> None:
    """Verify linking stores a calendar snapshot without implicit time changes.

    Returns:
        None.
    """
    repository = PostgresWorkItemRepository(engine=build_seeded_engine())
    repository.create_work_item(
        make_item(work_item_id="W1"),
        [make_participant(work_item_id="W1", user_id="U1")],
        [make_event(event_id="E1", work_item_id="W1")],
    )
    starts_at = datetime(2026, 3, 24, 9, tzinfo=UTC)

    aggregate = repository.link_calendar_event(
        work_item_id="W1",
        team_id="T1",
        calendar_link=make_calendar_link(starts_at=starts_at),
        actor_user_id="U1",
    )
    fetched = repository.get_work_item("W1", "T1", "U1", ["C123"])

    assert aggregate.item.due_at is None
    assert aggregate.calendar_links[0].starts_at == starts_at
    assert aggregate.recent_events[-1].type == WorkEventType.CALENDAR_EVENT_LINKED
    assert fetched is not None
    assert fetched.calendar_links[0].external_event_id == "event-L1"


def test_link_calendar_event_can_apply_event_start_explicitly() -> None:
    """Verify explicit flags copy event start to due and attention timestamps.

    Returns:
        None.
    """
    repository = PostgresWorkItemRepository(engine=build_seeded_engine())
    repository.create_work_item(
        make_item(work_item_id="W1"),
        [make_participant(work_item_id="W1", user_id="U1")],
        [make_event(event_id="E1", work_item_id="W1")],
    )
    starts_at = datetime(2026, 3, 24, 9, tzinfo=UTC)

    aggregate = repository.link_calendar_event(
        work_item_id="W1",
        team_id="T1",
        calendar_link=make_calendar_link(starts_at=starts_at),
        actor_user_id="U1",
        apply_starts_at_to_due_at=True,
        apply_starts_at_to_next_attention_at_for_user_id="U1",
    )

    assert aggregate.item.due_at == starts_at
    assert aggregate.viewer_relation is not None
    assert aggregate.viewer_relation.next_attention_at == starts_at
    assert {event.type for event in aggregate.recent_events} >= {
        WorkEventType.CALENDAR_EVENT_LINKED,
        WorkEventType.DUE_AT_CHANGED,
        WorkEventType.ATTENTION_SCHEDULED,
    }


def test_unlink_calendar_event_removes_snapshot_and_appends_event() -> None:
    """Verify unlinking removes the calendar link and records semantic history.

    Returns:
        None.
    """
    repository = PostgresWorkItemRepository(engine=build_seeded_engine())
    repository.create_work_item(
        make_item(work_item_id="W1"),
        [make_participant(work_item_id="W1", user_id="U1")],
        [make_event(event_id="E1", work_item_id="W1")],
    )
    repository.link_calendar_event(
        work_item_id="W1",
        team_id="T1",
        calendar_link=make_calendar_link(),
        actor_user_id="U1",
    )

    aggregate = repository.unlink_calendar_event(
        work_item_id="W1",
        team_id="T1",
        link_id="L1",
        actor_user_id="U1",
    )

    assert aggregate.calendar_links == []
    assert aggregate.recent_events[-1].type == WorkEventType.CALENDAR_EVENT_UNLINKED


def test_link_calendar_event_records_canceled_and_not_found_sync_statuses() -> None:
    """Verify sync-status snapshots survive for canceled and missing events.

    Returns:
        None.
    """
    repository = PostgresWorkItemRepository(engine=build_seeded_engine())
    repository.create_work_item(
        make_item(work_item_id="W1"),
        [make_participant(work_item_id="W1", user_id="U1")],
        [make_event(event_id="E1", work_item_id="W1")],
    )

    canceled = repository.link_calendar_event(
        work_item_id="W1",
        team_id="T1",
        calendar_link=make_calendar_link(
            link_id="L-canceled",
            sync_status=WorkItemCalendarSyncStatus.CANCELED,
        ),
        actor_user_id="U1",
    )
    missing = repository.link_calendar_event(
        work_item_id="W1",
        team_id="T1",
        calendar_link=make_calendar_link(
            link_id="L-missing",
            sync_status=WorkItemCalendarSyncStatus.NOT_FOUND,
        ),
        actor_user_id="U1",
    )

    assert {link.link_id: link.sync_status for link in missing.calendar_links} == {
        "L-canceled": WorkItemCalendarSyncStatus.CANCELED,
        "L-missing": WorkItemCalendarSyncStatus.NOT_FOUND,
    }
    assert any(
        event.type == WorkEventType.CALENDAR_EVENT_CANCELED
        for event in canceled.recent_events
    )


def test_list_work_items_respects_visibility_and_needs_attention_view() -> None:
    """Verify list queries honor visibility and needs-attention filtering.

    Returns:
        None.
    """
    repository = PostgresWorkItemRepository(engine=build_seeded_engine())
    repository.create_work_item(
        make_item(
            work_item_id="W-private", visibility_kind=VisibilityPolicyKind.PRIVATE
        ),
        [make_participant(work_item_id="W-private", user_id="U1")],
        [make_event(event_id="E1", work_item_id="W-private")],
    )
    repository.create_work_item(
        make_item(
            work_item_id="W-context", visibility_kind=VisibilityPolicyKind.CONTEXT
        ),
        [make_participant(work_item_id="W-context", user_id="U1")],
        [make_event(event_id="E2", work_item_id="W-context")],
    )

    channel_items = repository.list_work_items(
        WorkItemQuery(
            team_id="T1",
            viewer_user_id="U9",
            viewer_channel_id="C123",
            viewer_context_channel_ids=["C123"],
            view=WorkItemQueryView.CHANNEL_OPEN,
        )
    )
    attention_items = repository.list_work_items(
        WorkItemQuery(
            team_id="T1",
            viewer_user_id="U1",
            viewer_channel_id="C123",
            viewer_context_channel_ids=["C123"],
            view=WorkItemQueryView.NEEDS_ATTENTION,
            needs_attention_only=True,
        )
    )

    assert [aggregate.item.work_item_id for aggregate in channel_items] == ["W-context"]
    assert {aggregate.item.work_item_id for aggregate in attention_items} == {
        "W-private",
        "W-context",
    }
