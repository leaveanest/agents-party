from __future__ import annotations

from typing import Any, TypeVar, cast

from google.cloud import firestore
from pydantic import BaseModel

from agents_party.domain import (
    AgentDocument,
    ChannelAppSettingsDocument,
    ResolvedAgentRoute,
    ThreadDocument,
    WorkspaceAppSettingsDocument,
    resolve_agent_id_for_slack_context,
)


DocumentT = TypeVar("DocumentT", bound=BaseModel)


class FirestoreSlackAgentRepository:
    """Firestore-backed repository for Slack agent routing settings."""

    def __init__(
        self,
        *,
        project_id: str | None = None,
        database: str = "(default)",
        client: Any | None = None,
    ) -> None:
        """Create a repository with either an injected client or a new Firestore client.

        Args:
            project_id: Optional Google Cloud project id for Firestore client creation.
            database: Firestore database name to connect to.
            client: Optional injected Firestore-compatible client for tests or overrides.

        Returns:
            None.
        """
        self._client = client or firestore.Client(
            project=project_id,
            database=database,
        )

    def resolve_agent(
        self,
        *,
        team_id: str,
        channel_id: str,
        thread_ts: str | None = None,
    ) -> ResolvedAgentRoute | None:
        """Resolve a configured agent using thread, channel, then workspace settings.

        Args:
            team_id: Slack workspace id owning the conversation.
            channel_id: Slack channel id where the request was made.
            thread_ts: Optional thread timestamp for thread-level routing.

        Returns:
            Resolved route containing the enabled agent, or `None` when none applies.
        """
        workspace_settings = self._read_model(
            self._workspace_settings_ref(team_id),
            WorkspaceAppSettingsDocument,
        )
        if (
            workspace_settings is not None
            and workspace_settings.enabled_channel_ids
            and channel_id not in workspace_settings.enabled_channel_ids
        ):
            return None

        channel_settings = self._read_model(
            self._channel_settings_ref(team_id, channel_id),
            ChannelAppSettingsDocument,
        )
        thread = (
            self._read_model(
                self._thread_ref(team_id, channel_id, thread_ts), ThreadDocument
            )
            if thread_ts is not None
            else None
        )

        agent_id, scope = resolve_agent_id_for_slack_context(
            thread_agent_id=thread.agent_id if thread is not None else None,
            channel_agent_id=(
                channel_settings.default_agent_id
                if channel_settings is not None
                else None
            ),
            workspace_agent_id=(
                workspace_settings.default_agent_id
                if workspace_settings is not None
                else None
            ),
        )
        if agent_id is None or scope is None:
            return None

        agent = self._read_model(self._agent_ref(agent_id), AgentDocument)
        if agent is None or not agent.enabled:
            return None

        return ResolvedAgentRoute(
            scope=scope,
            agent=agent,
            team_id=team_id,
            channel_id=channel_id,
            thread_ts=thread_ts,
        )

    def list_enabled_agents(
        self,
        *,
        team_id: str,
        channel_id: str,
        thread_ts: str | None = None,
    ) -> list[AgentDocument]:
        """Return enabled agent documents available for selector fallback.

        Args:
            team_id: Slack workspace id owning the conversation.
            channel_id: Slack channel id where the request was made.
            thread_ts: Optional thread timestamp, currently unused by the query.

        Returns:
            Enabled agent documents that are allowed in the supplied context.
        """
        del thread_ts
        workspace_settings = self._read_model(
            self._workspace_settings_ref(team_id),
            WorkspaceAppSettingsDocument,
        )
        if (
            workspace_settings is not None
            and workspace_settings.enabled_channel_ids
            and channel_id not in workspace_settings.enabled_channel_ids
        ):
            return []

        agents: list[AgentDocument] = []
        for snapshot in self._client.collection("agents").stream():
            if not snapshot.exists:
                continue
            data = snapshot.to_dict() or {}
            agent = AgentDocument.model_validate(cast(dict[str, Any], data))
            if agent.enabled:
                agents.append(agent)
        return agents

    def _workspace_ref(self, team_id: str) -> Any:
        """Return the workspace document reference for a team.

        Args:
            team_id: Slack workspace id.

        Returns:
            Firestore document reference for the workspace.
        """
        return self._client.collection("workspaces").document(team_id)

    def _workspace_settings_ref(self, team_id: str) -> Any:
        """Return the workspace app settings document reference.

        Args:
            team_id: Slack workspace id.

        Returns:
            Firestore document reference for the workspace app settings.
        """
        return (
            self._workspace_ref(team_id).collection("app_settings").document("default")
        )

    def _channel_ref(self, team_id: str, channel_id: str) -> Any:
        """Return the channel document reference within a workspace.

        Args:
            team_id: Slack workspace id.
            channel_id: Slack channel id.

        Returns:
            Firestore document reference for the channel.
        """
        return self._workspace_ref(team_id).collection("channels").document(channel_id)

    def _channel_settings_ref(self, team_id: str, channel_id: str) -> Any:
        """Return the channel app settings document reference.

        Args:
            team_id: Slack workspace id.
            channel_id: Slack channel id.

        Returns:
            Firestore document reference for the channel app settings.
        """
        return (
            self._channel_ref(team_id, channel_id)
            .collection("app_settings")
            .document("default")
        )

    def _thread_ref(self, team_id: str, channel_id: str, thread_ts: str) -> Any:
        """Return the thread document reference within a channel.

        Args:
            team_id: Slack workspace id.
            channel_id: Slack channel id.
            thread_ts: Thread timestamp identifying the Slack thread.

        Returns:
            Firestore document reference for the thread.
        """
        return (
            self._channel_ref(team_id, channel_id)
            .collection("threads")
            .document(thread_ts)
        )

    def _agent_ref(self, agent_id: str) -> Any:
        """Return the global agent definition document reference.

        Args:
            agent_id: Agent identifier stored in the global agents collection.

        Returns:
            Firestore document reference for the agent definition.
        """
        return self._client.collection("agents").document(agent_id)

    def _read_model(
        self,
        reference: Any,
        model_type: type[DocumentT],
    ) -> DocumentT | None:
        """Read and validate a Firestore document as the requested model type.

        Args:
            reference: Firestore document reference to load.
            model_type: Pydantic model type used to validate the document payload.

        Returns:
            Validated model instance, or `None` when the document does not exist.
        """
        snapshot = reference.get()
        if not snapshot.exists:
            return None
        data = snapshot.to_dict() or {}
        return model_type.model_validate(cast(dict[str, Any], data))


__all__ = ["FirestoreSlackAgentRepository"]
