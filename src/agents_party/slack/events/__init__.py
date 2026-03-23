from slack_bolt.async_app import AsyncApp

from agents_party.slack.events.app_home_opened import (
    handle_app_home_opened,
)
from agents_party.slack.events.message import (
    handle_message,
)


def register_event_handlers(app: AsyncApp) -> None:
    """Register Slack event handlers on the Bolt app.

    Args:
        app: Slack Bolt application that should receive event handlers.

    Returns:
        None.
    """
    app.event("app_home_opened")(handle_app_home_opened)
    app.event("message")(handle_message)
