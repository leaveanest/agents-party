from collections.abc import Mapping
from typing import Any

from agents_party.slack.features.agent_routing import (
    SayResponder,
    handle_agent_mention,
)


async def handle_app_mention(
    body: Mapping[str, Any],
    event: Mapping[str, Any],
    say: SayResponder,
) -> None:
    """Route `app_mention` events into the agent mention handler.

    Args:
        body: Full Slack request payload.
        event: Nested Slack event payload for the mention.
        say: Slack responder used by the routing handler.

    Returns:
        None.
    """
    await handle_agent_mention(body, event, say)
