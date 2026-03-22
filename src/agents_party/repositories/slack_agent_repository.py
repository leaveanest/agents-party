from __future__ import annotations

from typing import Protocol

from agents_party.domain import AgentDocument, ResolvedAgentRoute


class SlackAgentRepository(Protocol):
    """Repository boundary for Slack agent routing and candidate lookup."""

    def resolve_agent(
        self,
        *,
        team_id: str,
        channel_id: str,
        thread_ts: str | None = None,
    ) -> ResolvedAgentRoute | None:
        """Return the configured agent route for a Slack context.

        Args:
            team_id: Slack workspace id owning the conversation.
            channel_id: Slack channel id where the request was made.
            thread_ts: Optional thread timestamp for thread-specific routing.

        Returns:
            Resolved configured route, or `None` when nothing is configured.
        """

        ...

    def list_enabled_agents(
        self,
        *,
        team_id: str,
        channel_id: str,
        thread_ts: str | None = None,
    ) -> list[AgentDocument]:
        """List enabled agents that can be used as selector fallback.

        Args:
            team_id: Slack workspace id owning the conversation.
            channel_id: Slack channel id where the request was made.
            thread_ts: Optional thread timestamp for future thread-aware filtering.

        Returns:
            Enabled agents that are eligible in the supplied context.
        """

        ...


__all__ = ["SlackAgentRepository"]
