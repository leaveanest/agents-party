from typing import Any

def _build_home_view() -> dict[str, Any]:
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
                    "text": "Use `/agents-party` to launch the app from Slack.",
                },
            },
        ],
    }



async def handle_app_home_opened(event: dict[str, Any], say: Any) -> None:
    user_id = event.get("user")
    if not user_id:
        say("app_home_opened event did not include a user id")
        return

    await say(view=_build_home_view())
