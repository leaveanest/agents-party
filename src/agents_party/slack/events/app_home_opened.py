"""Slack App Home event handlers."""

from typing import Any


def _build_home_view() -> dict[str, Any]:
    """Build the App Home view payload shown to Slack users.

    Returns:
        Slack Block Kit view payload for the App Home surface.
    """
    return {
        "type": "home",
        "blocks": [
            {
                "type": "header",
                "text": {
                    "type": "plain_text",
                    "text": "Agents Party",
                },
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "Mention the app in a channel or thread to talk to the assistant.",
                },
            },
        ],
    }


async def handle_app_home_opened(event: dict[str, Any], client: Any) -> None:
    """Publish the App Home view when Slack opens the app home.

    Args:
        event: Slack event payload for the `app_home_opened` event.
        client: Slack client used to publish the App Home view.

    Returns:
        None.
    """
    user_id = event.get("user")
    if not user_id:
        return

    await client.views_publish(user_id=str(user_id), view=_build_home_view())
