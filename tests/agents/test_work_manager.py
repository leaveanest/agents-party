from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import cast

import pytest
from pydantic_ai import RunContext
from pydantic_ai.models.test import TestModel

from agents_party.agents.work_manager import (
    WorkManagerDeps,
    WorkManagerRequestContext,
    build_work_manager_agent,
)
from agents_party.agents.tools import (
    capture_work_item,
    complete_work_item,
    find_work_item_candidates,
    list_work_items,
    set_my_attention,
    update_participants,
)
from agents_party.domain.work_management import (
    AttentionProfile,
    ParticipantRelationDocument,
    ParticipantRole,
    VisibilityPolicyKind,
    WorkEventDocument,
    WorkItemAggregate,
    WorkItemDocument,
    WorkItemMutation,
    WorkItemPriority,
    WorkItemQuery,
    WorkItemQueryView,
    WorkItemStatus,
)


@dataclass
class InMemoryRepository:
    items: dict[str, WorkItemDocument]
    participants: dict[str, dict[str, ParticipantRelationDocument]]
    events: dict[str, list[WorkEventDocument]]

    def __init__(self) -> None:
        """Initialize empty in-memory storage for work-manager tests.

        Returns:
            None.
        """
        self.items = {}
        self.participants = {}
        self.events = {}

    def create_work_item(
        self,
        item: WorkItemDocument,
        participants: list[ParticipantRelationDocument],
        initial_events: list[WorkEventDocument],
    ) -> WorkItemAggregate:
        """Store a new work item aggregate in memory.

        Args:
            item: Work item document to store.
            participants: Participant relations for the work item.
            initial_events: Initial event history to store.

        Returns:
            Hydrated aggregate for the stored work item.
        """
        self.items[item.work_item_id] = item
        self.participants[item.work_item_id] = {
            participant.user_id: participant for participant in participants
        }
        self.events[item.work_item_id] = list(initial_events)
        return self._aggregate(item.work_item_id, item.created_by_user_id)

    def get_work_item(
        self,
        work_item_id: str,
        team_id: str,
        viewer_user_id: str,
        viewer_context_channel_ids: list[str],
    ) -> WorkItemAggregate | None:
        """Load a stored work item aggregate from memory.

        Args:
            work_item_id: Work item identifier to fetch.
            team_id: Workspace id, unused by the in-memory fake.
            viewer_user_id: User id used to resolve the viewer relation.
            viewer_context_channel_ids: Context channels, unused by the in-memory fake.

        Returns:
            Stored aggregate, or `None` when the item does not exist.
        """
        del team_id, viewer_context_channel_ids
        if work_item_id not in self.items:
            return None
        return self._aggregate(work_item_id, viewer_user_id)

    def list_work_items(self, query: WorkItemQuery) -> list[WorkItemAggregate]:
        """List stored work items matching the subset of query behavior used in tests.

        Args:
            query: Query controlling text filtering, view behavior, and limits.

        Returns:
            Matching aggregates from the in-memory store.
        """
        aggregates = [
            self._aggregate(work_item_id, query.viewer_user_id or "")
            for work_item_id in self.items
        ]
        if query.text_query:
            lowered = query.text_query.casefold()
            aggregates = [
                aggregate
                for aggregate in aggregates
                if lowered in aggregate.item.title.casefold()
                or (
                    aggregate.item.description is not None
                    and lowered in aggregate.item.description.casefold()
                )
            ]
        if query.view == WorkItemQueryView.NEEDS_ATTENTION and query.viewer_user_id:
            aggregates = [
                aggregate
                for aggregate in aggregates
                if aggregate.viewer_relation is not None
            ]
        return aggregates[: query.limit]

    def mutate_work_item(
        self,
        work_item_id: str,
        team_id: str,
        mutation: WorkItemMutation,
        actor_user_id: str,
    ) -> WorkItemAggregate:
        """Apply a simplified mutation to a stored work item for tests.

        Args:
            work_item_id: Work item identifier to mutate.
            team_id: Workspace id, unused by the in-memory fake.
            mutation: Item, participant, and attention updates to apply.
            actor_user_id: User id used to resolve the viewer relation in the result.

        Returns:
            Hydrated aggregate after the mutation is applied.
        """
        del team_id
        item = self.items[work_item_id]
        data = item.model_dump(mode="python")
        patch = mutation.item_patch
        if patch.status is not None:
            data["status"] = patch.status
            data["completed_at"] = (
                datetime(2026, 3, 22, tzinfo=UTC)
                if patch.status == WorkItemStatus.DONE
                else None
            )
        for field_name in patch.clear_fields:
            if field_name in {
                "description",
                "due_at",
                "home_channel_id",
                "project_ref",
            }:
                data[field_name] = None
            elif field_name in {"tags", "named_visibility_user_ids"}:
                data[field_name] = []
        for field_name in (
            "title",
            "description",
            "due_at",
            "priority",
            "visibility_kind",
            "named_visibility_user_ids",
            "tags",
            "home_channel_id",
        ):
            value = getattr(patch, field_name)
            if value is not None:
                data[field_name] = value
        self.items[work_item_id] = WorkItemDocument.model_validate(data)

        participants = self.participants[work_item_id]
        if (
            mutation.clear_primary_assignee
            or mutation.primary_assignee_user_id is not None
        ):
            for user_id, participant in list(participants.items()):
                if participant.role == ParticipantRole.PRIMARY_ASSIGNEE:
                    del participants[user_id]
        if mutation.primary_assignee_user_id is not None:
            participants[mutation.primary_assignee_user_id] = (
                ParticipantRelationDocument(
                    work_item_id=work_item_id,
                    user_id=mutation.primary_assignee_user_id,
                    role=ParticipantRole.PRIMARY_ASSIGNEE,
                    attention_profile=AttentionProfile.FOCUS,
                )
            )
            self.items[work_item_id] = self.items[work_item_id].model_copy(
                update={"primary_assignee_user_id": mutation.primary_assignee_user_id}
            )
        for user_id in mutation.collaborator_user_ids_to_add:
            participants[user_id] = ParticipantRelationDocument(
                work_item_id=work_item_id,
                user_id=user_id,
                role=ParticipantRole.COLLABORATOR,
                attention_profile=AttentionProfile.TRACK,
            )
        for user_id in mutation.follower_user_ids_to_add:
            participants[user_id] = ParticipantRelationDocument(
                work_item_id=work_item_id,
                user_id=user_id,
                role=ParticipantRole.FOLLOWER,
                attention_profile=AttentionProfile.TRACK,
            )
        for attention_update in mutation.attention_updates:
            existing = participants.get(
                attention_update.user_id
            ) or ParticipantRelationDocument(
                work_item_id=work_item_id,
                user_id=attention_update.user_id,
                role=ParticipantRole.FOLLOWER,
                attention_profile=AttentionProfile.TRACK,
            )
            participants[attention_update.user_id] = existing.model_copy(
                update={
                    "attention_profile": attention_update.attention_profile
                    or existing.attention_profile,
                    "next_attention_at": attention_update.next_attention_at
                    if not attention_update.clear_next_attention_at
                    else None,
                    "muted_until": attention_update.muted_until
                    if not attention_update.clear_muted_until
                    else None,
                }
            )

        self.events[work_item_id].extend(mutation.events)
        return self._aggregate(work_item_id, actor_user_id)

    def _aggregate(self, work_item_id: str, viewer_user_id: str) -> WorkItemAggregate:
        """Build a work-item aggregate from the in-memory store.

        Args:
            work_item_id: Work item identifier to hydrate.
            viewer_user_id: User id used to resolve the viewer relation.

        Returns:
            Hydrated aggregate for the stored work item.
        """
        return WorkItemAggregate(
            item=self.items[work_item_id],
            participants=list(self.participants[work_item_id].values()),
            recent_events=list(self.events[work_item_id]),
            viewer_relation=self.participants[work_item_id].get(viewer_user_id),
        )


