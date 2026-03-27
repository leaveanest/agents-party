"""Slack interactive feature registration."""

from slack_bolt.async_app import AsyncApp

from agents_party.slack.features.image_generation import (
    IMAGE_GENERATION_ACTION_ID,
    IMAGE_GENERATION_VIEW_CALLBACK_ID,
    handle_image_generation_action,
    handle_image_generation_submission,
)
from agents_party.slack.features.onboarding import (
    handle_onboarding_action,
)
from agents_party.slack.features.video_generation import (
    VIDEO_GENERATION_ACTION_ID,
    VIDEO_GENERATION_VIEW_CALLBACK_ID,
    handle_video_generation_action,
    handle_video_generation_submission,
)


def register_feature_handlers(app: AsyncApp) -> None:
    """Register non-event Slack interaction handlers on the Bolt app.

    Args:
        app: Slack Bolt application that should receive feature handlers.

    Returns:
        None.
    """
    app.action("onboarding:start")(handle_onboarding_action)
    app.action(IMAGE_GENERATION_ACTION_ID)(handle_image_generation_action)
    app.action(VIDEO_GENERATION_ACTION_ID)(handle_video_generation_action)
    app.view(IMAGE_GENERATION_VIEW_CALLBACK_ID)(handle_image_generation_submission)
    app.view(VIDEO_GENERATION_VIEW_CALLBACK_ID)(handle_video_generation_submission)
