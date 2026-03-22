from slack_bolt.async_app import AsyncApp

from agents_party.slack.features.onboarding import (
    handle_onboarding_action,
)


def register_feature_handlers(app: AsyncApp) -> None:
    """Register non-event Slack interaction handlers on the Bolt app.

    Args:
        app: Slack Bolt application that should receive feature handlers.

    Returns:
        None.
    """
    app.action("onboarding:start")(handle_onboarding_action)
