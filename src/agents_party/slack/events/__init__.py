from slack_bolt.async_app import AsyncApp

from agents_party.slack.events.app_home_opened import (
    handle_app_home_opened,
)
from agents_party.slack.events.app_mentioned import (
    handle_app_mention,
)


def register_event_handlers(app: AsyncApp) -> None:
    app.event("app_home_opened")(handle_app_home_opened)
    app.event("app_mention")(handle_app_mention)
