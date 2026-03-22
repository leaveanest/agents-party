from agents_party.domain.slack_documents import (
    AgentRouteScope,
    ChannelDocument,
    ChannelType,
    InstallationScope,
    MessageRole,
    TenantSlackIdentityDocument,
    ThreadDocument,
    ThreadMessage,
    resolve_agent_id_for_slack_context,
)


def test_tenant_slack_identity_supports_enterprise_workspace_mapping() -> None:
    """Verify enterprise identities can store multiple workspace ids.

    Returns:
        None.
    """
    identity = TenantSlackIdentityDocument(
        enterprise_id="E123",
        primary_team_id="T123",
        installation_scope=InstallationScope.ENTERPRISE,
        workspace_ids=["T123", "T456"],
    )

    assert identity.enterprise_id == "E123"
    assert identity.workspace_ids == ["T123", "T456"]


def test_thread_document_derives_message_fields() -> None:
    """Verify thread validation derives message count and last message timestamp.

    Returns:
        None.
    """
    thread = ThreadDocument(
        thread_ts="1712345678.123456",
        root_message_ts="1712345678.123456",
        channel_id="C123",
        team_id="T123",
        messages=[
            ThreadMessage(
                ts="1712345678.123456",
                role=MessageRole.USER,
                text="hello",
                user_id="U123",
            ),
            ThreadMessage(
                ts="1712345680.000100",
                role=MessageRole.ASSISTANT,
                text="hi",
                agent_id="default",
            ),
        ],
    )

    assert thread.message_count == 2
    assert thread.last_message_ts == "1712345680.000100"


def test_channel_document_uses_slack_aligned_channel_id() -> None:
    """Verify channel documents preserve the Slack channel id field.

    Returns:
        None.
    """
    channel = ChannelDocument(
        channel_id="C123",
        team_id="T123",
        channel_type=ChannelType.CHANNEL,
        name="agents-party",
    )

    assert channel.channel_id == "C123"


def test_resolve_agent_id_for_slack_context_prefers_narrower_scope() -> None:
    """Verify route resolution prefers thread over broader scopes.

    Returns:
        None.
    """
    agent_id, scope = resolve_agent_id_for_slack_context(
        thread_agent_id="thread-agent",
        channel_agent_id="channel-agent",
        workspace_agent_id="workspace-agent",
    )

    assert agent_id == "thread-agent"
    assert scope == AgentRouteScope.THREAD
