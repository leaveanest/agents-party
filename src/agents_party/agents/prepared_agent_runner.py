"""Reusable runner for repository-backed prepared agent pipelines."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Generic, TypeVar

from pydantic import BaseModel
from pydantic_ai import Agent
from pydantic_ai.models import KnownModelName, Model

from agents_party.agents.request_preparation import (
    RequestPreparer,
    resolve_request_preparation,
)

TInvocation = TypeVar("TInvocation", bound=BaseModel)
TPrepared = TypeVar("TPrepared")
TRepository = TypeVar("TRepository")
TDeps = TypeVar("TDeps")
TResult = TypeVar("TResult")

type ResolvedAgentModel = Model | KnownModelName | str
type ConfiguredModelResolver = Callable[[], ResolvedAgentModel | None]
type RepositoryBuilder[TRepository] = Callable[[], TRepository | None]
type DepsBuilder[TInvocation, TRepository, TDeps] = Callable[
    [TInvocation, TRepository],
    TDeps,
]
type ExecutorInputBuilder[TPrepared] = Callable[[TPrepared], str]
type ExecutorAgentBuilder[TDeps, TResult] = Callable[
    [ResolvedAgentModel],
    Agent[TDeps, TResult],
]
type ConfigurationErrorBuilder[TResult] = Callable[[], TResult]
type BuiltinRequestPreparerFactory[TInvocation, TPrepared] = Callable[
    [ResolvedAgentModel],
    RequestPreparer[TInvocation, TPrepared] | None,
]


@dataclass(slots=True)
class RepositoryBackedPreparedAgentRunner(
    Generic[TInvocation, TPrepared, TRepository, TDeps, TResult]
):
    """Run an agent pipeline with shared parsing, preparation, and dependency wiring.

    Attributes:
        invocation_type: Pydantic model used to validate incoming invocation payloads.
        configured_model: Resolver for the default configured model name.
        build_repository: Factory for the default repository dependency.
        default_request_preparer: Default request preparer when no override is supplied.
        build_executor_input: Renderer for the final executor prompt or input text.
        build_executor_agent: Builder for the function-tool-backed executor agent.
        build_deps: Builder for executor dependencies using the invocation and repository.
        configuration_error: Factory returning a stable fallback output when required
            configuration is missing.
        builtin_request_preparer_factory: Optional factory that injects a model-aware
            request preparer when the caller does not provide one.
    """

    invocation_type: type[TInvocation]
    configured_model: ConfiguredModelResolver
    build_repository: RepositoryBuilder[TRepository]
    default_request_preparer: RequestPreparer[TInvocation, TPrepared]
    build_executor_input: ExecutorInputBuilder[TPrepared]
    build_executor_agent: ExecutorAgentBuilder[TDeps, TResult]
    build_deps: DepsBuilder[TInvocation, TRepository, TDeps]
    configuration_error: ConfigurationErrorBuilder[TResult]
    builtin_request_preparer_factory: (
        BuiltinRequestPreparerFactory[TInvocation, TPrepared] | None
    ) = None

    async def run(
        self,
        invocation: Mapping[str, Any] | TInvocation,
        *,
        repository: TRepository | None = None,
        model: ResolvedAgentModel | None = None,
        request_preparer: RequestPreparer[TInvocation, TPrepared] | None = None,
    ) -> TResult:
        """Run the configured prepared-agent pipeline.

        Args:
            invocation: Raw or validated invocation payload for the agent.
            repository: Optional repository override used by the executor.
            model: Optional model override for this run.
            request_preparer: Optional request-preparer override for this run.

        Returns:
            Structured agent output from the executor stage, or the configured
            fallback output when configuration is incomplete.
        """
        parsed_invocation = (
            invocation
            if isinstance(invocation, self.invocation_type)
            else self.invocation_type.model_validate(invocation)
        )
        resolved_repository = repository or self.build_repository()
        resolved_model = model or self.configured_model()
        if resolved_repository is None or resolved_model is None:
            return self.configuration_error()

        resolved_request_preparer = request_preparer
        if (
            resolved_request_preparer is None
            and self.builtin_request_preparer_factory is not None
        ):
            resolved_request_preparer = self.builtin_request_preparer_factory(
                resolved_model
            )

        prepared_request = await resolve_request_preparation(
            parsed_invocation,
            default_preparer=self.default_request_preparer,
            request_preparer=resolved_request_preparer,
        )
        deps = self.build_deps(parsed_invocation, resolved_repository)
        agent = self.build_executor_agent(resolved_model)
        result = await agent.run(
            self.build_executor_input(prepared_request),
            deps=deps,
        )
        return result.output
