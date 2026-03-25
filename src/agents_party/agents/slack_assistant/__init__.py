"""Public API for the Slack assistant package."""

from .models import (
    SlackAssistantAction,
    SlackAssistantDeps,
    SlackAssistantResult,
)
from .runtime import (
    build_slack_assistant_agent,
    build_slack_assistant_instructions,
    build_slack_assistant_prompt,
    run_slack_assistant,
)

__all__ = [
    "SlackAssistantAction",
    "SlackAssistantDeps",
    "SlackAssistantResult",
    "build_slack_assistant_agent",
    "build_slack_assistant_instructions",
    "build_slack_assistant_prompt",
    "run_slack_assistant",
]
