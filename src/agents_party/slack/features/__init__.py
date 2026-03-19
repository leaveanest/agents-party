from slack_bolt.async_app import AsyncApp

from agents_party.slack.features.onboarding import (
    handle_onboarding_action,
    handle_onboarding_command,
)


def register_feature_handlers(app: AsyncApp) -> None:
    app.command("/agents-party")(handle_onboarding_command)
    app.action("onboarding:start")(handle_onboarding_action)
