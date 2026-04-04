"""Slack App Home agent settings modal handlers and view builders."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from importlib import import_module
from typing import Any, cast

from slack_bolt.context.ack.async_ack import AsyncAck
from slack_sdk.web.async_client import AsyncWebClient

from agents_party.config import settings
from agents_party.domain import AgentDocument
from agents_party.infrastructure.postgres.connection import (
    build_database_engine_from_settings,
)
from agents_party.repositories import SlackAgentRepository

AGENT_SETTINGS_ACTION_ID = "agent_settings:open"
AGENT_SETTINGS_VIEW_CALLBACK_ID = "agent_settings:submit"
_AGENT_SETTINGS_BLOCK_ID = "agent_settings"
_AGENT_SETTINGS_ACTION_SELECT_ID = "agent_settings_selected_agents"


def load_agent_settings_state() -> tuple[list[AgentDocument], bool]:
    """Load the current agent configuration state for App Home surfaces.

    Returns:
        Tuple of stored agent documents and whether settings are available.
    """
    repository = _build_repository()
    if repository is None:
        return [], False
    return repository.list_agents(), True


def build_home_agent_settings_blocks(
    agents: Sequence[AgentDocument],
    *,
    settings_available: bool,
    can_manage_settings: bool,
) -> list[dict[str, Any]]:
    """Build App Home blocks describing agent enablement and settings access.

    Args:
        agents: Agent documents whose enabled states should be shown.
        settings_available: Whether the modal can load and persist changes.
        can_manage_settings: Whether the current viewer may open the settings modal.

    Returns:
        Slack Block Kit blocks appended to the App Home payload.
    """
    if not settings_available:
        summary_text = (
            "*AIエージェント設定*\n"
            "現在はデータベース設定が未接続のため、ホームから変更できません。"
        )
    elif not agents:
        summary_text = (
            "*AIエージェント設定*\n登録済みのAIエージェントがまだありません。"
        )
    else:
        enabled_count = sum(1 for agent in agents if agent.enabled)
        status_lines = [
            f"- *{agent.name}* (`{agent.agent_id}`): "
            f"{'有効' if agent.enabled else '無効'}"
            for agent in agents
        ]
        summary_text = "\n".join(
            [
                "*AIエージェント設定*",
                f"{enabled_count}/{len(agents)} 件のエージェントが有効です。",
                *status_lines,
            ]
        )

    blocks: list[dict[str, Any]] = [
        {"type": "divider"},
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": summary_text,
            },
        },
    ]
    if settings_available and can_manage_settings:
        blocks.append(
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "action_id": AGENT_SETTINGS_ACTION_ID,
                        "text": {
                            "type": "plain_text",
                            "text": "エージェント設定",
                        },
                        "value": "open-agent-settings",
                    }
                ],
            }
        )
    return blocks


async def handle_agent_settings_action(
    ack: AsyncAck,
    body: Mapping[str, Any],
    client: AsyncWebClient,
) -> None:
    """Open the agent settings modal from the App Home action button.

    Args:
        ack: Slack acknowledgement callback for the button action.
        body: Slack action payload containing the trigger id.
        client: Slack client used to open the modal.

    Returns:
        None.
    """
    await ack()
    user_id = str(body.get("user", {}).get("id", "")).strip()
    if not user_id or not await user_can_manage_agent_settings(client, user_id=user_id):
        return

    trigger_id = str(body.get("trigger_id", "")).strip()
    if not trigger_id:
        return

    agents, settings_available = load_agent_settings_state()
    await client.views_open(
        trigger_id=trigger_id,
        view=_build_agent_settings_view(
            agents,
            settings_available=settings_available,
        ),
    )


async def handle_agent_settings_submission(
    ack: AsyncAck,
    body: Mapping[str, Any],
    client: AsyncWebClient,
) -> None:
    """Persist modal selections and refresh the App Home summary.

    Args:
        ack: Slack acknowledgement callback for the view submission.
        body: Slack view submission payload containing selected agent ids.
        client: Slack client used to republish the App Home view.

    Returns:
        None.
    """
    user = body.get("user", {})
    user_id = str(user.get("id", "")).strip()
    if not user_id or not await user_can_manage_agent_settings(client, user_id=user_id):
        await ack()
        return

    await ack()

    repository = _build_repository()
    if repository is None:
        return

    updated_agents = repository.set_enabled_agents(
        agent_ids=_read_selected_agent_ids(body),
    )
    from agents_party.slack.events.app_home_opened import _build_home_view

    await client.views_publish(
        user_id=user_id,
        view=_build_home_view(
            agents=updated_agents,
            settings_available=True,
            can_manage_settings=True,
        ),
    )


async def user_can_manage_agent_settings(
    client: AsyncWebClient,
    *,
    user_id: str,
) -> bool:
    """Return whether the Slack user may manage global agent settings.

    Args:
        client: Slack Web API client used to load the user object.
        user_id: Slack user id whose workspace role should be checked.

    Returns:
        `True` when the user is a workspace admin or owner.
    """
    try:
        response = await client.users_info(user=user_id)
    except Exception:
        return False

    user = response.get("user", {})
    return bool(
        user.get("is_admin") or user.get("is_owner") or user.get("is_primary_owner")
    )


def _build_agent_settings_view(
    agents: Sequence[AgentDocument],
    *,
    settings_available: bool,
) -> dict[str, Any]:
    """Build the Slack modal payload for toggling agent enablement.

    Args:
        agents: Agent documents whose enabled states should be editable.
        settings_available: Whether the modal can present editable controls.

    Returns:
        Slack modal payload for the agent settings flow.
    """
    if not settings_available:
        return {
            "type": "modal",
            "title": {
                "type": "plain_text",
                "text": "Agent settings",
            },
            "close": {
                "type": "plain_text",
                "text": "Close",
            },
            "blocks": [
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": (
                            "エージェント設定は現在利用できません。"
                            "データベース接続を確認してください。"
                        ),
                    },
                }
            ],
        }

    if not agents:
        return {
            "type": "modal",
            "title": {
                "type": "plain_text",
                "text": "Agent settings",
            },
            "close": {
                "type": "plain_text",
                "text": "Close",
            },
            "blocks": [
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": "登録済みのAIエージェントがまだありません。",
                    },
                }
            ],
        }

    enabled_options = [_build_agent_option(agent) for agent in agents if agent.enabled]
    return {
        "type": "modal",
        "callback_id": AGENT_SETTINGS_VIEW_CALLBACK_ID,
        "title": {
            "type": "plain_text",
            "text": "Agent settings",
        },
        "submit": {
            "type": "plain_text",
            "text": "Save",
        },
        "close": {
            "type": "plain_text",
            "text": "Cancel",
        },
        "blocks": [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "ホームで利用できるAIエージェントを選択してください。",
                },
            },
            {
                "type": "input",
                "block_id": _AGENT_SETTINGS_BLOCK_ID,
                "optional": True,
                "label": {
                    "type": "plain_text",
                    "text": "有効にするエージェント",
                },
                "element": {
                    "type": "checkboxes",
                    "action_id": _AGENT_SETTINGS_ACTION_SELECT_ID,
                    "options": [_build_agent_option(agent) for agent in agents],
                    "initial_options": enabled_options,
                },
            },
        ],
    }


def _read_selected_agent_ids(body: Mapping[str, Any]) -> list[str]:
    """Extract selected agent ids from a submitted Slack modal payload.

    Args:
        body: Slack view submission payload containing checkbox state.

    Returns:
        Selected agent ids in submission order.
    """
    view = body.get("view", {})
    state = view.get("state", {})
    values = state.get("values", {})
    block_state = values.get(_AGENT_SETTINGS_BLOCK_ID, {})
    selection_state = block_state.get(_AGENT_SETTINGS_ACTION_SELECT_ID, {})
    selected_options = selection_state.get("selected_options", [])
    return [
        str(option.get("value", "")).strip()
        for option in selected_options
        if str(option.get("value", "")).strip()
    ]


def _build_agent_option(agent: AgentDocument) -> dict[str, Any]:
    """Build a Slack checkbox option for a stored agent definition.

    Args:
        agent: Stored agent definition shown in the modal.

    Returns:
        Slack checkbox option payload for the agent.
    """
    return {
        "text": {
            "type": "plain_text",
            "text": agent.name[:75],
        },
        "description": {
            "type": "plain_text",
            "text": agent.agent_id[:75],
        },
        "value": agent.agent_id,
    }


def _build_repository() -> SlackAgentRepository | None:
    """Instantiate the Slack agent repository from configured PostgreSQL settings.

    Returns:
        PostgreSQL-backed Slack agent repository, or `None` when unavailable.
    """
    if not settings.database_enabled:
        return None
    try:
        module = import_module(
            "agents_party.infrastructure.postgres.slack_agent_repository"
        )
    except ModuleNotFoundError:
        return None

    repository_cls = getattr(module, "PostgresSlackAgentRepository", None)
    if repository_cls is None:
        return None

    return cast(
        SlackAgentRepository,
        repository_cls(engine=build_database_engine_from_settings(settings)),
    )


__all__ = [
    "AGENT_SETTINGS_ACTION_ID",
    "AGENT_SETTINGS_VIEW_CALLBACK_ID",
    "build_home_agent_settings_blocks",
    "handle_agent_settings_action",
    "handle_agent_settings_submission",
    "load_agent_settings_state",
]
