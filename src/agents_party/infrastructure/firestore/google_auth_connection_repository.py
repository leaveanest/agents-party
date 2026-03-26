"""Firestore-backed Google OAuth connection repository."""

from __future__ import annotations

from typing import Any, TypeVar, cast

from google.cloud import firestore
from pydantic import BaseModel

from agents_party.domain.google_auth import GoogleAuthConnectionDocument


DocumentT = TypeVar("DocumentT", bound=BaseModel)


class FirestoreGoogleAuthConnectionRepository:
    """Persist Google OAuth connections in Firestore."""

    def __init__(
        self,
        *,
        project_id: str | None = None,
        database: str = "(default)",
        client: Any | None = None,
    ) -> None:
        """Create a Firestore-backed Google OAuth connection repository.

        Args:
            project_id: Optional Google Cloud project id for Firestore client creation.
            database: Firestore database name to connect to.
            client: Optional injected Firestore-compatible client for tests.

        Returns:
            None.
        """
        self._client = client or firestore.Client(
            project=project_id,
            database=database,
        )

    def get_connection(
        self,
        *,
        team_id: str,
        slack_user_id: str,
        google_account_subject: str,
    ) -> GoogleAuthConnectionDocument | None:
        """Return a specific Google OAuth connection document.

        Args:
            team_id: Slack workspace id owning the connection.
            slack_user_id: Slack user id owning the connection.
            google_account_subject: Stable Google `sub` for the account.

        Returns:
            Stored connection document, or `None` when absent.
        """
        return self._read_model(
            self._connection_ref(
                team_id=team_id,
                slack_user_id=slack_user_id,
                google_account_subject=google_account_subject,
            ),
            GoogleAuthConnectionDocument,
        )

    def list_connections(
        self,
        *,
        team_id: str,
        slack_user_id: str,
    ) -> list[GoogleAuthConnectionDocument]:
        """Return all Google OAuth connections owned by a Slack user.

        Args:
            team_id: Slack workspace id owning the connections.
            slack_user_id: Slack user id whose connections should be listed.

        Returns:
            Stored Google OAuth connection documents for the Slack user.
        """
        prefix = f"{slack_user_id}__"
        documents: list[GoogleAuthConnectionDocument] = []
        for snapshot in self._connections_collection(team_id).stream():
            if not snapshot.id.startswith(prefix):
                continue
            data = snapshot.to_dict() or {}
            document = GoogleAuthConnectionDocument.model_validate(
                cast(dict[str, Any], data)
            )
            documents.append(document)
        return documents

    def upsert_connection(
        self,
        *,
        connection: GoogleAuthConnectionDocument,
    ) -> GoogleAuthConnectionDocument:
        """Create or update a Google OAuth connection document.

        Args:
            connection: Connection document to persist.

        Returns:
            Persisted connection document.
        """
        self._connection_ref(
            team_id=connection.team_id,
            slack_user_id=connection.slack_user_id,
            google_account_subject=connection.google_account_subject,
        ).set(self._dump(connection))
        return connection

    def _workspace_ref(self, team_id: str) -> Any:
        """Return the workspace document reference for a team.

        Args:
            team_id: Slack workspace id.

        Returns:
            Firestore document reference for the workspace.
        """
        return self._client.collection("workspaces").document(team_id)

    def _connections_collection(self, team_id: str) -> Any:
        """Return the collection reference for Google OAuth connections.

        Args:
            team_id: Slack workspace id.

        Returns:
            Firestore collection reference for Google OAuth connections.
        """
        return self._workspace_ref(team_id).collection("google_connections")

    def _connection_ref(
        self,
        *,
        team_id: str,
        slack_user_id: str,
        google_account_subject: str,
    ) -> Any:
        """Return the Firestore reference for a Google OAuth connection.

        Args:
            team_id: Slack workspace id owning the connection.
            slack_user_id: Slack user id owning the connection.
            google_account_subject: Stable Google `sub` value for the account.

        Returns:
            Firestore document reference for the Google OAuth connection.
        """
        document_id = f"{slack_user_id}__{google_account_subject}"
        return self._connections_collection(team_id).document(document_id)

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


__all__ = ["FirestoreGoogleAuthConnectionRepository"]
