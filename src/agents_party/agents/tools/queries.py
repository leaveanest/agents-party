from __future__ import annotations

from datetime import datetime

from pydantic_ai import RunContext

from agents_party.agents.tools.common import now, summaries
from agents_party.agents.work_manager import (
    WorkManagerAction,
    WorkManagerDeps,
    WorkManagerResult,
    build_candidates_question,
    build_list_message,
)
from agents_party.domain import (
    VisibilityPolicyKind,
    WorkItemQuery,
    WorkItemQueryView,
    WorkItemStatus,
)


def list_work_items(
    ctx: RunContext[WorkManagerDeps],
    view: WorkItemQueryView = WorkItemQueryView.INBOX,
    status: list[WorkItemStatus] | None = None,
    visibility_kind: VisibilityPolicyKind | None = None,
    participant_user_id: str | None = None,
    audience_channel_id: str | None = None,
    text_query: str | None = None,
    due_before: datetime | None = None,
    needs_attention_only: bool = False,
    include_completed: bool = False,
    limit: int | None = None,
) -> WorkManagerResult:
    """List work items visible to the current viewer.

    Args:
        ctx: Tool execution context carrying work-manager dependencies.
        view: Predefined view to query.
        status: Optional status filter applied on top of the view.
        visibility_kind: Optional visibility filter.
        participant_user_id: Optional participant user id filter.
        audience_channel_id: Optional audience channel filter.
        text_query: Optional free-text filter over title, description, and tags.
        due_before: Optional upper bound for due dates.
        needs_attention_only: Whether to keep only items needing attention now.
        include_completed: Whether completed items should remain in the result set.
        limit: Optional maximum number of items to return.

    Returns:
        Work-manager result containing summarized matching work items.
    """

    request_context = ctx.deps.request_context
    effective_limit = min(limit or ctx.deps.max_list_size, ctx.deps.max_list_size)
    query = WorkItemQuery(
        team_id=request_context.team_id,
        viewer_user_id=request_context.user_id,
        viewer_channel_id=request_context.channel_id,
        viewer_context_channel_ids=request_context.viewer_context_channel_ids,
        view=view,
        status_in=status or [],
        visibility_kind=visibility_kind,
        participant_user_id=participant_user_id,
        audience_channel_id=audience_channel_id,
        text_query=text_query,
        due_before=due_before,
        needs_attention_only=needs_attention_only,
        include_completed=include_completed,
        limit=effective_limit,
    )
    current_time = now(ctx)
    items = summaries(
        ctx.deps.work_item_repository.list_work_items(query), current_time=current_time
    )
    return WorkManagerResult(
        action=WorkManagerAction.LISTED,
        message=build_list_message(
            items,
            timezone_name=ctx.deps.default_timezone,
            title=view.value.replace("_", " "),
        ),
        work_items=items,
    )


def find_work_item_candidates(
    ctx: RunContext[WorkManagerDeps],
    text_query: str,
    participant_user_id: str | None = None,
    status: list[WorkItemStatus] | None = None,
    audience_channel_id: str | None = None,
    limit: int | None = None,
) -> WorkManagerResult:
    """Find likely work-item matches for ambiguous user references.

    Args:
        ctx: Tool execution context carrying work-manager dependencies.
        text_query: Free-text query used to find likely matches.
        participant_user_id: Optional participant user id filter.
        status: Optional status filter.
        audience_channel_id: Optional audience channel filter.
        limit: Optional maximum number of candidates to inspect.

    Returns:
        Work-manager result listing candidates or asking a clarification question.
    """

    request_context = ctx.deps.request_context
    effective_limit = min(limit or 5, ctx.deps.max_list_size)
    query = WorkItemQuery(
        team_id=request_context.team_id,
        viewer_user_id=request_context.user_id,
        viewer_channel_id=request_context.channel_id,
        viewer_context_channel_ids=request_context.viewer_context_channel_ids,
        view=WorkItemQueryView.INBOX,
        status_in=status or [],
        participant_user_id=participant_user_id,
        audience_channel_id=audience_channel_id,
        text_query=text_query,
        limit=effective_limit,
    )
    current_time = now(ctx)
    items = summaries(
        ctx.deps.work_item_repository.list_work_items(query), current_time=current_time
    )
    if len(items) <= 1:
        return WorkManagerResult(
            action=WorkManagerAction.LISTED if items else WorkManagerAction.NO_OP,
            message=build_list_message(
                items,
                timezone_name=ctx.deps.default_timezone,
                title="candidate tasks",
            ),
            work_items=items,
        )
    question = build_candidates_question(
        items,
        timezone_name=ctx.deps.default_timezone,
    )
    return WorkManagerResult(
        action=WorkManagerAction.CLARIFICATION_NEEDED,
        message=question,
        work_items=items,
        needs_confirmation=True,
        follow_up_question=question,
    )


__all__ = [
    "find_work_item_candidates",
    "list_work_items",
]
