from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

from agents_party.domain.work_management import (
    AttentionProfile,
    ParticipantAttentionUpdate,
    ParticipantRelationDocument,
    ParticipantRole,
    VisibilityPolicyKind,
    WorkEventDocument,
    WorkEventType,
    WorkItemDocument,
    WorkItemMutation,
    WorkItemPatch,
    WorkItemPriority,
    WorkItemQuery,
    WorkItemQueryView,
    WorkItemStatus,
)
from agents_party.infrastructure.firestore import FirestoreWorkItemRepository


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

    def delete(self) -> None:
        """Delete the referenced fake document if it exists.

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
        snapshots = [
            FakeSnapshot(path, data)
            for path, data in sorted(self._client.documents.items())
            if len(path) == target_length and path[:-1] == self._path
        ]
        return snapshots


class FakeTransaction:
    def __init__(self, client: FakeFirestoreClient) -> None:
        """Initialize a fake transaction recorder.

        Args:
            client: Fake Firestore client that will receive committed operations.

        Returns:
            None.
        """
        self._client = client
        self._operations: list[tuple[str, tuple[str, ...], dict[str, Any] | None]] = []

    def set(
        self,
        reference: FakeDocumentReference,
        document_data: dict[str, Any],
        merge: bool = False,
    ) -> None:
        """Record a set operation for later commit.

        Args:
            reference: Target fake document reference.
            document_data: Document payload to write on commit.
            merge: Merge flag, unused by this fake transaction.

        Returns:
            None.
        """
        self._operations.append(("set", reference._path, deepcopy(document_data)))

    def delete(self, reference: FakeDocumentReference, option: Any = None) -> None:
        """Record a delete operation for later commit.

        Args:
            reference: Target fake document reference.
            option: Firestore delete option, unused by this fake transaction.

        Returns:
            None.
        """
        del option
        self._operations.append(("delete", reference._path, None))

    def commit(self) -> None:
        """Apply recorded operations to the fake Firestore client.

        Returns:
            None.
        """
        for action, path, document_data in self._operations:
            if action == "set":
                assert document_data is not None
                self._client.documents[path] = deepcopy(document_data)
            else:
                self._client.documents.pop(path, None)


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

    def transaction(self) -> FakeTransaction:
        """Create a fake transaction recorder.

        Returns:
            Fresh fake transaction instance.
        """
        return FakeTransaction(self)


def make_item(
    *,
    work_item_id: str,
    visibility_kind: VisibilityPolicyKind = VisibilityPolicyKind.CONTEXT,
    source_channel_id: str = "C123",
    created_by_user_id: str = "U1",
) -> WorkItemDocument:
    """Build a representative work-item document for repository tests.

    Args:
        work_item_id: Work item identifier to assign.
        visibility_kind: Visibility policy to apply to the item.
        source_channel_id: Slack source channel id for the item.
        created_by_user_id: User id that created the item.

    Returns:
        Work-item document configured for repository tests.
    """
    return WorkItemDocument(
        work_item_id=work_item_id,
        team_id="T1",
        title=f"Task {work_item_id}",
        priority=WorkItemPriority.MEDIUM,
        visibility_kind=visibility_kind,
        source_channel_id=source_channel_id,
        created_by_user_id=created_by_user_id,
    )


def make_participant(
    *,
    work_item_id: str,
    user_id: str,
    role: ParticipantRole = ParticipantRole.FOLLOWER,
    attention_profile: AttentionProfile | None = None,
) -> ParticipantRelationDocument:
    """Build a representative participant relation for repository tests.

    Args:
        work_item_id: Work item identifier the participant belongs to.
        user_id: Participant user id.
        role: Participant role to assign.
        attention_profile: Optional explicit attention profile override.

    Returns:
        Participant relation document configured for repository tests.
    """
    resolved_attention = attention_profile or (
        AttentionProfile.FOCUS
        if role == ParticipantRole.PRIMARY_ASSIGNEE
        else AttentionProfile.TRACK
    )
    return ParticipantRelationDocument(
        work_item_id=work_item_id,
        user_id=user_id,
        role=role,
        attention_profile=resolved_attention,
    )


def make_event(
    *,
    event_id: str,
    work_item_id: str,
    event_type: WorkEventType = WorkEventType.WORK_ITEM_CREATED,
    actor_user_id: str = "U1",
    occurred_at: datetime | None = None,
) -> WorkEventDocument:
    """Build a representative work event for repository tests.

    Args:
        event_id: Event identifier to assign.
        work_item_id: Work item identifier the event belongs to.
        event_type: Event type to assign.
        actor_user_id: User id responsible for the event.
        occurred_at: Optional explicit occurrence timestamp.

    Returns:
        Work-event document configured for repository tests.
    """
    return WorkEventDocument(
        event_id=event_id,
        work_item_id=work_item_id,
        type=event_type,
        actor_user_id=actor_user_id,
        occurred_at=occurred_at or datetime(2026, 3, 22, tzinfo=UTC),
    )


def test_create_work_item_writes_source_of_truth_and_attention_index() -> None:
    """Verify creation writes the item, related documents, and attention index.

    Returns:
        None.
    """
    client = FakeFirestoreClient()
    repository = FirestoreWorkItemRepository(client=client)
    item = make_item(work_item_id="W1")
    participants = [make_participant(work_item_id="W1", user_id="U1")]
    events = [make_event(event_id="E1", work_item_id="W1")]

    aggregate = repository.create_work_item(item, participants, events)
    fetched = repository.get_work_item("W1", "T1", "U1", ["C123"])

    assert aggregate.item.work_item_id == "W1"
    assert fetched is not None
    assert fetched.viewer_relation is not None
    assert (
        "workspaces",
        "T1",
        "attention_index",
        "U1",
        "work_items",
        "W1",
    ) in client.documents


def test_mutate_work_item_updates_cached_fields_and_attention() -> None:
    """Verify mutation updates persisted fields and attention index state.

    Returns:
        None.
    """
    client = FakeFirestoreClient()
    repository = FirestoreWorkItemRepository(client=client)
    repository.create_work_item(
        make_item(work_item_id="W1"),
        [make_participant(work_item_id="W1", user_id="U1")],
        [make_event(event_id="E1", work_item_id="W1")],
    )
    next_attention_at = datetime(2026, 3, 23, tzinfo=UTC)

    aggregate = repository.mutate_work_item(
        work_item_id="W1",
        team_id="T1",
        actor_user_id="U1",
        mutation=WorkItemMutation(
            item_patch=WorkItemPatch(status=WorkItemStatus.DONE),
            primary_assignee_user_id="U2",
            attention_updates=[
                ParticipantAttentionUpdate(
                    user_id="U1",
                    next_attention_at=next_attention_at,
                )
            ],
            events=[
                make_event(
                    event_id="E2",
                    work_item_id="W1",
                    event_type=WorkEventType.COMPLETED,
                )
            ],
        ),
    )

    assert aggregate.item.status == WorkItemStatus.DONE
    assert aggregate.item.primary_assignee_user_id == "U2"
    assert aggregate.viewer_relation is not None
    assert aggregate.viewer_relation.next_attention_at == next_attention_at
    assert (
        client.documents[
            (
                "workspaces",
                "T1",
                "attention_index",
                "U1",
                "work_items",
                "W1",
            )
        ]["next_attention_at"]
        == next_attention_at
    )


def test_list_work_items_respects_visibility_and_needs_attention_view() -> None:
    """Verify list queries honor visibility and needs-attention filtering.

    Returns:
        None.
    """
    client = FakeFirestoreClient()
    repository = FirestoreWorkItemRepository(client=client)
    repository.create_work_item(
        make_item(
            work_item_id="W-private", visibility_kind=VisibilityPolicyKind.PRIVATE
        ),
        [make_participant(work_item_id="W-private", user_id="U1")],
        [make_event(event_id="E1", work_item_id="W-private")],
    )
    repository.create_work_item(
        make_item(
            work_item_id="W-context", visibility_kind=VisibilityPolicyKind.CONTEXT
        ),
        [make_participant(work_item_id="W-context", user_id="U1")],
        [make_event(event_id="E2", work_item_id="W-context")],
    )

    channel_items = repository.list_work_items(
        WorkItemQuery(
            team_id="T1",
            viewer_user_id="U9",
            viewer_channel_id="C123",
            viewer_context_channel_ids=["C123"],
            view=WorkItemQueryView.CHANNEL_OPEN,
        )
    )
    attention_items = repository.list_work_items(
        WorkItemQuery(
            team_id="T1",
            viewer_user_id="U1",
            viewer_channel_id="C123",
            viewer_context_channel_ids=["C123"],
            view=WorkItemQueryView.NEEDS_ATTENTION,
            needs_attention_only=True,
        )
    )

    assert [aggregate.item.work_item_id for aggregate in channel_items] == ["W-context"]
    assert {aggregate.item.work_item_id for aggregate in attention_items} == {
        "W-private",
        "W-context",
    }
