"""Slack onboarding action handlers and setup messaging."""

from typing import Any


def _build_onboarding_message(user_id: str) -> str:
    """Build the onboarding text shown after the onboarding action.

    Args:
        user_id: Slack user id or fallback mention target.

    Returns:
        Plain-text onboarding message.
    """
    return (
        f"Hi <@{user_id}>. Agents Party is ready.\n"
        "Next steps:\n"
        "1. Configure Slack secrets in `.env`\n"
        "2. Add your first pydantic-ai agent definition\n"
        "3. Apply Alembic migrations and wire PostgreSQL repositories into the agent runner"
    )


async def handle_onboarding_action(
    ack: Any, body: dict[str, Any], respond: Any
) -> None:
    """Acknowledge the onboarding action and send setup guidance.

    Args:
        ack: Slack acknowledgement callback for the action payload.
        body: Slack action payload containing the acting user.
        respond: Slack responder used to post the onboarding message.

    Returns:
        None.
    """
    await ack()
    user = body.get("user", {})
    user_id = str(user.get("id", ""))
    mention_target = user_id or "there"
    await respond(text=_build_onboarding_message(mention_target))
