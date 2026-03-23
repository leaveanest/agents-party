"""Preparer-stage helpers for the work-manager agent."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from pydantic_ai import Agent, CodeExecutionTool, WebFetchTool, WebSearchTool
from pydantic_ai.models import KnownModelName, Model
from pydantic_ai.output import PromptedOutput

from .models import WorkManagerInvocation, WorkManagerPreparedRequest
from .prompts import (
    build_work_manager_preparer_instructions,
    build_work_manager_preparer_prompt,
)
from agents_party.config import settings


def build_work_manager_preparer_agent(
    model: Model | KnownModelName | str | None = None,
) -> Agent[None, WorkManagerPreparedRequest]:
    """Build the builtin-tool-backed work-manager preparer agent.

    Args:
        model: Optional model override for the work-manager preparer agent.

    Returns:
        Configured work-manager preparer agent.

    Raises:
        ValueError: If no model can be resolved for the preparer stage.
    """
    resolved_model = model or settings.work_manager_model
    if resolved_model is None:
        raise ValueError(
            "Work manager model is not configured. Set WORK_MANAGER_MODEL or pass a model explicitly."
        )

    return cast(
        Agent[None, WorkManagerPreparedRequest],
        Agent(
            resolved_model,
            name="work_manager_preparer",
            deps_type=type(None),
            output_type=PromptedOutput(WorkManagerPreparedRequest),
            instructions=build_work_manager_preparer_instructions(),
            builtin_tools=[
                WebSearchTool(),
                CodeExecutionTool(),
                WebFetchTool(),
            ],
            defer_model_check=True,
        ),
    )


async def prepare_work_manager_request(
    invocation: WorkManagerInvocation,
) -> WorkManagerPreparedRequest:
    """Prepare work-manager input for the executor agent.

    Args:
        invocation: Validated work-manager invocation.

    Returns:
        Prepared work-manager request ready for executor execution.
    """
    return WorkManagerPreparedRequest(
        original_text=invocation.text,
        execution_text=invocation.text,
    )


async def run_work_manager_preparer(
    invocation: Mapping[str, Any] | WorkManagerInvocation,
    *,
    model: Model | KnownModelName | str | None = None,
) -> WorkManagerPreparedRequest:
    """Run the builtin-tool-backed work-manager preparer stage.

    Args:
        invocation: Raw or validated work-manager invocation payload.
        model: Optional model override for the preparer stage.

    Returns:
        Prepared work-manager request for executor execution.
    """
    parsed_invocation = (
        invocation
        if isinstance(invocation, WorkManagerInvocation)
        else WorkManagerInvocation.from_mapping(invocation)
    )
    agent = build_work_manager_preparer_agent(model=model)
    result = await agent.run(build_work_manager_preparer_prompt(parsed_invocation))
    return result.output


__all__ = [
    "build_work_manager_preparer_agent",
    "prepare_work_manager_request",
    "run_work_manager_preparer",
]
