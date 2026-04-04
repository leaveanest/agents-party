"""Slack App Home event handlers."""

from collections.abc import Sequence
from typing import Any

from slack_sdk.web.async_client import AsyncWebClient

from agents_party.domain import AgentDocument
from agents_party.slack.features.agent_settings import (
    build_home_agent_settings_blocks,
    load_agent_settings_state,
    user_can_manage_agent_settings,
)


def _build_home_view(
    *,
    agents: Sequence[AgentDocument] = (),
    settings_available: bool = False,
    can_manage_settings: bool = False,
) -> dict[str, Any]:
    """Build the App Home view payload shown to Slack users.

    Args:
        agents: Agent documents whose enablement should be summarized.
        settings_available: Whether App Home can open the settings modal.
        can_manage_settings: Whether the viewing user may open the settings modal.

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
            *build_home_agent_settings_blocks(
                agents,
                settings_available=settings_available,
                can_manage_settings=can_manage_settings,
            ),
        ],
    }


async def handle_app_home_opened(
    event: dict[str, Any],
    client: AsyncWebClient,
) -> None:
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

    agents, settings_available = load_agent_settings_state()
    can_manage_settings = (
        await user_can_manage_agent_settings(client, user_id=str(user_id))
        if settings_available
        else False
    )
    await client.views_publish(
        user_id=str(user_id),
        view=_build_home_view(
            agents=agents,
            settings_available=settings_available,
            can_manage_settings=can_manage_settings,
        ),
    )
