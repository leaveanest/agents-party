"""Shared helpers for agent request-preparation hooks."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from inspect import isawaitable
from typing import TypeVar, cast

TInvocation = TypeVar("TInvocation")
TPrepared = TypeVar("TPrepared")

type RequestPreparer[TInvocation, TPrepared] = Callable[
    [TInvocation],
    TPrepared | Awaitable[TPrepared],
]


async def resolve_request_preparation(
    invocation: TInvocation,
    *,
    default_preparer: RequestPreparer[TInvocation, TPrepared],
    request_preparer: RequestPreparer[TInvocation, TPrepared] | None = None,
) -> TPrepared:
    """Run a request-preparer hook and await it when necessary.

    Args:
        invocation: Validated invocation passed into the preparer.
        default_preparer: Default preparer used when no override is supplied.
        request_preparer: Optional override hook for request preparation.

    Returns:
        Prepared request payload for downstream agent execution.
    """
    preparer = request_preparer or default_preparer
    prepared_request = preparer(invocation)
    if isawaitable(prepared_request):
        return await cast(Awaitable[TPrepared], prepared_request)
    return cast(TPrepared, prepared_request)
