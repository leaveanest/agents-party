from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import cast

import pytest
from pydantic_ai import RunContext
from pydantic_ai import CodeExecutionTool, WebFetchTool, WebSearchTool
from pydantic_ai.models.test import TestModel

import agents_party.agents.work_manager.runtime as work_manager_runtime_module
from agents_party.agents.work_manager import (
    WorkManagerAction,
    WorkManagerDeps,
    WorkManagerInvocation,
    WorkManagerPreparedRequest,
    WorkManagerRequestContext,
    WorkManagerResult,
    build_work_manager_execution_input,
    build_work_manager_agent,
    build_work_manager_preparer_agent,
    prepare_work_manager_request,
    run_work_manager,
)
from agents_party.agents.tools import (
    capture_work_item,
    complete_work_item,
    find_work_item_candidates,
    get_time_context,
    link_google_calendar_event,
    list_work_items,
    set_my_attention,
    unlink_google_calendar_event,
    update_participants,
)
from agents_party.domain.work_management import (
    AttentionProfile,
    WorkItemCalendarLinkDocument,
    WorkItemCalendarSyncStatus,
    ParticipantRelationDocument,
    ParticipantRole,
    VisibilityPolicyKind,
    WorkEventDocument,
    WorkEventType,
    WorkItemAggregate,
    WorkItemDocument,
    WorkItemMutation,
    WorkItemPriority,
    WorkItemQuery,
    WorkItemQueryView,
    WorkItemStatus,
)
from agents_party.domain import MessageRole, ThreadMessage


@dataclass
class InMemoryRepository:
    items: dict[str, WorkItemDocument]
    participants: dict[str, dict[str, ParticipantRelationDocument]]
    events: dict[str, list[WorkEventDocument]]
    calendar_links: dict[str, dict[str, WorkItemCalendarLinkDocument]]

    def __init__(self) -> None:
        """Initialize empty in-memory storage for work-manager tests.

        Returns:
            None.
        """
        self.items = {}
        self.participants = {}
        self.events = {}
        self.calendar_links = {}

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
        self.calendar_links[item.work_item_id] = {}
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

    def link_calendar_event(
        self,
        work_item_id: str,
        team_id: str,
        calendar_link: WorkItemCalendarLinkDocument,
        actor_user_id: str,
        apply_starts_at_to_due_at: bool = False,
        apply_starts_at_to_next_attention_at_for_user_id: str | None = None,
    ) -> WorkItemAggregate:
        """Link a calendar event snapshot in the in-memory store.

        Args:
            work_item_id: Work item identifier to mutate.
            team_id: Workspace id, unused by the in-memory fake.
            calendar_link: Calendar link snapshot to store.
            actor_user_id: User id used to resolve the viewer relation in the result.
            apply_starts_at_to_due_at: Whether to copy the start time to `due_at`.
            apply_starts_at_to_next_attention_at_for_user_id: Optional user id whose
                next attention time should receive the event start.

        Returns:
            Hydrated aggregate after the link operation.
        """
        del team_id
        self.calendar_links[work_item_id][calendar_link.link_id] = calendar_link
        self.events[work_item_id].append(
            WorkEventDocument(
                event_id=f"calendar-{len(self.events[work_item_id])}",
                work_item_id=work_item_id,
                type=WorkEventType.CALENDAR_EVENT_LINKED,
                actor_user_id=actor_user_id,
                payload={"calendar_link_id": calendar_link.link_id},
            )
        )
        if calendar_link.sync_status == WorkItemCalendarSyncStatus.CANCELED:
            self.events[work_item_id].append(
                WorkEventDocument(
                    event_id=f"calendar-{len(self.events[work_item_id])}",
                    work_item_id=work_item_id,
                    type=WorkEventType.CALENDAR_EVENT_CANCELED,
                    actor_user_id=actor_user_id,
                    payload={"calendar_link_id": calendar_link.link_id},
                )
            )
        if apply_starts_at_to_due_at:
            self.items[work_item_id] = self.items[work_item_id].model_copy(
                update={"due_at": calendar_link.starts_at}
            )
        if apply_starts_at_to_next_attention_at_for_user_id is not None:
            participant = self.participants[work_item_id][
                apply_starts_at_to_next_attention_at_for_user_id
            ]
            self.participants[work_item_id][
                apply_starts_at_to_next_attention_at_for_user_id
            ] = participant.model_copy(
                update={"next_attention_at": calendar_link.starts_at}
            )
        return self._aggregate(work_item_id, actor_user_id)

    def unlink_calendar_event(
        self,
        work_item_id: str,
        team_id: str,
        link_id: str,
        actor_user_id: str,
    ) -> WorkItemAggregate:
        """Remove a calendar event link from the in-memory store.

        Args:
            work_item_id: Work item identifier to mutate.
            team_id: Workspace id, unused by the in-memory fake.
            link_id: Calendar link identifier to remove.
            actor_user_id: User id used to resolve the viewer relation in the result.

        Returns:
            Hydrated aggregate after the unlink operation.
        """
        del team_id
        del self.calendar_links[work_item_id][link_id]
        self.events[work_item_id].append(
            WorkEventDocument(
                event_id=f"calendar-{len(self.events[work_item_id])}",
                work_item_id=work_item_id,
                type=WorkEventType.CALENDAR_EVENT_UNLINKED,
                actor_user_id=actor_user_id,
                payload={"calendar_link_id": link_id},
            )
        )
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
            calendar_links=list(self.calendar_links[work_item_id].values()),
            viewer_relation=self.participants[work_item_id].get(viewer_user_id),
        )


