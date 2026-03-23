from collections.abc import Mapping
from typing import Any

from slack_bolt.context.async_context import AsyncBoltContext

from agents_party.slack.features.agent_routing import (
    SayResponder,
    SlackConversationsClient,
    handle_agent_message,
)


async def handle_message(
    body: Mapping[str, Any],
    event: Mapping[str, Any],
    say: SayResponder,
    client: SlackConversationsClient,
    context: AsyncBoltContext,
) -> None:
    """Route Slack follow-up `message` events into the thread message handler.

    Args:
        body: Full Slack request payload.
        event: Nested Slack event payload for the message.
        say: Slack responder used by the routing handler.
        client: Slack client used to fetch full thread history.
        context: Slack Bolt context containing the app bot user id.

    Returns:
        None.
    """
    await handle_agent_message(
        body,
        event,
        say,
        client,
        bot_user_id=context.bot_user_id,
    )
