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
                    "text": "Mention the app in a channel or thread to talk to the configured agent.",
                },
            },
        ],
    }


async def handle_app_home_opened(event: dict[str, Any], say: Any) -> None:
    """Publish the App Home view when Slack opens the app home.

    Args:
        event: Slack event payload for the `app_home_opened` event.
        say: Slack responder used to publish the home view or an error message.

    Returns:
        None.
    """
    user_id = event.get("user")
    if not user_id:
        say("app_home_opened event did not include a user id")
        return

    await say(view=_build_home_view())