def make_ctx(
    repository: InMemoryRepository,
    *,
    current_time: datetime | None = None,
    default_timezone: str = "UTC",
) -> RunContext[WorkManagerDeps]:
    """Build a work-manager run context backed by the in-memory repository.

    Args:
        repository: In-memory repository used by the tool tests.
        current_time: Optional fixed current time for deterministic tests.
        default_timezone: IANA timezone used by the tool-facing context.

    Returns:
        Run context carrying deterministic dependencies and request metadata.
    """
    resolved_now = current_time or datetime(2026, 3, 22, tzinfo=UTC)
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
        now=lambda: resolved_now,
        default_timezone=default_timezone,
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
        "get_time_context",
        "capture_work_item",
        "list_work_items",
        "update_work_item_status",
        "update_work_item_fields",
        "update_participants",
        "set_my_attention",
        "complete_work_item",
        "find_work_item_candidates",
        "link_google_calendar_event",
        "unlink_google_calendar_event",
    }


@pytest.mark.asyncio
async def test_prepare_work_manager_request_defaults_to_original_text() -> None:
    """Verify default work-manager preparation preserves the original request.

    Returns:
        None.
    """
    invocation = WorkManagerInvocation(
        team_id="T1",
        user_id="U1",
        channel_id="C123",
        text="capture a task for tomorrow morning",
        thread_messages=[
            ThreadMessage(
                ts="1712345678.000100",
                role=MessageRole.USER,
                text="capture a task for tomorrow morning",
                user_id="U1",
            )
        ],
    )

    prepared = await prepare_work_manager_request(invocation)

    assert prepared.original_text == invocation.text
    assert prepared.execution_text == invocation.text
    assert prepared.planning_notes == []
    assert prepared.thread_messages == invocation.thread_messages


def test_build_work_manager_preparer_agent_registers_expected_builtin_tools() -> None:
    """Verify the work-manager preparer exposes the intended builtin tools.

    Returns:
        None.
    """
    agent = build_work_manager_preparer_agent(
        model="google-vertex:gemini-3-flash-preview"
    )

    builtin_tools = getattr(
        agent,
        "_builtin_tools",
        getattr(agent, "_cap_builtin_tools", []),
    )
    builtin_tool_types = {type(tool) for tool in builtin_tools}

    assert builtin_tool_types == {
        WebSearchTool,
        CodeExecutionTool,
        WebFetchTool,
    }


