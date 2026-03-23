from __future__ import annotations

from typing import Protocol

from agents_party.domain import AgentDocument, ResolvedAgentRoute, ThreadDocument


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

    def get_thread_document(
        self,
        *,
        team_id: str,
        channel_id: str,
        thread_ts: str,
    ) -> ThreadDocument | None:
        """Return the stored Slack thread document for a conversation.

        Args:
            team_id: Slack workspace id owning the conversation.
            channel_id: Slack channel id where the thread lives.
            thread_ts: Thread timestamp identifying the Slack thread.

        Returns:
            Stored thread document, or `None` when the thread has no saved state.
        """

        ...

    def activate_thread_agent(
        self,
        *,
        team_id: str,
        channel_id: str,
        thread_ts: str,
        agent_id: str,
        root_message_ts: str,
        last_message_ts: str,
    ) -> ThreadDocument:
        """Persist the active routed agent for a Slack thread.

        Args:
            team_id: Slack workspace id owning the conversation.
            channel_id: Slack channel id where the thread lives.
            thread_ts: Thread timestamp identifying the Slack thread.
            agent_id: Agent id that successfully handled the thread.
            root_message_ts: Root Slack message timestamp for the thread.
            last_message_ts: Latest Slack message timestamp included in execution.

        Returns:
            Persisted thread document containing the active routing state.
        """

        ...

    def is_thread_auto_reply_enabled(
        self,
        *,
        team_id: str,
        channel_id: str,
    ) -> bool:
        """Return whether follow-up thread replies should auto-route.

        Args:
            team_id: Slack workspace id owning the conversation.
            channel_id: Slack channel id where the thread lives.

        Returns:
            `True` when follow-up thread replies should trigger auto-routing.
        """

        ...


__all__ = ["SlackAgentRepository"]
