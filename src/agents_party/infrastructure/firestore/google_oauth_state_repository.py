"""Firestore-backed repository for short-lived Google OAuth state."""

from __future__ import annotations

from typing import Any, TypeVar, cast

from google.cloud import firestore
from pydantic import BaseModel

from agents_party.domain.google_auth import GoogleOAuthStateDocument


DocumentT = TypeVar("DocumentT", bound=BaseModel)


class FirestoreGoogleOAuthStateRepository:
    """Persist short-lived Google OAuth state in Firestore."""

    def __init__(
        self,
        *,
        project_id: str | None = None,
        database: str = "(default)",
        client: Any | None = None,
    ) -> None:
        """Create a Firestore-backed OAuth state repository.

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

    def create_state(
        self,
        *,
        state: GoogleOAuthStateDocument,
    ) -> GoogleOAuthStateDocument:
        """Persist a new Google OAuth state document.

        Args:
            state: OAuth state document to store.

        Returns:
            Persisted OAuth state document.
        """
        self._state_ref(team_id=state.team_id, state_id=state.state_id).set(
            self._dump(state)
        )
        return state

    def get_state(
        self,
        *,
        team_id: str,
        state_id: str,
    ) -> GoogleOAuthStateDocument | None:
        """Return a stored Google OAuth state document.

        Args:
            team_id: Slack workspace id owning the OAuth flow.
            state_id: OAuth state identifier.

        Returns:
            Stored state document, or `None` when absent.
        """
        return self._read_model(
            self._state_ref(team_id=team_id, state_id=state_id),
            GoogleOAuthStateDocument,
        )

    def consume_state(
        self,
        *,
        team_id: str,
        state_id: str,
    ) -> GoogleOAuthStateDocument | None:
        """Atomically read and delete a stored Google OAuth state document.

        Args:
            team_id: Slack workspace id owning the OAuth flow.
            state_id: OAuth state identifier.

        Returns:
            Stored state document, or `None` when absent.
        """
        reference = self._state_ref(team_id=team_id, state_id=state_id)
        transaction = self._client.transaction()
        if not hasattr(transaction, "_read_only"):
            snapshot = reference.get()
            if not snapshot.exists:
                return None
            data = snapshot.to_dict() or {}
            reference.delete()
            return GoogleOAuthStateDocument.model_validate(cast(dict[str, Any], data))

        @firestore.transactional
        def consume(transaction: Any) -> GoogleOAuthStateDocument | None:
            snapshot = reference.get(transaction=transaction)
            if not snapshot.exists:
                return None
            data = snapshot.to_dict() or {}
            transaction.delete(reference)
            return GoogleOAuthStateDocument.model_validate(cast(dict[str, Any], data))

        return consume(transaction)

    def delete_state(
        self,
        *,
        team_id: str,
        state_id: str,
    ) -> None:
        """Delete a stored Google OAuth state document.

        Args:
            team_id: Slack workspace id owning the OAuth flow.
            state_id: OAuth state identifier.

        Returns:
            None.
        """
        self._state_ref(team_id=team_id, state_id=state_id).delete()

    def _workspace_ref(self, team_id: str) -> Any:
        """Return the workspace document reference for a team.

        Args:
            team_id: Slack workspace id.

        Returns:
            Firestore document reference for the workspace.
        """
        return self._client.collection("workspaces").document(team_id)

    def _states_collection(self, team_id: str) -> Any:
        """Return the collection reference for OAuth state documents.

        Args:
            team_id: Slack workspace id.

        Returns:
            Firestore collection reference for OAuth state documents.
        """
        return self._workspace_ref(team_id).collection("google_oauth_states")

    def _state_ref(self, *, team_id: str, state_id: str) -> Any:
        """Return the Firestore reference for an OAuth state document.

        Args:
            team_id: Slack workspace id owning the OAuth flow.
            state_id: OAuth state identifier.

        Returns:
            Firestore document reference for the OAuth state document.
        """
        return self._states_collection(team_id).document(state_id)

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


__all__ = ["FirestoreGoogleOAuthStateRepository"]
