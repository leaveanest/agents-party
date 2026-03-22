from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from importlib import import_module
from typing import Any, cast
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai import Agent, RunContext
from pydantic_ai.models import KnownModelName, Model

from agents_party.config import settings
from agents_party.domain import (
    AttentionProfile,
    WorkItemAggregate,
    WorkItemPriority,
    WorkItemStatus,
    derive_attention_reason,
    derive_needs_attention_now,
    utc_now,
)
from agents_party.repositories import WorkItemRepository


class WorkManagerInvocation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    team_id: str
    user_id: str
    channel_id: str
    viewer_context_channel_ids: list[str] = Field(default_factory=list)
    text: str
    thread_ts: str | None = None
    message_ts: str | None = None

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any]) -> WorkManagerInvocation:
        """Validate a generic mapping into a typed work-manager invocation.

        Args:
            data: Untrusted invocation payload supplied by callers.

        Returns:
            Validated work-manager invocation model.
        """
        return cls.model_validate(data)

    def to_request_context(self) -> WorkManagerRequestContext:
        """Project the invocation into repository-oriented request context.

        Returns:
            Request context carrying workspace, viewer, and Slack source metadata.
        """
        return WorkManagerRequestContext(
            team_id=self.team_id,
            user_id=self.user_id,
            channel_id=self.channel_id,
            viewer_context_channel_ids=self.viewer_context_channel_ids
            or [self.channel_id],
            thread_ts=self.thread_ts,
            message_ts=self.message_ts,
        )


@dataclass(slots=True)
class WorkManagerRequestContext:
    team_id: str
    user_id: str
    channel_id: str
    viewer_context_channel_ids: list[str]
    thread_ts: str | None = None
    message_ts: str | None = None


@dataclass(slots=True)
class WorkManagerDeps:
    request_context: WorkManagerRequestContext
    work_item_repository: WorkItemRepository
    now: Callable[[], datetime]
    default_timezone: str
    max_list_size: int = 20


class WorkManagerAction(StrEnum):
    CREATED = "created"
    LISTED = "listed"
    UPDATED = "updated"
    COMPLETED = "completed"
    CLARIFICATION_NEEDED = "clarification_needed"
    NO_OP = "no_op"


def _unseen_event_types(aggregate: WorkItemAggregate) -> list[Any]:
    """Return event types the viewer has not seen in an aggregate.

    Args:
        aggregate: Work-item aggregate including recent events and viewer relation.

    Returns:
        Event types that occurred after the viewer's last seen event.
    """
    viewer_relation = aggregate.viewer_relation
    if viewer_relation is None:
        return []
    if viewer_relation.last_seen_event_id is None:
        return [event.type for event in aggregate.recent_events]

    unseen = False
    unseen_event_types: list[Any] = []
    for event in aggregate.recent_events:
        if unseen:
            unseen_event_types.append(event.type)
            continue
        if event.event_id == viewer_relation.last_seen_event_id:
            unseen = True

    if not unseen:
        return [event.type for event in aggregate.recent_events]
    return unseen_event_types


class WorkManagerWorkItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    work_item_id: str
    title: str
    status: WorkItemStatus
    priority: WorkItemPriority
    due_at: datetime | None = None
    primary_assignee_user_id: str | None = None
    audience_channel_id: str | None = None
    attention_profile: AttentionProfile | None = None
    next_attention_at_for_me: datetime | None = None
    needs_attention_now: bool = False
    attention_reason: str | None = None

    @classmethod
    def from_aggregate(
        cls,
        aggregate: WorkItemAggregate,
        *,
        now: datetime,
    ) -> WorkManagerWorkItem:
        """Build a work-manager view model from a repository aggregate.

        Args:
            aggregate: Repository aggregate to summarize for the work-manager agent.
            now: Current time used to evaluate attention state.

        Returns:
            Work-manager summary item for the aggregate.
        """
        viewer_relation = aggregate.viewer_relation
        if viewer_relation is None:
            return cls(
                work_item_id=aggregate.item.work_item_id,
                title=aggregate.item.title,
                status=aggregate.item.status,
                priority=aggregate.item.priority,
                due_at=aggregate.item.due_at,
                primary_assignee_user_id=aggregate.item.primary_assignee_user_id,
                audience_channel_id=aggregate.item.audience_channel_id,
            )

        unseen_event_types = _unseen_event_types(aggregate)
        return cls(
            work_item_id=aggregate.item.work_item_id,
            title=aggregate.item.title,
            status=aggregate.item.status,
            priority=aggregate.item.priority,
            due_at=aggregate.item.due_at,
            primary_assignee_user_id=aggregate.item.primary_assignee_user_id,
            audience_channel_id=aggregate.item.audience_channel_id,
            attention_profile=viewer_relation.attention_profile,
            next_attention_at_for_me=viewer_relation.next_attention_at,
            needs_attention_now=derive_needs_attention_now(
                attention_profile=viewer_relation.attention_profile,
                now=now,
                next_attention_at=viewer_relation.next_attention_at,
                muted_until=viewer_relation.muted_until,
                unseen_event_types=unseen_event_types,
            ),
            attention_reason=derive_attention_reason(
                attention_profile=viewer_relation.attention_profile,
                now=now,
                next_attention_at=viewer_relation.next_attention_at,
                muted_until=viewer_relation.muted_until,
                unseen_event_types=unseen_event_types,
            ),
        )


class WorkManagerResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: WorkManagerAction
    message: str
    work_items: list[WorkManagerWorkItem] = Field(default_factory=list)
    needs_confirmation: bool = False
    follow_up_question: str | None = None


def _timezone_or_utc(timezone_name: str) -> ZoneInfo:
    """Resolve a timezone name and fall back to UTC when it is invalid.

    Args:
        timezone_name: IANA timezone name to resolve.

    Returns:
        Resolved timezone, or UTC when the name is unknown.
    """
    try:
        return ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def format_timestamp(value: datetime | None, timezone_name: str) -> str | None:
    """Format a timestamp for Slack-facing work-manager responses.

    Args:
        value: Timestamp to format.
        timezone_name: IANA timezone used for display.

    Returns:
        Formatted timestamp string, or `None` when no timestamp is provided.
    """
    if value is None:
        return None
    return value.astimezone(_timezone_or_utc(timezone_name)).strftime("%Y-%m-%d %H:%M")


def format_work_item_brief(
    item: WorkManagerWorkItem,
    *,
    timezone_name: str,
) -> str:
    """Render a compact one-line summary of a work item.

    Args:
        item: Work-manager summary item to render.
        timezone_name: IANA timezone used for formatting due and attention dates.

    Returns:
        Single-line human-readable summary.
    """
    parts = [f"`{item.title}`", f"[{item.status.value}]"]
    if item.primary_assignee_user_id:
        parts.append(f"owner <@{item.primary_assignee_user_id}>")
    due = format_timestamp(item.due_at, timezone_name)
    if due:
        parts.append(f"due {due}")
    attention = format_timestamp(item.next_attention_at_for_me, timezone_name)
    if attention:
        parts.append(f"next check {attention}")
    if item.needs_attention_now:
        parts.append("needs attention now")
    return " ".join(parts)


def build_created_message(
    item: WorkManagerWorkItem,
    *,
    timezone_name: str,
    source_is_thread: bool,
) -> str:
    """Build the Slack message returned after creating a work item.

    Args:
        item: Created work-item summary.
        timezone_name: IANA timezone used for formatting timestamps.
        source_is_thread: Whether the capture originated from a Slack thread.

    Returns:
        Slack-ready confirmation message.
    """
    suffix = " Source is this thread." if source_is_thread else ""
    return (
        f"Captured {format_work_item_brief(item, timezone_name=timezone_name)}.{suffix}"
    )


