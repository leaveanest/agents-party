from collections.abc import Mapping
from typing import Any

from agents_party.slack.features.agent_routing import (
    SlackConversationsClient,
    handle_translation_reaction,
)


async def handle_reaction_added(
    body: Mapping[str, Any],
    event: Mapping[str, Any],
    client: SlackConversationsClient,
) -> None:
    """Route Slack `reaction_added` events into the translation reaction handler.

    Args:
        body: Full Slack request payload.
        event: Nested Slack event payload for the reaction.
        client: Slack client used to read the target message and post replies.

    Returns:
        None.
    """
    await handle_translation_reaction(body, event, client)
