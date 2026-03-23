"""Repository and model runtime wiring for the work-manager agent."""

from __future__ import annotations

from collections.abc import Mapping
from importlib import import_module
from typing import Any

from pydantic_ai.models import KnownModelName, Model

from agents_party.agents.prepared_agent_runner import (
    RepositoryBackedPreparedAgentRunner,
    ResolvedAgentModel,
)
from .executor import (
    build_work_manager_agent,
    build_work_manager_executor_agent,
)
from .models import (
    WorkManagerAction,
    WorkManagerDeps,
    WorkManagerInvocation,
    WorkManagerPreparedRequest,
    WorkManagerRequestPreparer,
    WorkManagerResult,
)
from .preparer import (
    build_work_manager_preparer_agent,
    prepare_work_manager_request,
    run_work_manager_preparer,
)
from .prompts import build_work_manager_execution_input
from agents_party.config import settings
from agents_party.domain import utc_now
from agents_party.repositories import WorkItemRepository


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


def _should_use_builtin_work_manager_preparer(
    model: ResolvedAgentModel | None,
) -> bool:
    """Return whether the default builtin-tool preparer should run for a model.

    Args:
        model: Resolved model used for the work-manager pipeline.

    Returns:
        `True` when the model naming indicates a Google Gemini path that should use
        the builtin-tool preparer by default.
    """
    if not isinstance(model, str):
        return False

    normalized = model.casefold()
    return normalized.startswith(
        (
            "google-gla:",
            "google-vertex:",
            "gateway/gemini:",
            "gateway/google-vertex:",
        )
    )


def _configured_work_manager_model() -> ResolvedAgentModel | None:
    """Return the configured default model for the work-manager runtime.

    Returns:
        Provider-qualified default model string, or `None` when unconfigured.
    """
    return settings.work_manager_model


def _build_work_manager_deps(
    invocation: WorkManagerInvocation,
    repository: WorkItemRepository,
) -> WorkManagerDeps:
    """Build executor dependencies for a work-manager run.

    Args:
        invocation: Validated work-manager invocation for the current run.
        repository: Repository used for work-item reads and writes.

    Returns:
        Dependency bundle for the work-manager executor agent.
    """
    return WorkManagerDeps(
        request_context=invocation.to_request_context(),
        work_item_repository=repository,
        now=utc_now,
        default_timezone=settings.default_timezone,
    )


def _build_builtin_work_manager_request_preparer(
    model: ResolvedAgentModel,
) -> WorkManagerRequestPreparer | None:
    """Build the default model-aware preparer used by the work-manager runtime.

    Args:
        model: Resolved model selected for the current work-manager run.

    Returns:
        Builtin-tool-backed preparer for Google Gemini paths, or `None` when the
        default plain preparer should be used instead.
    """
    if not _should_use_builtin_work_manager_preparer(model):
        return None

    async def builtin_request_preparer(
        prepared_invocation: WorkManagerInvocation,
    ) -> WorkManagerPreparedRequest:
        """Run the default builtin-tool preparer for Google Gemini models.

        Args:
            prepared_invocation: Validated work-manager invocation.

        Returns:
            Prepared request from the builtin-tool-backed preparer stage.
        """
        prepared_request = await run_work_manager_preparer(
            prepared_invocation,
            model=model,
        )
        prepared_request.thread_messages = list(prepared_invocation.thread_messages)
        return prepared_request

    return builtin_request_preparer


def _build_work_manager_runner() -> RepositoryBackedPreparedAgentRunner[
    WorkManagerInvocation,
    WorkManagerPreparedRequest,
    WorkItemRepository,
    WorkManagerDeps,
    WorkManagerResult,
]:
    """Build the shared runner used by the work-manager runtime.

    Returns:
        Repository-backed prepared-agent runner configured for work-manager.
    """
    return RepositoryBackedPreparedAgentRunner[
        WorkManagerInvocation,
        WorkManagerPreparedRequest,
        WorkItemRepository,
        WorkManagerDeps,
        WorkManagerResult,
    ](
        invocation_type=WorkManagerInvocation,
        configured_model=_configured_work_manager_model,
        build_repository=_build_repository,
        default_request_preparer=prepare_work_manager_request,
        build_executor_input=build_work_manager_execution_input,
        build_executor_agent=build_work_manager_executor_agent,
        build_deps=_build_work_manager_deps,
        configuration_error=_configuration_error_result,
        builtin_request_preparer_factory=_build_builtin_work_manager_request_preparer,
    )


async def run_work_manager(
    invocation: Mapping[str, Any] | WorkManagerInvocation,
    *,
    repository: WorkItemRepository | None = None,
    model: Model | KnownModelName | str | None = None,
    request_preparer: WorkManagerRequestPreparer | None = None,
) -> WorkManagerResult:
    """Run the work-manager agent for a Slack-originated request.

    Args:
        invocation: Raw or validated work-manager invocation payload.
        repository: Optional repository override used for reads and writes.
        model: Optional model override for this run.
        request_preparer: Optional hook that prepares executor input before the
            function-tool-backed executor agent runs. This is the intended
            integration point for future built-in-tool or research-assisted stages.

    Returns:
        Structured work-manager result.
    """
    return await _build_work_manager_runner().run(
        invocation,
        repository=repository,
        model=model,
        request_preparer=request_preparer,
    )


__all__ = [
    "build_work_manager_agent",
    "build_work_manager_executor_agent",
    "build_work_manager_preparer_agent",
    "prepare_work_manager_request",
    "run_work_manager",
    "run_work_manager_preparer",
]
