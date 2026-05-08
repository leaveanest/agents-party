from datetime import UTC, datetime, timedelta

import pytest

from agents_party.domain.work_management import (
    AttentionProfile,
    CalendarProviderKind,
    ParticipantRelationDocument,
    ParticipantRole,
    VisibilityPolicyKind,
    WorkItemCalendarLinkDocument,
    WorkItemCalendarSyncStatus,
    WorkEventType,
    WorkItemDocument,
    derive_attention_reason,
    derive_audience_channel_id,
)


def test_derive_audience_channel_id_uses_home_channel_for_context_visibility() -> None:
    """Verify context visibility prefers the home channel and skips private items.

    Returns:
        None.
    """
    assert (
        derive_audience_channel_id(
            visibility_kind=VisibilityPolicyKind.CONTEXT,
            home_channel_id="C999",
            source_channel_id="C123",
        )
        == "C999"
    )
    assert (
        derive_audience_channel_id(
            visibility_kind=VisibilityPolicyKind.PRIVATE,
            home_channel_id="C999",
            source_channel_id="C123",
        )
        is None
    )


def test_work_item_document_derives_audience_channel_id() -> None:
    """Verify work-item validation derives the audience channel id.

    Returns:
        None.
    """
    document = WorkItemDocument(
        work_item_id="W1",
        team_id="T1",
        title="Follow up",
        visibility_kind=VisibilityPolicyKind.CONTEXT,
        source_channel_id="C123",
        home_channel_id="C999",
        created_by_user_id="U1",
    )

    assert document.audience_channel_id == "C999"


def test_primary_assignee_cannot_use_mute_attention() -> None:
    """Verify primary assignees cannot use the mute attention profile.

    Returns:
        None.
    """
    with pytest.raises(ValueError):
        ParticipantRelationDocument(
            work_item_id="W1",
            user_id="U1",
            role=ParticipantRole.PRIMARY_ASSIGNEE,
            attention_profile=AttentionProfile.MUTE,
        )


def test_directed_events_override_mute_for_attention_reason() -> None:
    """Verify directed events still surface attention while muted.

    Returns:
        None.
    """
    now = datetime(2026, 3, 22, tzinfo=UTC)

    reason = derive_attention_reason(
        attention_profile=AttentionProfile.MUTE,
        now=now,
        muted_until=now + timedelta(days=1),
        unseen_event_types=[WorkEventType.MENTIONED],
    )

    assert reason == "directed_event"


def test_calendar_link_document_keeps_sdk_free_snapshot() -> None:
    """Verify work-item calendar links store provider-neutral snapshots.

    Returns:
        None.
    """
    starts_at = datetime(2026, 3, 24, 9, tzinfo=UTC)

    link = WorkItemCalendarLinkDocument(
        link_id="L1",
        team_id="T1",
        work_item_id="W1",
        provider_kind=CalendarProviderKind.GOOGLE_CALENDAR,
        external_calendar_id="primary",
        external_event_id="event-1",
        event_title_snapshot="Planning meeting",
        starts_at=starts_at,
        sync_status=WorkItemCalendarSyncStatus.NOT_FOUND,
    )

    assert link.provider_kind == CalendarProviderKind.GOOGLE_CALENDAR
    assert link.starts_at == starts_at
    assert link.sync_status == WorkItemCalendarSyncStatus.NOT_FOUND
    assert WorkEventType.CALENDAR_EVENT_LINKED.value == "calendar_event_linked"
