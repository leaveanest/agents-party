"""Tests for shared Slack runtime models."""

from __future__ import annotations

from agents_party.agents.slack_runtime import SlackAgentInvocation
from agents_party.domain import MessageRole


def test_slack_agent_invocation_validates_thread_messages() -> None:
    """Verify Slack invocation payloads validate nested thread transcript messages.

    Returns:
        None.
    """
    invocation = SlackAgentInvocation.model_validate(
        {
            "team_id": "T1",
            "user_id": "U1",
            "channel_id": "C123",
            "viewer_context_channel_ids": ["C123"],
            "text": "follow up with finance",
            "thread_ts": "1712345678.000100",
            "message_ts": "1712345678.000100",
            "thread_messages": [
                {
                    "ts": "1712345678.000100",
                    "role": "user",
                    "text": "follow up with finance",
                    "user_id": "U1",
                }
            ],
        }
    )

    assert invocation.thread_messages[0].role == MessageRole.USER
