from __future__ import annotations

from typing import Protocol

from agents_party.domain.work_management import (
    ParticipantRelationDocument,
    WorkItemCalendarLinkDocument,
    WorkEventDocument,
    WorkItemAggregate,
    WorkItemDocument,
    WorkItemMutation,
    WorkItemQuery,
)


class WorkItemRepository(Protocol):
    def create_work_item(
        self,
        item: WorkItemDocument,
        participants: list[ParticipantRelationDocument],
        initial_events: list[WorkEventDocument],
    ) -> WorkItemAggregate:
        """Persist a new work item with its initial participants and events.

        Args:
            item: Work item document to create.
            participants: Participant relations to store alongside the item.
            initial_events: Initial event history to append during creation.

        Returns:
            Hydrated aggregate representing the created work item.
        """
        ...

    def get_work_item(
        self,
        work_item_id: str,
        team_id: str,
        viewer_user_id: str,
        viewer_context_channel_ids: list[str],
    ) -> WorkItemAggregate | None:
        """Load a work item aggregate if the viewer is allowed to see it.

        Args:
            work_item_id: Work item identifier to fetch.
            team_id: Workspace id owning the work item.
            viewer_user_id: User requesting access to the work item.
            viewer_context_channel_ids: Channels that define the viewer's context visibility.

        Returns:
            Visible work-item aggregate, or `None` when it is missing or inaccessible.
        """
        ...

    def list_work_items(self, query: WorkItemQuery) -> list[WorkItemAggregate]:
        """List work-item aggregates matching a query for a viewer.

        Args:
            query: Query parameters controlling filtering, visibility, and sorting.

        Returns:
            Matching visible work-item aggregates.
        """
        ...

    def mutate_work_item(
        self,
        work_item_id: str,
        team_id: str,
        mutation: WorkItemMutation,
        actor_user_id: str,
    ) -> WorkItemAggregate:
        """Apply a mutation to an existing work item and return the new aggregate.

        Args:
            work_item_id: Work item identifier to mutate.
            team_id: Workspace id owning the work item.
            mutation: Requested item, participant, attention, and event changes.
            actor_user_id: User id responsible for the mutation.

        Returns:
            Hydrated aggregate after the mutation is applied.
        """
        ...

    def link_calendar_event(
        self,
        work_item_id: str,
        team_id: str,
        calendar_link: WorkItemCalendarLinkDocument,
        actor_user_id: str,
        apply_starts_at_to_due_at: bool = False,
        apply_starts_at_to_next_attention_at_for_user_id: str | None = None,
    ) -> WorkItemAggregate:
        """Link an external calendar event snapshot to an existing work item.

        Args:
            work_item_id: Work item identifier to mutate.
            team_id: Workspace id owning the work item.
            calendar_link: External calendar event link snapshot to persist.
            actor_user_id: User id responsible for the link operation.
            apply_starts_at_to_due_at: Whether to explicitly copy the event start to
                the work-item due date.
            apply_starts_at_to_next_attention_at_for_user_id: Optional user id whose
                next attention time should explicitly use the event start.

        Returns:
            Hydrated aggregate after the link and any explicit time changes.
        """
        ...

    def unlink_calendar_event(
        self,
        work_item_id: str,
        team_id: str,
        link_id: str,
        actor_user_id: str,
    ) -> WorkItemAggregate:
        """Remove an external calendar event link from an existing work item.

        Args:
            work_item_id: Work item identifier to mutate.
            team_id: Workspace id owning the work item.
            link_id: Local calendar link identifier to remove.
            actor_user_id: User id responsible for the unlink operation.

        Returns:
            Hydrated aggregate after the link is removed.
        """
        ...


__all__ = ["WorkItemRepository"]