def make_ctx(repository: InMemoryRepository) -> RunContext[WorkManagerDeps]:
    """Build a work-manager run context backed by the in-memory repository.

    Args:
        repository: In-memory repository used by the tool tests.

    Returns:
        Run context carrying deterministic dependencies and request metadata.
    """
    deps = WorkManagerDeps(
        request_context=WorkManagerRequestContext(
            team_id="T1",
            user_id="U1",
            channel_id="C123",
            viewer_context_channel_ids=["C123"],
            thread_ts="1712345678.000100",
            message_ts="1712345678.000100",
        ),
        work_item_repository=repository,
        now=lambda: datetime(2026, 3, 22, tzinfo=UTC),
        default_timezone="UTC",
    )
    return cast(RunContext[WorkManagerDeps], SimpleNamespace(deps=deps))


@pytest.mark.asyncio
async def test_build_work_manager_agent_registers_expected_tools() -> None:
    """Verify the work-manager agent exposes the expected tool set.

    Returns:
        None.
    """
    repository = InMemoryRepository()
    deps = make_ctx(repository).deps
    model = TestModel(
        call_tools=[],
        custom_output_args={
            "action": "no_op",
            "message": "ok",
            "work_items": [],
            "needs_confirmation": False,
            "follow_up_question": None,
        },
    )
    agent = build_work_manager_agent(model=model)

    result = await agent.run("show my tasks", deps=deps)

    assert result.output.message == "ok"
    params = model.last_model_request_parameters
    assert params is not None
    assert {tool.name for tool in params.function_tools} == {
        "capture_work_item",
        "list_work_items",
        "update_work_item_status",
        "update_work_item_fields",
        "update_participants",
        "set_my_attention",
        "complete_work_item",
        "find_work_item_candidates",
    }


def test_capture_list_update_attention_complete_and_clarify() -> None:
    """Verify the core work-manager tools operate together on a fake repository.

    Returns:
        None.
    """
    repository = InMemoryRepository()
    ctx = make_ctx(repository)

    created = capture_work_item(
        ctx,
        title="Follow up with finance",
        description="Ask about the invoice",
        visibility_kind=VisibilityPolicyKind.CONTEXT,
        priority=WorkItemPriority.HIGH,
    )
    listed = list_work_items(ctx, view=WorkItemQueryView.INBOX)
    updated_participants = update_participants(
        ctx,
        work_item_id=created.work_items[0].work_item_id,
        collaborator_user_ids_to_add=["U2"],
    )
    attention = set_my_attention(
        ctx,
        work_item_id=created.work_items[0].work_item_id,
        attention_profile=AttentionProfile.TRACK,
        next_attention_at=datetime(2026, 3, 23, tzinfo=UTC),
    )
    completed = complete_work_item(ctx, work_item_id=created.work_items[0].work_item_id)
    capture_work_item(ctx, title="Follow up with finance again")
    candidates = find_work_item_candidates(ctx, text_query="follow up")

    assert created.action.value == "created"
    assert listed.work_items
    assert updated_participants.work_items[0].primary_assignee_user_id is None
    assert attention.work_items[0].next_attention_at_for_me == datetime(
        2026, 3, 23, tzinfo=UTC
    )
    assert completed.action.value == "completed"
    assert completed.work_items[0].status == WorkItemStatus.DONE
    assert candidates.needs_confirmation is True
