from __future__ import annotations

from collections.abc import Callable
from typing import Any

from agents_party.slack.events import register_event_handlers


class StubAsyncApp:
    """Minimal Slack app stub that records registered event handlers."""

    def __init__(self) -> None:
        """Initialize the stub event registry.

        Returns:
            None.
        """
        self.handlers: dict[str, Callable[..., Any]] = {}

    def event(self, name: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """Capture event registrations performed by the application setup.

        Args:
            name: Slack event name being registered.

        Returns:
            Decorator that stores the handler and returns it unchanged.
        """

        def decorator(handler: Callable[..., Any]) -> Callable[..., Any]:
            self.handlers[name] = handler
            return handler

        return decorator


def test_register_event_handlers_wires_slack_assistant_entrypoints() -> None:
    """Verify Slack event wiring includes the assistant conversation entrypoints.

    Returns:
        None.
    """
    app = StubAsyncApp()

    register_event_handlers(app)  # type: ignore[arg-type]

    assert set(app.handlers) == {
        "app_home_opened",
        "app_mention",
        "message",
        "reaction_added",
    }
