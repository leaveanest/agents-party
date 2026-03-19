from typing import Any


async def handle_app_mention(event: dict[str, Any], say: Any) -> None:
    user_id = str(event.get("user", ""))
    mention = f"<@{user_id}>" if user_id else "there"
    await say(text=f"{mention} agents-party is online. Use `/agents-party` to start.")