def build_updated_message(
    item: WorkManagerWorkItem,
    *,
    timezone_name: str,
    action_word: str = "Updated",
) -> str:
    """Build the Slack message returned after updating a work item.

    Args:
        item: Updated work-item summary.
        timezone_name: IANA timezone used for formatting timestamps.
        action_word: Leading verb phrase describing the update operation.

    Returns:
        Slack-ready update confirmation message.
    """
    return f"{action_word} {format_work_item_brief(item, timezone_name=timezone_name)}."


def build_list_message(
    items: Sequence[WorkManagerWorkItem],
    *,
    timezone_name: str,
    title: str = "Matching tasks",
) -> str:
    """Build a Slack message listing work items.

    Args:
        items: Work items to include in the message.
        timezone_name: IANA timezone used for formatting timestamps.
        title: Heading shown above the numbered list.

    Returns:
        Slack-ready list response.
    """
    if not items:
        return "No matching tasks found."
    lines = [title + ":"]
    for index, item in enumerate(items, start=1):
        lines.append(
            f"{index}. {format_work_item_brief(item, timezone_name=timezone_name)}"
        )
    return "\n".join(lines)


def build_candidates_question(
    items: Sequence[WorkManagerWorkItem],
    *,
    timezone_name: str,
) -> str:
    """Build a clarification question for ambiguous work-item references.

    Args:
        items: Candidate work items that might match the user's request.
        timezone_name: IANA timezone used for formatting timestamps.

    Returns:
        Slack-ready clarification message.
    """
    if not items:
        return "I could not find a matching task. Which task do you mean?"
    title = "I found multiple matching tasks. Which one do you mean?"
    lines = [title]
    for index, item in enumerate(items, start=1):
        lines.append(
            f"{index}. {format_work_item_brief(item, timezone_name=timezone_name)}"
        )
    return "\n".join(lines)


WORK_ITEM_CAPTURE_SECTION = """
When the user is creating a new task, compress the title into a short actionable phrase,
keep the description compact, and preserve source context from Slack automatically.
Prefer capturing first over over-editing the wording.
Default visibility to `private` in DMs and `context` in channels unless the user says otherwise.
"""


WORK_ITEM_CLARIFIER_SECTION = """
When an update target is ambiguous, do not guess.
Call `find_work_item_candidates` first and, if the result needs confirmation, return that result unchanged.
Ask only one short blocking question at a time.
"""


ATTENTION_REVIEW_BUILDER_SECTION = """
Keep Slack responses short.
For list responses, prefer the most relevant items first and avoid long explanations.
Never confuse `due_at` with `next_attention_at`.
"""


def build_work_manager_instructions() -> tuple[str, ...]:
    """Return the instruction blocks used by the work-manager agent.

    Returns:
        Ordered instruction strings fed into the work-manager agent.
    """
    return (
        "You manage Slack-originated work items. Users may say `task`, but the system model is `work item`.",
        "Use the provided tools for all reads and writes. Never invent work item ids, participants, or state changes.",
        "Prefer `capture_work_item` for new tasks, `list_work_items` for inbox or attention views, and explicit update tools for changes.",
        WORK_ITEM_CAPTURE_SECTION.strip(),
        WORK_ITEM_CLARIFIER_SECTION.strip(),
        ATTENTION_REVIEW_BUILDER_SECTION.strip(),
    )


