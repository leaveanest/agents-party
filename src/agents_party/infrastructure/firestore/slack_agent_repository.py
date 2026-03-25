from __future__ import annotations

from typing import Any, TypeVar, cast

from google.cloud import firestore
from pydantic import BaseModel

from agents_party.domain import (
    ChannelAppSettingsDocument,
    ThreadDocument,
    ThreadStatus,
    WorkspaceAppSettingsDocument,
    utc_now,
)


DocumentT = TypeVar("DocumentT", bound=BaseModel)


class FirestoreSlackAgentRepository:
    """Firestore-backed repository for Slack assistant channel and thread settings."""

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

    def is_channel_enabled(
        self,
        *,
        team_id: str,
        channel_id: str,
    ) -> bool:
        """Return whether the Slack assistant is enabled for a channel.

        Args:
            team_id: Slack workspace id owning the conversation.
            channel_id: Slack channel id where the request was made.

        Returns:
            `True` when the assistant should handle requests in this channel.
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
            return False
        return True

    def get_thread_document(
        self,
        *,
        team_id: str,
        channel_id: str,
        thread_ts: str,
    ) -> ThreadDocument | None:
        """Return the stored thread document for a Slack conversation.

        Args:
            team_id: Slack workspace id owning the conversation.
            channel_id: Slack channel id where the thread lives.
            thread_ts: Thread timestamp identifying the Slack thread.

        Returns:
            Stored thread document, or `None` when no thread state exists.
        """
        return self._read_model(
            self._thread_ref(team_id, channel_id, thread_ts),
            ThreadDocument,
        )

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
        """Persist the active assistant state for a Slack thread.

        Args:
            team_id: Slack workspace id owning the conversation.
            channel_id: Slack channel id where the thread lives.
            thread_ts: Thread timestamp identifying the Slack thread.
            agent_id: Stored agent id that handled the thread.
            root_message_ts: Root Slack message timestamp for the thread.
            last_message_ts: Latest Slack message timestamp included in execution.

        Returns:
            Persisted thread document containing the active routing state.
        """
        current_thread = self.get_thread_document(
            team_id=team_id,
            channel_id=channel_id,
            thread_ts=thread_ts,
        )
        now = utc_now()
        thread = ThreadDocument(
            thread_ts=thread_ts,
            root_message_ts=(
                current_thread.root_message_ts
                if current_thread is not None
                else root_message_ts
            ),
            channel_id=channel_id,
            team_id=team_id,
            status=ThreadStatus.ACTIVE,
            agent_id=agent_id,
            last_message_ts=last_message_ts,
            created_at=current_thread.created_at if current_thread is not None else now,
            updated_at=now,
        )
        document_data = self._dump(thread)
        for field_name in (
            "enterprise_id",
            "title",
            "participant_user_ids",
            "messages",
            "message_count",
            "summary",
        ):
            document_data.pop(field_name, None)
        self._thread_ref(team_id, channel_id, thread_ts).set(document_data)
        return thread

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
        workspace_settings = self._read_model(
            self._workspace_settings_ref(team_id),
            WorkspaceAppSettingsDocument,
        )
        if (
            workspace_settings is not None
            and workspace_settings.enabled_channel_ids
            and channel_id not in workspace_settings.enabled_channel_ids
        ):
            return False

        channel_settings = self._read_model(
            self._channel_settings_ref(team_id, channel_id),
            ChannelAppSettingsDocument,
        )
        if (
            channel_settings is not None
            and channel_settings.thread_auto_reply is not None
        ):
            return channel_settings.thread_auto_reply
        if (
            workspace_settings is not None
            and workspace_settings.thread_auto_reply is not None
        ):
            return workspace_settings.thread_auto_reply
        return True

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

    def _dump(self, document: BaseModel) -> dict[str, Any]:
        """Serialize a Pydantic document into Firestore-friendly Python data.

        Args:
            document: Pydantic document to serialize.

        Returns:
            Plain Python dictionary ready to write to Firestore.
        """
        return cast(dict[str, Any], document.model_dump(mode="python"))


__all__ = ["FirestoreSlackAgentRepository"]
