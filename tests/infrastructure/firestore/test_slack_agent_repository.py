from __future__ import annotations

from copy import deepcopy
from typing import Any

from agents_party.domain import AgentRouteScope, ThreadStatus
from agents_party.infrastructure.firestore import FirestoreSlackAgentRepository


class FakeSnapshot:
    def __init__(self, path: tuple[str, ...], data: dict[str, Any] | None) -> None:
        """Store a fake snapshot payload for Firestore repository tests.

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


class FakeDocumentReference:
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

    def get(self) -> FakeSnapshot:
        """Load the current fake document snapshot.

        Returns:
            Fake snapshot representing the referenced document.
        """
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

    def collection(self, name: str) -> FakeCollectionReference:
        """Return a nested fake collection reference.

        Args:
            name: Collection name under the current document.

        Returns:
            Fake collection reference for the nested collection.
        """
        return FakeCollectionReference(self._client, (*self._path, name))


class FakeCollectionReference:
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
        """Stream fake snapshots directly under the collection path.

        Returns:
            Snapshots for documents stored immediately under this collection.
        """
        target_length = len(self._path) + 1
        return [
            FakeSnapshot(path, data)
            for path, data in sorted(self._client.documents.items())
            if len(path) == target_length and path[:-1] == self._path
        ]


class FakeFirestoreClient:
    def __init__(self) -> None:
        """Initialize the fake Firestore client document store.

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


def test_resolve_agent_prefers_thread_over_channel_and_workspace() -> None:
    """Verify thread routing overrides channel and workspace defaults.

    Returns:
        None.
    """
    client = FakeFirestoreClient()
    client.documents[("agents", "thread-agent")] = {
        "agent_id": "thread-agent",
        "name": "Thread Agent",
        "model_provider": "google-gla",
        "model_name": "gemini-3-flash-preview",
        "enabled": True,
    }
    client.documents[("workspaces", "T1", "app_settings", "default")] = {
        "default_agent_id": "workspace-agent",
        "enabled_channel_ids": ["C123"],
    }
    client.documents[
        ("workspaces", "T1", "channels", "C123", "app_settings", "default")
    ] = {
        "default_agent_id": "channel-agent",
    }
    client.documents[
        ("workspaces", "T1", "channels", "C123", "threads", "1712345678.000100")
    ] = {
        "thread_ts": "1712345678.000100",
        "root_message_ts": "1712345678.000100",
        "channel_id": "C123",
        "team_id": "T1",
        "agent_id": "thread-agent",
    }

    repository = FirestoreSlackAgentRepository(client=client)
    route = repository.resolve_agent(
        team_id="T1",
        channel_id="C123",
        thread_ts="1712345678.000100",
    )

    assert route is not None
    assert route.agent.agent_id == "thread-agent"
    assert route.scope == AgentRouteScope.THREAD


def test_resolve_agent_returns_none_for_channel_outside_workspace_enablement() -> None:
    """Verify routing is disabled when the channel is not workspace-enabled.

    Returns:
        None.
    """
    client = FakeFirestoreClient()
    client.documents[("agents", "workspace-agent")] = {
        "agent_id": "workspace-agent",
        "name": "Workspace Agent",
        "model_provider": "google-gla",
        "model_name": "gemini-3-flash-preview",
        "enabled": True,
    }
    client.documents[("workspaces", "T1", "app_settings", "default")] = {
        "default_agent_id": "workspace-agent",
        "enabled_channel_ids": ["C999"],
    }

    repository = FirestoreSlackAgentRepository(client=client)

    assert repository.resolve_agent(team_id="T1", channel_id="C123") is None


def test_list_enabled_agents_returns_only_enabled_candidates() -> None:
    """Verify selector fallback only returns enabled agents.

    Returns:
        None.
    """
    client = FakeFirestoreClient()
    client.documents[("agents", "enabled-agent")] = {
        "agent_id": "enabled-agent",
        "name": "Enabled Agent",
        "description": "Handles summaries.",
        "when_to_use": "Use for thread summaries.",
        "supported_skill_names": ["handover-brief-builder"],
        "model_provider": "google-gla",
        "model_name": "gemini-3-flash-preview",
        "enabled": True,
    }
    client.documents[("agents", "disabled-agent")] = {
        "agent_id": "disabled-agent",
        "name": "Disabled Agent",
        "model_provider": "google-gla",
        "model_name": "gemini-3-flash-preview",
        "enabled": False,
    }

    repository = FirestoreSlackAgentRepository(client=client)
    agents = repository.list_enabled_agents(team_id="T1", channel_id="C123")

    assert [agent.agent_id for agent in agents] == ["enabled-agent"]


def test_activate_thread_agent_upserts_minimal_state_only() -> None:
    """Verify thread activation writes only routing state fields.

    Returns:
        None.
    """
    client = FakeFirestoreClient()
    repository = FirestoreSlackAgentRepository(client=client)

    thread = repository.activate_thread_agent(
        team_id="T1",
        channel_id="C123",
        thread_ts="1712345678.000100",
        agent_id="work-manager",
        root_message_ts="1712345678.000100",
        last_message_ts="1712345680.000200",
    )

    stored = client.documents[
        ("workspaces", "T1", "channels", "C123", "threads", "1712345678.000100")
    ]
    assert thread.status == ThreadStatus.ACTIVE
    assert stored["agent_id"] == "work-manager"
    assert stored["status"] == ThreadStatus.ACTIVE
    assert stored["root_message_ts"] == "1712345678.000100"
    assert stored["last_message_ts"] == "1712345680.000200"
    assert "messages" not in stored
    assert "participant_user_ids" not in stored
    assert "summary" not in stored


def test_is_thread_auto_reply_enabled_prefers_channel_then_workspace_then_default() -> (
    None
):
    """Verify thread auto-reply settings resolve with the intended precedence.

    Returns:
        None.
    """
    client = FakeFirestoreClient()
    repository = FirestoreSlackAgentRepository(client=client)

    assert (
        repository.is_thread_auto_reply_enabled(team_id="T1", channel_id="C123") is True
    )

    client.documents[("workspaces", "T1", "app_settings", "default")] = {
        "thread_auto_reply": False,
    }
    assert (
        repository.is_thread_auto_reply_enabled(team_id="T1", channel_id="C123")
        is False
    )

    client.documents[
        ("workspaces", "T1", "channels", "C123", "app_settings", "default")
    ] = {
        "thread_auto_reply": True,
    }
    assert (
        repository.is_thread_auto_reply_enabled(team_id="T1", channel_id="C123") is True
    )
