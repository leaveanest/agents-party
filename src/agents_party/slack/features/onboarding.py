from typing import Any


def _build_onboarding_message(user_id: str) -> str:
    return (
        f"Hi <@{user_id}>. Agents Party is ready.\n"
        "Next steps:\n"
        "1. Configure Slack secrets in `.env`\n"
        "2. Add your first pydantic-ai agent definition\n"
        "3. Wire Firestore repositories into the agent runner"
    )


async def handle_onboarding_command(ack: Any, command: dict[str, Any], respond: Any) -> None:
    await ack()
    user_id = str(command.get("user_id", ""))
    mention_target = user_id or "there"
    await respond(text=_build_onboarding_message(mention_target))


async def handle_onboarding_action(ack: Any, body: dict[str, Any], respond: Any) -> None:
    await ack()
    user = body.get("user", {})
    user_id = str(user.get("id", ""))
    mention_target = user_id or "there"
    await respond(text=_build_onboarding_message(mention_target))