def test_build_work_manager_execution_input_includes_planning_notes() -> None:
    """Verify planning notes are attached ahead of executor input text.

    Returns:
        None.
    """
    prepared = WorkManagerPreparedRequest(
        original_text="capture a task",
        execution_text="capture a task with normalized timing",
        planning_notes=["Resolved `tomorrow morning` in Asia/Tokyo."],
        thread_messages=[
            ThreadMessage(
                ts="1712345678.000100",
                role=MessageRole.USER,
                text="capture a task",
                user_id="U1",
            )
        ],
    )

    prompt = build_work_manager_execution_input(prepared)

    assert prompt.startswith(
        "Slack thread transcript:\n[1712345678.000100] user:U1 capture a task"
    )
    assert "Preparation notes:\n- Resolved `tomorrow morning` in Asia/Tokyo." in prompt
    assert "User request:\ncapture a task with normalized timing" in prompt
    assert prompt.endswith("capture a task with normalized timing")


def test_get_time_context_returns_localized_now() -> None:
    """Verify the time-context tool exposes localized request time metadata.

    Returns:
        None.
    """
    repository = InMemoryRepository()
    ctx = make_ctx(
        repository,
        current_time=datetime(2026, 3, 22, 15, 30, tzinfo=UTC),
        default_timezone="Asia/Tokyo",
    )

    result = get_time_context(ctx)

    assert result.now.isoformat() == "2026-03-23T00:30:00+09:00"
    assert result.timezone_name == "Asia/Tokyo"
    assert result.current_date == "2026-03-23"
    assert result.current_time == "00:30"
    assert result.current_day_of_week == "Monday"


