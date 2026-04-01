"""PostgreSQL-backed repository for work-item persistence and query views."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import datetime
from typing import Any, cast

from pydantic import BaseModel
from sqlalchemy import Engine, asc, desc
from sqlmodel import Session, col, select

from agents_party.domain import (
    AttentionProfile,
    ParticipantAttentionUpdate,
    ParticipantRelationDocument,
    ParticipantRole,
    VisibilityPolicyKind,
    WorkEventDocument,
    WorkItemAggregate,
    WorkItemAttentionIndexDocument,
    WorkItemDocument,
    WorkItemMutation,
    WorkItemPatch,
    WorkItemQuery,
    WorkItemQueryView,
    WorkItemStatus,
    default_attention_profile_for_role,
    derive_attention_reason,
    derive_needs_attention_now,
    utc_now,
)
from agents_party.infrastructure.postgres.connection import build_database_engine
from agents_party.infrastructure.postgres.models import (
    WorkItemAttentionIndexRecord,
    WorkItemEventRecord,
    WorkItemParticipantRecord,
    WorkItemRecord,
)


COMPLETED_STATUSES = {
    WorkItemStatus.DONE,
    WorkItemStatus.CANCELED,
    WorkItemStatus.ARCHIVED,
}


class PostgresWorkItemRepository:
    """PostgreSQL-backed implementation of the work-item repository boundary."""

    def __init__(
        self,
        *,
        database_url: str | None = None,
        engine: Engine | None = None,
    ) -> None:
        """Create a repository with either an injected engine or a database URL.

        Args:
            database_url: SQLAlchemy-compatible database URL.
            engine: Optional injected SQLAlchemy engine for tests or overrides.

        Raises:
            ValueError: If neither `database_url` nor `engine` is provided.

        Notes:
            The target schema must already exist. Apply Alembic migrations before
            constructing this repository in non-test environments.
        """
        if engine is None and database_url is None:
            raise ValueError("database_url or engine is required.")
        self._engine = engine or build_database_engine(cast(str, database_url))

    def create_work_item(
        self,
        item: WorkItemDocument,
        participants: list[ParticipantRelationDocument],
        initial_events: list[WorkEventDocument],
    ) -> WorkItemAggregate:
        """Persist a new work item with participants, events, and attention indexes.

        Args:
            item: Work item document to create.
            participants: Participant relations to store with the item.
            initial_events: Initial event history to write alongside the item.

        Returns:
            Hydrated aggregate for the created work item.
        """
        participants_by_user = {
            participant.user_id: participant for participant in participants
        }
        events = self._sort_events(initial_events)

        with Session(self._engine) as session:
            session.add(self._work_item_record(item))
            self._replace_participants(
                session=session,
                team_id=item.team_id,
                work_item_id=item.work_item_id,
                participants=participants_by_user.values(),
            )
            self._replace_events(
                session=session,
                team_id=item.team_id,
                work_item_id=item.work_item_id,
                events=events,
            )
            self._replace_attention_index(
                session=session,
                item=item,
                participants=participants_by_user,
                events=events,
            )
            session.commit()

        return self._hydrate_aggregate(
            item=item,
            participants=participants_by_user,
            events=events,
            viewer_user_id=item.created_by_user_id,
        )

    def get_work_item(
        self,
        work_item_id: str,
        team_id: str,
        viewer_user_id: str,
        viewer_context_channel_ids: list[str],
    ) -> WorkItemAggregate | None:
        """Load a visible work-item aggregate for a viewer.

        Args:
            work_item_id: Work item identifier to fetch.
            team_id: Workspace id owning the work item.
            viewer_user_id: User requesting access to the work item.
            viewer_context_channel_ids: Channels that define context visibility.

        Returns:
            Visible work-item aggregate, or `None` when missing or inaccessible.
        """
        item = self._read_item(team_id, work_item_id)
        if item is None:
            return None
        participants = self._read_participants(team_id, work_item_id)
        if not self._can_view(
            item=item,
            participants=participants,
            viewer_user_id=viewer_user_id,
            viewer_context_channel_ids=viewer_context_channel_ids,
        ):
            return None
        events = self._read_events(team_id, work_item_id)
        return self._hydrate_aggregate(
            item=item,
            participants=participants,
            events=events,
            viewer_user_id=viewer_user_id,
        )

    def list_work_items(self, query: WorkItemQuery) -> list[WorkItemAggregate]:
        """List visible work-item aggregates matching a query.

        Args:
            query: Query parameters controlling visibility, filtering, and sorting.

        Returns:
            Matching visible work-item aggregates, capped by the query limit.
        """
        if (
            query.needs_attention_only
            or query.view == WorkItemQueryView.NEEDS_ATTENTION
        ):
            work_item_ids = self._list_attention_index_work_item_ids(query)
        else:
            statement = select(WorkItemRecord.work_item_id).where(
                WorkItemRecord.team_id == query.team_id
            )
            with Session(self._engine) as session:
                work_item_ids = list(session.exec(statement).all())

        aggregates: list[WorkItemAggregate] = []
        for work_item_id in work_item_ids:
            aggregate = self.get_work_item(
                work_item_id=work_item_id,
                team_id=query.team_id,
                viewer_user_id=query.viewer_user_id or "",
                viewer_context_channel_ids=query.viewer_context_channel_ids,
            )
            if aggregate is None:
                continue
            if not self._matches_query(aggregate, query):
                continue
            aggregates.append(aggregate)

        aggregates.sort(key=self._sort_key_for_query(query), reverse=True)
        return aggregates[: query.limit]

    def mutate_work_item(
        self,
        work_item_id: str,
        team_id: str,
        mutation: WorkItemMutation,
        actor_user_id: str,
    ) -> WorkItemAggregate:
        """Apply a mutation to an existing work item and rewrite derived indexes.

        Args:
            work_item_id: Work item identifier to mutate.
            team_id: Workspace id owning the work item.
            mutation: Requested changes to the item, participants, attention, and events.
            actor_user_id: User id responsible for the mutation.

        Returns:
            Hydrated aggregate after the mutation is applied.

        Raises:
            KeyError: If the target work item does not exist.
        """
        current_item = self._read_item(team_id, work_item_id)
        if current_item is None:
            raise KeyError(f"Work item {work_item_id!r} was not found.")
        current_participants = self._read_participants(team_id, work_item_id)
        current_events = self._read_events(team_id, work_item_id)
        now = utc_now()

        next_item = self._apply_item_patch(current_item, mutation.item_patch, now=now)
        next_participants = self._apply_participant_mutation(
            work_item_id=work_item_id,
            current_participants=current_participants,
            mutation=mutation,
            now=now,
        )
        next_primary_assignee_user_id = self._primary_assignee_user_id(
            next_participants
        )
        next_item = next_item.model_copy(
            update={
                "primary_assignee_user_id": next_primary_assignee_user_id,
                "completed_at": self._completed_at_for_status(
                    current_item=current_item,
                    next_status=next_item.status,
                    now=now,
                ),
                "updated_at": now,
            }
        )
        next_item = WorkItemDocument.model_validate(next_item.model_dump(mode="python"))

        next_events = self._sort_events([*current_events, *mutation.events])
        with Session(self._engine) as session:
            item_record = session.get(WorkItemRecord, (team_id, work_item_id))
            if item_record is None:
                raise KeyError(f"Work item {work_item_id!r} was not found.")
            self._apply_work_item_record(item_record, next_item)
            session.add(item_record)
            self._replace_participants(
                session=session,
                team_id=team_id,
                work_item_id=work_item_id,
                participants=next_participants.values(),
            )
            self._replace_events(
                session=session,
                team_id=team_id,
                work_item_id=work_item_id,
                events=next_events,
            )
            self._replace_attention_index(
                session=session,
                item=next_item,
                participants=next_participants,
                events=next_events,
            )
            session.commit()

        return self._hydrate_aggregate(
            item=next_item,
            participants=next_participants,
            events=next_events,
            viewer_user_id=actor_user_id,
        )

    def _work_item_record(self, item: WorkItemDocument) -> WorkItemRecord:
        """Build the SQLModel record used to persist a work item.

        Args:
            item: Work-item document to serialize.

        Returns:
            SQLModel record for the `work_items` table.
        """
        return WorkItemRecord(
            team_id=item.team_id,
            work_item_id=item.work_item_id,
            title=item.title,
            status=item.status,
            visibility_kind=item.visibility_kind,
            audience_channel_id=item.audience_channel_id,
            primary_assignee_user_id=item.primary_assignee_user_id,
            due_at=item.due_at,
            updated_at=item.updated_at,
            completed_at=item.completed_at,
            payload=self._dump(item),
        )

    def _apply_work_item_record(
        self,
        record: WorkItemRecord,
        item: WorkItemDocument,
    ) -> None:
        """Copy work-item document values onto an existing SQLModel record.

        Args:
            record: Existing SQLModel record to update in place.
            item: Work-item document whose values should be stored.

        Returns:
            None.
        """
        record.title = item.title
        record.status = item.status
        record.visibility_kind = item.visibility_kind
        record.audience_channel_id = item.audience_channel_id
        record.primary_assignee_user_id = item.primary_assignee_user_id
        record.due_at = item.due_at
        record.updated_at = item.updated_at
        record.completed_at = item.completed_at
        record.payload = self._dump(item)

    def _participant_record(
        self,
        team_id: str,
        participant: ParticipantRelationDocument,
    ) -> WorkItemParticipantRecord:
        """Build the SQLModel record used to persist a participant.

        Args:
            team_id: Slack workspace id owning the work item.
            participant: Participant relation to serialize.

        Returns:
            SQLModel record for the `work_item_participants` table.
        """
        return WorkItemParticipantRecord(
            team_id=team_id,
            work_item_id=participant.work_item_id,
            user_id=participant.user_id,
            role=participant.role,
            attention_profile=participant.attention_profile,
            next_attention_at=participant.next_attention_at,
            muted_until=participant.muted_until,
            last_seen_event_id=participant.last_seen_event_id,
            updated_at=participant.updated_at,
            payload=self._dump(participant),
        )

    def _event_record(
        self,
        team_id: str,
        event: WorkEventDocument,
    ) -> WorkItemEventRecord:
        """Build the SQLModel record used to persist a work-item event.

        Args:
            team_id: Slack workspace id owning the work item.
            event: Work-event document to serialize.

        Returns:
            SQLModel record for the `work_item_events` table.
        """
        return WorkItemEventRecord(
            team_id=team_id,
            work_item_id=event.work_item_id,
            event_id=event.event_id,
            type=event.type,
            occurred_at=event.occurred_at,
            payload=self._dump(event),
        )

    def _replace_participants(
        self,
        *,
        session: Session,
        team_id: str,
        work_item_id: str,
        participants: Iterable[ParticipantRelationDocument],
    ) -> None:
        """Rewrite participant rows for a work item inside an open transaction.

        Args:
            session: Open SQLModel session inside a transaction.
            team_id: Slack workspace id owning the work item.
            work_item_id: Work item identifier to rewrite.
            participants: Participant relations to persist.

        Returns:
            None.
        """
        existing_records = session.exec(
            select(WorkItemParticipantRecord).where(
                WorkItemParticipantRecord.team_id == team_id,
                WorkItemParticipantRecord.work_item_id == work_item_id,
            )
        ).all()
        for record in existing_records:
            session.delete(record)
        for participant in participants:
            session.add(self._participant_record(team_id, participant))

    def _replace_events(
        self,
        *,
        session: Session,
        team_id: str,
        work_item_id: str,
        events: Sequence[WorkEventDocument],
    ) -> None:
        """Rewrite event rows for a work item inside an open transaction.

        Args:
            session: Open SQLModel session inside a transaction.
            team_id: Slack workspace id owning the work item.
            work_item_id: Work item identifier to rewrite.
            events: Work-item events to persist in chronological order.

        Returns:
            None.
        """
        existing_records = session.exec(
            select(WorkItemEventRecord).where(
                WorkItemEventRecord.team_id == team_id,
                WorkItemEventRecord.work_item_id == work_item_id,
            )
        ).all()
        for record in existing_records:
            session.delete(record)
        for event in events:
            session.add(self._event_record(team_id, event))

    def _replace_attention_index(
        self,
        *,
        session: Session,
        item: WorkItemDocument,
        participants: dict[str, ParticipantRelationDocument],
        events: Sequence[WorkEventDocument],
    ) -> None:
        """Rewrite attention-index rows for the current participant set.

        Args:
            session: Open SQLModel session inside a transaction.
            item: Current persisted work item.
            participants: Participant relations keyed by user id.
            events: Chronologically sorted work-item events.

        Returns:
            None.
        """
        existing_records = session.exec(
            select(WorkItemAttentionIndexRecord).where(
                WorkItemAttentionIndexRecord.team_id == item.team_id,
                WorkItemAttentionIndexRecord.work_item_id == item.work_item_id,
            )
        ).all()
        for record in existing_records:
            session.delete(record)
        now = utc_now()
        for participant in participants.values():
            attention_index = self._build_attention_index(
                item=item,
                participant=participant,
                events=events,
                now=now,
            )
            session.add(
                WorkItemAttentionIndexRecord(
                    team_id=attention_index.team_id,
                    user_id=attention_index.user_id,
                    work_item_id=attention_index.work_item_id,
                    needs_attention_now=attention_index.needs_attention_now,
                    status=attention_index.status,
                    visibility_kind=attention_index.visibility_kind,
                    audience_channel_id=attention_index.audience_channel_id,
                    primary_assignee_user_id=attention_index.primary_assignee_user_id,
                    updated_at=attention_index.updated_at,
                    payload=self._dump(attention_index),
                )
            )

    def _read_item(self, team_id: str, work_item_id: str) -> WorkItemDocument | None:
        """Read and validate a stored work-item document.

        Args:
            team_id: Slack workspace id.
            work_item_id: Work item identifier.

        Returns:
            Validated work-item document, or `None` when not found.
        """
        with Session(self._engine) as session:
            record = session.get(WorkItemRecord, (team_id, work_item_id))
        if record is None:
            return None
        return WorkItemDocument.model_validate(record.payload)

    def _read_participants(
        self,
        team_id: str,
        work_item_id: str,
    ) -> dict[str, ParticipantRelationDocument]:
        """Read and validate participant relations for a work item.

        Args:
            team_id: Slack workspace id.
            work_item_id: Work item identifier.

        Returns:
            Mapping of participant user ids to validated participant relations.
        """
        statement = (
            select(WorkItemParticipantRecord)
            .where(
                WorkItemParticipantRecord.team_id == team_id,
                WorkItemParticipantRecord.work_item_id == work_item_id,
            )
            .order_by(asc(col(WorkItemParticipantRecord.user_id)))
        )
        with Session(self._engine) as session:
            rows = session.exec(statement).all()
        participants: dict[str, ParticipantRelationDocument] = {}
        for row in rows:
            participant = ParticipantRelationDocument.model_validate(row.payload)
            participants[participant.user_id] = participant
        return participants

    def _read_events(self, team_id: str, work_item_id: str) -> list[WorkEventDocument]:
        """Read and sort persisted events for a work item.

        Args:
            team_id: Slack workspace id.
            work_item_id: Work item identifier.

        Returns:
            Chronologically sorted event documents for the work item.
        """
        statement = (
            select(WorkItemEventRecord)
            .where(
                WorkItemEventRecord.team_id == team_id,
                WorkItemEventRecord.work_item_id == work_item_id,
            )
            .order_by(
                asc(col(WorkItemEventRecord.occurred_at)),
                asc(col(WorkItemEventRecord.event_id)),
            )
        )
        with Session(self._engine) as session:
            rows = session.exec(statement).all()
        return [WorkEventDocument.model_validate(row.payload) for row in rows]

    def _hydrate_aggregate(
        self,
        *,
        item: WorkItemDocument,
        participants: dict[str, ParticipantRelationDocument],
        events: Sequence[WorkEventDocument],
        viewer_user_id: str,
    ) -> WorkItemAggregate:
        """Hydrate a repository aggregate from its stored document components.

        Args:
            item: Work item document.
            participants: Participant relations keyed by user id.
            events: Chronologically sorted work-item events.
            viewer_user_id: Viewer user id used to resolve `viewer_relation`.

        Returns:
            Hydrated work-item aggregate.
        """
        return WorkItemAggregate(
            item=item,
            participants=list(participants.values()),
            recent_events=list(events),
            viewer_relation=participants.get(viewer_user_id),
        )

    def _sort_events(
        self,
        events: Sequence[WorkEventDocument],
    ) -> list[WorkEventDocument]:
        """Sort events deterministically by timestamp and event id.

        Args:
            events: Event documents to sort.

        Returns:
            Sorted list of event documents.
        """
        return sorted(events, key=lambda event: (event.occurred_at, event.event_id))

    def _primary_assignee_user_id(
        self,
        participants: dict[str, ParticipantRelationDocument],
    ) -> str | None:
        """Return the primary assignee user id from participant relations.

        Args:
            participants: Participant relations keyed by user id.

        Returns:
            Primary assignee user id, or `None` when none is present.
        """
        for participant in participants.values():
            if participant.role == ParticipantRole.PRIMARY_ASSIGNEE:
                return participant.user_id
        return None

    def _completed_at_for_status(
        self,
        *,
        current_item: WorkItemDocument,
        next_status: WorkItemStatus,
        now: datetime,
    ) -> datetime | None:
        """Derive the `completed_at` timestamp for a status transition.

        Args:
            current_item: Existing persisted work item.
            next_status: Status requested by the mutation.
            now: Current timestamp to use for first-time completion.

        Returns:
            Completion timestamp to store after the status change.
        """
        if next_status == WorkItemStatus.DONE:
            return current_item.completed_at or now
        if (
            current_item.status == WorkItemStatus.DONE
            and next_status != WorkItemStatus.DONE
        ):
            return None
        return current_item.completed_at

    def _apply_item_patch(
        self,
        item: WorkItemDocument,
        patch: WorkItemPatch,
        *,
        now: datetime,
    ) -> WorkItemDocument:
        """Apply a field patch to a work-item document.

        Args:
            item: Existing work-item document.
            patch: Field patch describing updates and clear operations.
            now: Timestamp to store in `updated_at`.

        Returns:
            Validated work-item document after applying the patch.
        """
        data = item.model_dump(mode="python")
        clear_fields = set(patch.clear_fields)
        for field_name in clear_fields:
            if field_name in {
                "description",
                "due_at",
                "home_channel_id",
                "project_ref",
            }:
                data[field_name] = None
            elif field_name in {
                "tags",
                "named_visibility_user_ids",
                "blocked_by_work_item_ids",
            }:
                data[field_name] = []

        updates = {
            "title": patch.title,
            "description": patch.description,
            "status": patch.status,
            "priority": patch.priority,
            "due_at": patch.due_at,
            "visibility_kind": patch.visibility_kind,
            "named_visibility_user_ids": patch.named_visibility_user_ids,
            "home_channel_id": patch.home_channel_id,
            "tags": patch.tags,
            "project_ref": patch.project_ref,
            "updated_at": now,
        }
        for field_name, value in updates.items():
            if value is not None:
                data[field_name] = value

        return WorkItemDocument.model_validate(data)

    def _apply_participant_mutation(
        self,
        *,
        work_item_id: str,
        current_participants: dict[str, ParticipantRelationDocument],
        mutation: WorkItemMutation,
        now: datetime,
    ) -> dict[str, ParticipantRelationDocument]:
        """Apply participant and attention changes to participant relations.

        Args:
            work_item_id: Work item identifier being mutated.
            current_participants: Existing participant relations keyed by user id.
            mutation: Mutation containing participant and attention updates.
            now: Timestamp to store in updated participant documents.

        Returns:
            Updated participant relations keyed by user id.
        """
        participants = {
            user_id: participant.model_copy(deep=True)
            for user_id, participant in current_participants.items()
        }

        def ensure_participant(
            user_id: str,
            *,
            role: ParticipantRole,
        ) -> ParticipantRelationDocument:
            """Ensure a participant relation exists with the requested role.

            Args:
                user_id: Participant user id to ensure.
                role: Role the participant should have after the mutation.

            Returns:
                Participant relation stored in the working participant mapping.
            """
            existing = participants.get(user_id)
            attention_profile = (
                existing.attention_profile
                if existing is not None
                else default_attention_profile_for_role(role)
            )
            next_attention_at = (
                existing.next_attention_at if existing is not None else None
            )
            muted_until = existing.muted_until if existing is not None else None
            if (
                role == ParticipantRole.PRIMARY_ASSIGNEE
                and attention_profile == AttentionProfile.MUTE
            ):
                attention_profile = default_attention_profile_for_role(role)
                muted_until = None
            participant = ParticipantRelationDocument(
                work_item_id=work_item_id,
                user_id=user_id,
                role=role,
                attention_profile=attention_profile,
                next_attention_at=next_attention_at,
                muted_until=muted_until,
                last_seen_event_id=existing.last_seen_event_id
                if existing is not None
                else None,
                joined_at=existing.joined_at if existing is not None else now,
                updated_at=now,
            )
            participants[user_id] = participant
            return participant

        if (
            mutation.clear_primary_assignee
            or mutation.primary_assignee_user_id is not None
        ):
            for user_id, participant in list(participants.items()):
                if participant.role == ParticipantRole.PRIMARY_ASSIGNEE:
                    del participants[user_id]

        if mutation.primary_assignee_user_id is not None:
            ensure_participant(
                mutation.primary_assignee_user_id,
                role=ParticipantRole.PRIMARY_ASSIGNEE,
            )

        for collaborator_user_id in mutation.collaborator_user_ids_to_add:
            existing = participants.get(collaborator_user_id)
            if (
                existing is not None
                and existing.role == ParticipantRole.PRIMARY_ASSIGNEE
            ):
                continue
            ensure_participant(collaborator_user_id, role=ParticipantRole.COLLABORATOR)

        for collaborator_user_id in mutation.collaborator_user_ids_to_remove:
            existing = participants.get(collaborator_user_id)
            if existing is not None and existing.role == ParticipantRole.COLLABORATOR:
                del participants[collaborator_user_id]

        for follower_user_id in mutation.follower_user_ids_to_add:
            if follower_user_id in participants:
                continue
            ensure_participant(follower_user_id, role=ParticipantRole.FOLLOWER)

        for follower_user_id in mutation.follower_user_ids_to_remove:
            existing = participants.get(follower_user_id)
            if existing is not None and existing.role == ParticipantRole.FOLLOWER:
                del participants[follower_user_id]

        for attention_update in mutation.attention_updates:
            self._apply_attention_update(
                participants=participants,
                update=attention_update,
                work_item_id=work_item_id,
                now=now,
            )

        return participants

    def _apply_attention_update(
        self,
        *,
        participants: dict[str, ParticipantRelationDocument],
        update: ParticipantAttentionUpdate,
        work_item_id: str,
        now: datetime,
    ) -> None:
        """Apply a single attention update to the working participant set.

        Args:
            participants: Mutable participant relations keyed by user id.
            update: Requested attention update for one user.
            work_item_id: Work item identifier being mutated.
            now: Timestamp to store in updated participant documents.

        Returns:
            None.
        """
        existing = participants.get(update.user_id)
        if existing is None:
            if not update.create_if_missing:
                return
            existing = ParticipantRelationDocument(
                work_item_id=work_item_id,
                user_id=update.user_id,
                role=update.role_if_missing,
                attention_profile=default_attention_profile_for_role(
                    update.role_if_missing
                ),
                joined_at=now,
                updated_at=now,
            )

        next_attention_at = existing.next_attention_at
        if update.clear_next_attention_at:
            next_attention_at = None
        elif update.next_attention_at is not None:
            next_attention_at = update.next_attention_at

        muted_until = existing.muted_until
        if update.clear_muted_until:
            muted_until = None
        elif update.muted_until is not None:
            muted_until = update.muted_until

        attention_profile = update.attention_profile or existing.attention_profile
        if (
            existing.role == ParticipantRole.PRIMARY_ASSIGNEE
            and attention_profile == AttentionProfile.MUTE
        ):
            attention_profile = default_attention_profile_for_role(existing.role)
            muted_until = None

        participants[update.user_id] = ParticipantRelationDocument(
            work_item_id=work_item_id,
            user_id=update.user_id,
            role=existing.role,
            attention_profile=attention_profile,
            next_attention_at=next_attention_at,
            muted_until=muted_until,
            last_seen_event_id=existing.last_seen_event_id,
            joined_at=existing.joined_at,
            updated_at=now,
        )

    def _build_attention_index(
        self,
        *,
        item: WorkItemDocument,
        participant: ParticipantRelationDocument,
        events: Sequence[WorkEventDocument],
        now: datetime,
    ) -> WorkItemAttentionIndexDocument:
        """Build the attention-index document for one participant.

        Args:
            item: Current persisted work item.
            participant: Participant relation to build the index for.
            events: Chronologically sorted work-item events.
            now: Current timestamp used for attention evaluation and `updated_at`.

        Returns:
            Attention-index document for the participant and work item.
        """
        unseen_event_types = self._unseen_event_types(
            events=events,
            last_seen_event_id=participant.last_seen_event_id,
        )
        return WorkItemAttentionIndexDocument(
            team_id=item.team_id,
            user_id=participant.user_id,
            work_item_id=item.work_item_id,
            status=item.status,
            visibility_kind=item.visibility_kind,
            audience_channel_id=item.audience_channel_id,
            home_channel_id=item.home_channel_id,
            primary_assignee_user_id=item.primary_assignee_user_id,
            attention_profile=participant.attention_profile,
            next_attention_at=participant.next_attention_at,
            needs_attention_now=derive_needs_attention_now(
                attention_profile=participant.attention_profile,
                now=now,
                next_attention_at=participant.next_attention_at,
                muted_until=participant.muted_until,
                unseen_event_types=unseen_event_types,
            ),
            attention_reason=derive_attention_reason(
                attention_profile=participant.attention_profile,
                now=now,
                next_attention_at=participant.next_attention_at,
                muted_until=participant.muted_until,
                unseen_event_types=unseen_event_types,
            ),
            last_seen_event_id=participant.last_seen_event_id,
            updated_at=now,
        )

    def _unseen_event_types(
        self,
        *,
        events: Sequence[WorkEventDocument],
        last_seen_event_id: str | None,
    ) -> list[Any]:
        """Return event types that occurred after the last seen event id.

        Args:
            events: Chronologically sorted work-item events.
            last_seen_event_id: Event id most recently seen by the participant.

        Returns:
            Event types unseen by the participant.
        """
        if last_seen_event_id is None:
            return [event.type for event in events]
        unseen = False
        result: list[Any] = []
        for event in events:
            if unseen:
                result.append(event.type)
                continue
            if event.event_id == last_seen_event_id:
                unseen = True
        if not unseen:
            return [event.type for event in events]
        return result

    def _can_view(
        self,
        *,
        item: WorkItemDocument,
        participants: dict[str, ParticipantRelationDocument],
        viewer_user_id: str,
        viewer_context_channel_ids: Sequence[str],
    ) -> bool:
        """Return whether a viewer can access a work item.

        Args:
            item: Work item being checked.
            participants: Participant relations keyed by user id.
            viewer_user_id: User requesting access.
            viewer_context_channel_ids: Channels defining the viewer's context visibility.

        Returns:
            `True` when the viewer is allowed to see the work item.
        """
        if viewer_user_id in participants:
            return True
        if item.visibility_kind == VisibilityPolicyKind.PRIVATE:
            return False
        if item.visibility_kind == VisibilityPolicyKind.NAMED:
            return viewer_user_id in item.named_visibility_user_ids
        if item.visibility_kind == VisibilityPolicyKind.CONTEXT:
            return (
                item.audience_channel_id is not None
                and item.audience_channel_id in viewer_context_channel_ids
            )
        return False

    def _list_attention_index_work_item_ids(self, query: WorkItemQuery) -> list[str]:
        """List work-item ids currently needing attention for the query viewer.

        Args:
            query: Query containing the viewer and workspace context.

        Returns:
            Work item ids whose attention index indicates they need attention now.
        """
        if not query.viewer_user_id:
            return []
        statement = (
            select(WorkItemAttentionIndexRecord.work_item_id)
            .where(
                WorkItemAttentionIndexRecord.team_id == query.team_id,
                WorkItemAttentionIndexRecord.user_id == query.viewer_user_id,
                col(WorkItemAttentionIndexRecord.needs_attention_now).is_(True),
            )
            .order_by(desc(col(WorkItemAttentionIndexRecord.updated_at)))
        )
        with Session(self._engine) as session:
            return list(session.exec(statement).all())

    def _matches_query(
        self,
        aggregate: WorkItemAggregate,
        query: WorkItemQuery,
    ) -> bool:
        """Return whether a hydrated aggregate matches a query.

        Args:
            aggregate: Hydrated work-item aggregate to test.
            query: Query containing view and filter constraints.

        Returns:
            `True` when the aggregate satisfies the query.
        """
        item = aggregate.item
        participant_user_ids = {
            participant.user_id for participant in aggregate.participants
        }

        if not query.include_completed and item.status in COMPLETED_STATUSES:
            return False
        if query.status_in and item.status not in query.status_in:
            return False
        if (
            query.visibility_kind is not None
            and item.visibility_kind != query.visibility_kind
        ):
            return False
        if (
            query.primary_assignee_user_id is not None
            and item.primary_assignee_user_id != query.primary_assignee_user_id
        ):
            return False
        if (
            query.participant_user_id is not None
            and query.participant_user_id not in participant_user_ids
        ):
            return False
        if (
            query.audience_channel_id is not None
            and item.audience_channel_id != query.audience_channel_id
        ):
            return False
        if query.due_before is not None and (
            item.due_at is None or item.due_at > query.due_before
        ):
            return False
        if query.text_query and not self._matches_text_query(item, query.text_query):
            return False
        if query.needs_attention_only and not self._needs_attention_for_query(
            aggregate
        ):
            return False

        viewer_user_id = query.viewer_user_id or ""
        if query.view == WorkItemQueryView.MY_TASKS:
            return item.primary_assignee_user_id == viewer_user_id
        if query.view == WorkItemQueryView.INBOX:
            return viewer_user_id in participant_user_ids
        if query.view == WorkItemQueryView.CHANNEL_OPEN:
            target_channel_id = query.audience_channel_id or query.viewer_channel_id
            return bool(
                target_channel_id and item.audience_channel_id == target_channel_id
            )
        if query.view == WorkItemQueryView.DONE_RECENTLY:
            return item.status in COMPLETED_STATUSES
        return True

    def _needs_attention_for_query(self, aggregate: WorkItemAggregate) -> bool:
        """Return whether the viewer currently needs attention on an aggregate.

        Args:
            aggregate: Hydrated work-item aggregate to evaluate.

        Returns:
            `True` when the viewer relation indicates attention is currently needed.
        """
        viewer_relation = aggregate.viewer_relation
        if viewer_relation is None:
            return False
        unseen_event_types = self._unseen_event_types(
            events=aggregate.recent_events,
            last_seen_event_id=viewer_relation.last_seen_event_id,
        )
        return derive_needs_attention_now(
            attention_profile=viewer_relation.attention_profile,
            now=utc_now(),
            next_attention_at=viewer_relation.next_attention_at,
            muted_until=viewer_relation.muted_until,
            unseen_event_types=unseen_event_types,
        )

    def _matches_text_query(self, item: WorkItemDocument, text_query: str) -> bool:
        """Return whether a work item matches a free-text query.

        Args:
            item: Work item to test.
            text_query: Case-insensitive text query.

        Returns:
            `True` when the query matches the title, description, or tags.
        """
        query = text_query.casefold()
        if query in item.title.casefold():
            return True
        if item.description and query in item.description.casefold():
            return True
        return any(query in tag.casefold() for tag in item.tags)

    def _sort_key_for_query(
        self,
        query: WorkItemQuery,
    ) -> Any:
        """Build the sort-key function used for a query result set.

        Args:
            query: Query whose view determines the desired sort behavior.

        Returns:
            Callable-compatible key function used to sort aggregates.
        """
        if query.view == WorkItemQueryView.DONE_RECENTLY:
            return lambda aggregate: (
                aggregate.item.completed_at or aggregate.item.updated_at
            )
        if query.view == WorkItemQueryView.NEEDS_ATTENTION:
            return lambda aggregate: (
                (
                    aggregate.viewer_relation.next_attention_at
                    if aggregate.viewer_relation is not None
                    else None
                )
                or aggregate.item.updated_at
            )
        return lambda aggregate: aggregate.item.updated_at

    def _dump(self, document: BaseModel) -> dict[str, Any]:
        """Serialize a Pydantic document into JSON-friendly Python data.

        Args:
            document: Pydantic document to serialize.

        Returns:
            Plain Python dictionary ready to persist in a JSON column.
        """
        return cast(dict[str, Any], document.model_dump(mode="json"))


__all__ = ["PostgresWorkItemRepository"]
