"""Slack-facing formatting helpers for the work-manager agent."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .models import WorkManagerWorkItem


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


__all__ = [
    "build_candidates_question",
    "build_created_message",
    "build_list_message",
    "build_updated_message",
    "format_timestamp",
    "format_work_item_brief",
]