@pytest.mark.asyncio
async def test_run_work_manager_uses_builtin_preparer_for_google_string_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify Google string models trigger the builtin-tool preparer stage.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub the preparer and executor.

    Returns:
        None.
    """
    repository = InMemoryRepository()
    invocation = WorkManagerInvocation(
        team_id="T1",
        user_id="U1",
        channel_id="C123",
        text="capture a task from https://example.com by tomorrow",
        thread_messages=[
            ThreadMessage(
                ts="1712345678.000100",
                role=MessageRole.USER,
                text="capture a task from https://example.com by tomorrow",
                user_id="U1",
            )
        ],
    )
    called = False

    async def fake_run_work_manager_preparer(
        prepared_invocation: WorkManagerInvocation,
        *,
        model: str | None = None,
    ) -> WorkManagerPreparedRequest:
        nonlocal called
        called = True
        assert prepared_invocation.text == invocation.text
        assert model == "google-vertex:gemini-3-flash-preview"
        return WorkManagerPreparedRequest(
            original_text=prepared_invocation.text,
            execution_text="capture a task with normalized date",
            planning_notes=["Fetched the referenced page before executor run."],
        )

    class FakeExecutorAgent:
        async def run(self, prompt: str, deps: WorkManagerDeps) -> SimpleNamespace:
            assert "Slack thread transcript:" in prompt
            assert (
                "[1712345678.000100] user:U1 capture a task from https://example.com by tomorrow"
                in prompt
            )
            assert "Fetched the referenced page before executor run." in prompt
            assert "capture a task with normalized date" in prompt
            assert deps.request_context.channel_id == "C123"
            return SimpleNamespace(
                output=WorkManagerResult(
                    action=WorkManagerAction.NO_OP,
                    message="ok",
                    work_items=[],
                    needs_confirmation=False,
                    follow_up_question=None,
                )
            )

    monkeypatch.setattr(
        work_manager_runtime_module,
        "run_work_manager_preparer",
        fake_run_work_manager_preparer,
    )
    monkeypatch.setattr(
        work_manager_runtime_module,
        "build_work_manager_executor_agent",
        lambda model: FakeExecutorAgent(),
    )

    result = await run_work_manager(
        invocation,
        repository=repository,
        model="google-vertex:gemini-3-flash-preview",
    )

    assert called is True
    assert result.message == "ok"


@pytest.mark.asyncio
async def test_run_work_manager_accepts_request_preparer() -> None:
    """Verify a custom work-manager request-preparer hook is invoked.

    Returns:
        None.
    """
    repository = InMemoryRepository()
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
    called = False
    invocation = WorkManagerInvocation(
        team_id="T1",
        user_id="U1",
        channel_id="C123",
        text="capture a task for tomorrow morning",
    )

    async def request_preparer(
        prepared_invocation: WorkManagerInvocation,
    ) -> WorkManagerPreparedRequest:
        nonlocal called
        called = True
        return WorkManagerPreparedRequest(
            original_text=prepared_invocation.text,
            execution_text="capture a task for 2026-03-23 09:00",
            planning_notes=["Normalized relative scheduling before executor run."],
        )

    result = await run_work_manager(
        invocation,
        repository=repository,
        model=model,
        request_preparer=request_preparer,
    )

    assert called is True
    assert result.message == "ok"


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


def test_link_and_unlink_google_calendar_event_tools() -> None:
    """Verify work-manager tools expose calendar links in result snapshots.

    Returns:
        None.
    """
    repository = InMemoryRepository()
    ctx = make_ctx(repository)
    created = capture_work_item(ctx, title="Prepare meeting notes")

    linked = link_google_calendar_event(
        ctx,
        work_item_id=created.work_items[0].work_item_id,
        google_calendar_id="primary",
        google_event_id="event-1",
        event_title_snapshot="Planning meeting",
        starts_at=datetime(2026, 3, 24, 9, tzinfo=UTC),
        ends_at=datetime(2026, 3, 24, 10, tzinfo=UTC),
    )
    link_id = linked.work_items[0].calendar_links[0].link_id
    unlinked = unlink_google_calendar_event(
        ctx,
        work_item_id=created.work_items[0].work_item_id,
        link_id=link_id,
    )

    assert linked.work_items[0].calendar_links[0].external_event_id == "event-1"
    assert linked.work_items[0].calendar_links[0].link_id.startswith("google-")
    assert linked.work_items[0].due_at is None
    assert unlinked.work_items[0].calendar_links == []


def test_link_google_calendar_event_tool_is_idempotent_for_same_event() -> None:
    """Verify repeated links to the same Google event update one snapshot.

    Returns:
        None.
    """
    repository = InMemoryRepository()
    ctx = make_ctx(repository)
    created = capture_work_item(ctx, title="Prepare meeting notes")

    first = link_google_calendar_event(
        ctx,
        work_item_id=created.work_items[0].work_item_id,
        google_calendar_id="primary",
        google_event_id="event-1",
        event_title_snapshot="Planning meeting",
    )
    second = link_google_calendar_event(
        ctx,
        work_item_id=created.work_items[0].work_item_id,
        google_calendar_id="primary",
        google_event_id="event-1",
        event_title_snapshot="Updated planning meeting",
    )

    assert len(second.work_items[0].calendar_links) == 1
    assert second.work_items[0].calendar_links[0].link_id == (
        first.work_items[0].calendar_links[0].link_id
    )
    assert (
        second.work_items[0].calendar_links[0].event_title_snapshot
        == "Updated planning meeting"
    )


def test_link_google_calendar_event_tool_requires_start_for_time_application() -> None:
    """Verify missing start time returns a clarification instead of raising.

    Returns:
        None.
    """
    repository = InMemoryRepository()
    ctx = make_ctx(repository)
    created = capture_work_item(ctx, title="Review agenda")

    result = link_google_calendar_event(
        ctx,
        work_item_id=created.work_items[0].work_item_id,
        google_calendar_id="primary",
        google_event_id="event-2",
        apply_starts_at_to_due_at=True,
    )

    assert result.action == WorkManagerAction.CLARIFICATION_NEEDED
    assert result.needs_confirmation is True
    assert result.follow_up_question == "What start time should I apply?"


def test_link_google_calendar_event_tool_can_apply_start_time_explicitly() -> None:
    """Verify calendar event times only affect due and attention by request.

    Returns:
        None.
    """
    repository = InMemoryRepository()
    ctx = make_ctx(repository)
    created = capture_work_item(ctx, title="Review agenda")
    starts_at = datetime(2026, 3, 24, 9, tzinfo=UTC)

    linked = link_google_calendar_event(
        ctx,
        work_item_id=created.work_items[0].work_item_id,
        google_calendar_id="primary",
        google_event_id="event-2",
        starts_at=starts_at,
        apply_starts_at_to_due_at=True,
        apply_starts_at_to_next_attention_at_for_me=True,
    )

    assert linked.work_items[0].due_at == starts_at
    assert linked.work_items[0].next_attention_at_for_me == starts_at
