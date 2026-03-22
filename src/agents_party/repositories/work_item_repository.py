from __future__ import annotations

from typing import Protocol

from agents_party.domain.work_management import (
    ParticipantRelationDocument,
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


__all__ = ["WorkItemRepository"]
