from collections.abc import Mapping
from typing import Any

from agents_party.slack.features.agent_routing import (
    SayResponder,
    SlackConversationsClient,
    handle_agent_mention,
)


async def handle_app_mention(
    body: Mapping[str, Any],
    event: Mapping[str, Any],
    say: SayResponder,
    client: SlackConversationsClient,
) -> None:
    """Route Slack `app_mention` events into the assistant mention handler.

    Args:
        body: Full Slack request payload.
        event: Nested Slack event payload for the app mention.
        say: Slack responder used by the routing handler.
        client: Slack client used to fetch full thread history.

    Returns:
        None.
    """
    await handle_agent_mention(body, event, say, client)