def build_work_manager_agent(
    model: Model | KnownModelName | str | None = None,
) -> Agent[WorkManagerDeps, WorkManagerResult]:
    """Build the work-manager agent and register its tools.

    Args:
        model: Optional model override for the work-manager agent.

    Returns:
        Configured work-manager agent.

    Raises:
        ValueError: If no work-manager model can be resolved.
    """
    from agents_party.agents.tools import register_work_manager_tools

    resolved_model = model or settings.work_manager_model
    if resolved_model is None:
        raise ValueError(
            "Work manager model is not configured. Set WORK_MANAGER_MODEL or pass a model explicitly."
        )

    agent = cast(
        Agent[WorkManagerDeps, WorkManagerResult],
        Agent(
            resolved_model,
            name="work_manager",
            deps_type=WorkManagerDeps,
            output_type=WorkManagerResult,
            instructions=build_work_manager_instructions(),
            defer_model_check=True,
        ),
    )
    register_work_manager_tools(agent)

    @agent.output_validator
    def _validate_output(
        _ctx: RunContext[WorkManagerDeps],
        output: WorkManagerResult,
    ) -> WorkManagerResult:
        """Normalize work-manager output before returning it to callers.

        Args:
            _ctx: Pydantic AI run context, unused during normalization.
            output: Raw work-manager result generated by the model.

        Returns:
            Normalized work-manager result.
        """
        if output.needs_confirmation and not output.follow_up_question:
            output.follow_up_question = output.message
        if not output.message.strip():
            output.message = "The work manager did not produce a reply."
        return output

    return agent


def _build_repository() -> WorkItemRepository | None:
    """Build the configured work-item repository implementation.

    Returns:
        Firestore-backed work-item repository, or `None` when unavailable.
    """
    if not settings.google_cloud_project:
        return None
    try:
        module = import_module(
            "agents_party.infrastructure.firestore.work_item_repository"
        )
    except ModuleNotFoundError:
        return None

    repository_cls = getattr(module, "FirestoreWorkItemRepository", None)
    if repository_cls is None:
        return None
    return repository_cls(
        project_id=settings.google_cloud_project,
        database=settings.firestore_database,
    )


def _configuration_error_result() -> WorkManagerResult:
    """Return a stable fallback when work-manager dependencies are missing.

    Returns:
        Work-manager result explaining the missing configuration.
    """
    return WorkManagerResult(
        action=WorkManagerAction.NO_OP,
        message=(
            "Work manager is not configured. Set GOOGLE_CLOUD_PROJECT and "
            "WORK_MANAGER_MODEL, then connect the Firestore repository."
        ),
    )


async def run_work_manager(
    invocation: Mapping[str, Any] | WorkManagerInvocation,
    *,
    repository: WorkItemRepository | None = None,
    model: Model | KnownModelName | str | None = None,
) -> WorkManagerResult:
    """Run the work-manager agent for a Slack-originated request.

    Args:
        invocation: Raw or validated work-manager invocation payload.
        repository: Optional repository override used for reads and writes.
        model: Optional model override for this run.

    Returns:
        Structured work-manager result.
    """
    parsed_invocation = (
        invocation
        if isinstance(invocation, WorkManagerInvocation)
        else WorkManagerInvocation.from_mapping(invocation)
    )
    resolved_repository = repository or _build_repository()
    resolved_model = model or settings.work_manager_model
    if resolved_repository is None or resolved_model is None:
        return _configuration_error_result()

    deps = WorkManagerDeps(
        request_context=parsed_invocation.to_request_context(),
        work_item_repository=resolved_repository,
        now=utc_now,
        default_timezone=settings.default_timezone,
    )
    agent = build_work_manager_agent(model=resolved_model)
    result = await agent.run(parsed_invocation.text, deps=deps)
    return result.output


__all__ = [
    "ATTENTION_REVIEW_BUILDER_SECTION",
    "WORK_ITEM_CAPTURE_SECTION",
    "WORK_ITEM_CLARIFIER_SECTION",
    "WorkManagerAction",
    "WorkManagerDeps",
    "WorkManagerInvocation",
    "WorkManagerRequestContext",
    "WorkManagerResult",
    "WorkManagerWorkItem",
    "build_candidates_question",
    "build_created_message",
    "build_list_message",
    "build_updated_message",
    "build_work_manager_agent",
    "build_work_manager_instructions",
    "format_timestamp",
    "format_work_item_brief",
    "run_work_manager",
]
