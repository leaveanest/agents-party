from pydantic_ai import Agent

from agents_party.agents.tools.participants import (
    set_my_attention,
    update_participants,
)
from agents_party.agents.tools.queries import (
    find_work_item_candidates,
    list_work_items,
)
from agents_party.agents.tools.work_items import (
    capture_work_item,
    complete_work_item,
    update_work_item_fields,
    update_work_item_status,
)
from agents_party.agents.work_manager import WorkManagerDeps, WorkManagerResult


def register_work_manager_tools(
    agent: Agent[WorkManagerDeps, WorkManagerResult],
) -> None:
    """Register all work-manager tools on an agent instance.

    Args:
        agent: Agent that should expose the work-manager tool functions.

    Returns:
        None.
    """
    agent.tool(capture_work_item)
    agent.tool(list_work_items)
    agent.tool(update_work_item_status)
    agent.tool(update_work_item_fields)
    agent.tool(update_participants)
    agent.tool(set_my_attention)
    agent.tool(complete_work_item)
    agent.tool(find_work_item_candidates)


__all__ = [
    "capture_work_item",
    "complete_work_item",
    "find_work_item_candidates",
    "list_work_items",
    "register_work_manager_tools",
    "set_my_attention",
    "update_participants",
    "update_work_item_fields",
    "update_work_item_status",
]
