from __future__ import annotations

from copy import deepcopy
from typing import Any

from agents_party.domain.google_auth import (
    GoogleAuthConnectionDocument,
    GoogleOAuthStateDocument,
)
from agents_party.infrastructure.firestore import (
    FirestoreGoogleAuthConnectionRepository,
    FirestoreGoogleOAuthStateRepository,
)


class FakeSnapshot:
    """Fake Firestore snapshot used by Google OAuth repository tests."""

    def __init__(self, path: tuple[str, ...], data: dict[str, Any] | None) -> None:
        """Store a fake snapshot payload for repository tests.

        Args:
            path: Document path represented by the snapshot.
            data: Optional document payload to expose through the snapshot.

        Returns:
            None.
        """
        self._path = path
        self._data = deepcopy(data)
        self.exists = data is not None
        self.id = path[-1]

    def to_dict(self) -> dict[str, Any] | None:
        """Return a defensive copy of the stored snapshot payload.

        Returns:
            Snapshot payload, or `None` when the document does not exist.
        """
        return deepcopy(self._data)


class FakeTransaction:
    """Minimal fake Firestore transaction used by repository tests."""

    def delete(self, reference: FakeDocumentReference) -> None:
        """Delete a document reference within the fake transaction.

        Args:
            reference: Fake document reference to delete.

        Returns:
            None.
        """
        reference.delete()


class FakeDocumentReference:
    """Fake Firestore document reference used by repository tests."""

    def __init__(self, client: FakeFirestoreClient, path: tuple[str, ...]) -> None:
        """Initialize a fake document reference.

        Args:
            client: Fake Firestore client that owns the document store.
            path: Absolute path of the referenced document.

        Returns:
            None.
        """
        self._client = client
        self._path = path
        self.id = path[-1]

    def get(self, transaction: FakeTransaction | None = None) -> FakeSnapshot:
        """Load the current fake document snapshot.

        Args:
            transaction: Optional fake transaction context.

        Returns:
            Fake snapshot representing the referenced document.
        """
        del transaction
        return FakeSnapshot(self._path, self._client.documents.get(self._path))

    def set(self, document_data: dict[str, Any], merge: bool = False) -> None:
        """Write fake document data, optionally merging with existing state.

        Args:
            document_data: Document payload to write.
            merge: Whether to merge into an existing payload.

        Returns:
            None.
        """
        if merge and self._path in self._client.documents:
            current = deepcopy(self._client.documents[self._path])
            current.update(deepcopy(document_data))
            self._client.documents[self._path] = current
            return
        self._client.documents[self._path] = deepcopy(document_data)

    def delete(self) -> None:
        """Delete the referenced fake document.

        Returns:
            None.
        """
        self._client.documents.pop(self._path, None)

    def collection(self, name: str) -> FakeCollectionReference:
        """Return a nested fake collection reference.

        Args:
            name: Collection name under the current document.

        Returns:
            Fake collection reference for the nested collection.
        """
        return FakeCollectionReference(self._client, (*self._path, name))


class FakeCollectionReference:
    """Fake Firestore collection reference used by repository tests."""

    def __init__(self, client: FakeFirestoreClient, path: tuple[str, ...]) -> None:
        """Initialize a fake collection reference.

        Args:
            client: Fake Firestore client that owns the document store.
            path: Absolute path of the referenced collection.

        Returns:
            None.
        """
        self._client = client
        self._path = path

    def document(self, document_id: str | None = None) -> FakeDocumentReference:
        """Return a fake document reference for a child document id.

        Args:
            document_id: Child document id to resolve.

        Returns:
            Fake document reference for the child document.
        """
        assert document_id is not None
        return FakeDocumentReference(self._client, (*self._path, document_id))

    def stream(self) -> list[FakeSnapshot]:
        """Return fake snapshots for documents directly under the collection.

        Returns:
            Fake snapshots for documents in the collection.
        """
        snapshots: list[FakeSnapshot] = []
        for path, data in self._client.documents.items():
            if path[:-1] == self._path:
                snapshots.append(FakeSnapshot(path, data))
        return snapshots


