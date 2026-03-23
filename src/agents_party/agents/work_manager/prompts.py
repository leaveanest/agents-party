"""Prompt blocks and input rendering helpers for the work-manager agent."""

from __future__ import annotations

from .models import WorkManagerInvocation, WorkManagerPreparedRequest

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


WORK_MANAGER_PREPARER_SCOPE_SECTION = """
You prepare Slack work-item requests before the executor agent mutates repository state.
Use web tools only when they materially improve the request, such as when the user asks for latest or current information,
references an external URL, or needs date/math normalization that benefits from calculation.
Do not invent work item ids, assignees, or repository changes.
"""


WORK_MANAGER_PREPARER_OUTPUT_SECTION = """
Return `original_text` unchanged from the user request.
Set `execution_text` to a concise normalized instruction for the executor agent.
Use `planning_notes` for short factual notes from web research, page fetches, or calculations that the executor should preserve.
If no preparation is needed, keep `execution_text` effectively equivalent to the original request and leave `planning_notes` empty.
"""


def build_work_manager_preparer_instructions() -> tuple[str, ...]:
    """Return instruction blocks for the builtin-tool-backed work-manager preparer.

    Returns:
        Ordered instruction strings fed into the preparer agent.
    """
    return (
        "You are the preparation stage for the Slack work-manager agent.",
        WORK_MANAGER_PREPARER_SCOPE_SECTION.strip(),
        WORK_MANAGER_PREPARER_OUTPUT_SECTION.strip(),
    )


def build_work_manager_preparer_prompt(invocation: WorkManagerInvocation) -> str:
    """Render the request payload consumed by the work-manager preparer agent.

    Args:
        invocation: Validated work-manager invocation to encode.

    Returns:
        Prompt text containing serialized request context for preparation.
    """
    payload = {
        "request_text": invocation.text,
        "team_id": invocation.team_id,
        "channel_id": invocation.channel_id,
        "viewer_context_channel_ids": invocation.viewer_context_channel_ids,
        "thread_ts": invocation.thread_ts,
        "message_ts": invocation.message_ts,
    }
    return (
        "Prepare this Slack work-item request for executor handling.\n"
        "Normalize dates, external references, and derived facts only when useful.\n"
        f"{payload!r}"
    )


def build_work_manager_executor_instructions() -> tuple[str, ...]:
    """Return instruction blocks for the work-manager executor agent.

    Returns:
        Ordered instruction strings fed into the work-manager executor.
    """
    return (
        "You manage Slack-originated work items. Users may say `task`, but the system model is `work item`.",
        "Use the provided tools for all reads and writes. Never invent work item ids, participants, or state changes.",
        "Call `get_time_context` before interpreting relative scheduling phrases such as today, tomorrow, next week, end of day, or local morning/afternoon.",
        "Prefer `capture_work_item` for new tasks, `list_work_items` for inbox or attention views, and explicit update tools for changes.",
        WORK_ITEM_CAPTURE_SECTION.strip(),
        WORK_ITEM_CLARIFIER_SECTION.strip(),
        ATTENTION_REVIEW_BUILDER_SECTION.strip(),
    )


def build_work_manager_instructions() -> tuple[str, ...]:
    """Return the instruction blocks used by the work-manager agent.

    Returns:
        Ordered instruction strings fed into the work-manager executor agent.
    """
    return build_work_manager_executor_instructions()


def build_work_manager_execution_input(
    prepared_request: WorkManagerPreparedRequest,
) -> str:
    """Render the final executor input from a prepared work-manager request.

    Args:
        prepared_request: Prepared request produced by a request-preparer stage.

    Returns:
        Prompt text for the executor agent.
    """
    execution_text = prepared_request.execution_text.strip()
    if not execution_text:
        execution_text = prepared_request.original_text.strip()

    notes = "\n".join(
        f"- {note}" for note in prepared_request.planning_notes if note.strip()
    )
    if not notes:
        return execution_text
    return f"Preparation notes:\n{notes}\n\nUser request:\n{execution_text}"


__all__ = [
    "ATTENTION_REVIEW_BUILDER_SECTION",
    "WORK_ITEM_CAPTURE_SECTION",
    "WORK_ITEM_CLARIFIER_SECTION",
    "build_work_manager_execution_input",
    "build_work_manager_executor_instructions",
    "build_work_manager_instructions",
    "build_work_manager_preparer_instructions",
    "build_work_manager_preparer_prompt",
]