class FakeFirestoreClient:
    """Minimal fake Firestore client used by repository tests."""

    def __init__(self) -> None:
        """Initialize the fake Firestore document store.

        Returns:
            None.
        """
        self.documents: dict[tuple[str, ...], dict[str, Any]] = {}

    def collection(self, name: str) -> FakeCollectionReference:
        """Return a top-level fake collection reference.

        Args:
            name: Top-level collection name.

        Returns:
            Fake collection reference.
        """
        return FakeCollectionReference(self, (name,))

    def transaction(self) -> FakeTransaction:
        """Return a fake Firestore transaction object.

        Returns:
            Fake transaction object.
        """
        return FakeTransaction()


def build_connection(
    *,
    slack_user_id: str,
    subject: str,
) -> GoogleAuthConnectionDocument:
    """Build a Google OAuth connection document for repository tests.

    Args:
        slack_user_id: Slack user id owning the connection.
        subject: Stable Google `sub` value for the account.

    Returns:
        Google OAuth connection document.
    """
    return GoogleAuthConnectionDocument(
        team_id="T1",
        slack_user_id=slack_user_id,
        google_account_subject=subject,
        google_account_email=f"{subject}@example.com",
        google_account_email_verified=True,
        granted_scopes=["openid", "email"],
        access_token_encrypted=f"enc:{subject}:access",
        refresh_token_encrypted=f"enc:{subject}:refresh",
    )


def test_google_auth_connection_repository_lists_multiple_accounts_for_same_user() -> (
    None
):
    """Verify the repository lists multiple Google accounts under one Slack user.

    Returns:
        None.
    """
    client = FakeFirestoreClient()
    repository = FirestoreGoogleAuthConnectionRepository(client=client)
    connection_one = build_connection(slack_user_id="U1", subject="sub-one")
    connection_two = build_connection(slack_user_id="U1", subject="sub-two")
    connection_three = build_connection(slack_user_id="U2", subject="sub-three")

    repository.upsert_connection(connection=connection_one)
    repository.upsert_connection(connection=connection_two)
    repository.upsert_connection(connection=connection_three)

    connections = repository.list_connections(team_id="T1", slack_user_id="U1")

    assert {connection.google_account_subject for connection in connections} == {
        "sub-one",
        "sub-two",
    }
    assert (
        repository.get_connection(
            team_id="T1",
            slack_user_id="U1",
            google_account_subject="sub-two",
        )
        == connection_two
    )


def test_google_auth_connection_repository_ignores_unrelated_invalid_documents() -> (
    None
):
    """Verify unrelated malformed documents do not break list lookups by prefix.

    Returns:
        None.
    """
    client = FakeFirestoreClient()
    repository = FirestoreGoogleAuthConnectionRepository(client=client)
    connection = build_connection(slack_user_id="U1", subject="sub-one")
    repository.upsert_connection(connection=connection)
    client.documents[("workspaces", "T1", "google_connections", "U2__broken")] = {
        "team_id": "T1",
        "slack_user_id": "U2",
    }

    connections = repository.list_connections(team_id="T1", slack_user_id="U1")

    assert [document.google_account_subject for document in connections] == ["sub-one"]


def test_google_oauth_state_repository_round_trips_and_deletes_state() -> None:
    """Verify the state repository stores, reads, and deletes OAuth state.

    Returns:
        None.
    """
    client = FakeFirestoreClient()
    repository = FirestoreGoogleOAuthStateRepository(client=client)
    state = GoogleOAuthStateDocument(
        state_id="T1.state",
        team_id="T1",
        slack_user_id="U1",
        redirect_after_connect="https://example.com/app",
    )

    repository.create_state(state=state)
    stored_state = repository.get_state(team_id="T1", state_id="T1.state")
    repository.delete_state(team_id="T1", state_id="T1.state")

    assert stored_state == state
    assert repository.get_state(team_id="T1", state_id="T1.state") is None


def test_google_oauth_state_repository_consumes_state_atomically() -> None:
    """Verify consuming OAuth state returns it once and deletes it atomically.

    Returns:
        None.
    """
    client = FakeFirestoreClient()
    repository = FirestoreGoogleOAuthStateRepository(client=client)
    state = GoogleOAuthStateDocument(
        state_id="consume-state",
        team_id="T1",
        slack_user_id="U1",
    )

    repository.create_state(state=state)

    first_consume = repository.consume_state(team_id="T1", state_id="consume-state")
    second_consume = repository.consume_state(team_id="T1", state_id="consume-state")

    assert first_consume == state
    assert second_consume is None
    assert repository.get_state(team_id="T1", state_id="consume-state") is None
