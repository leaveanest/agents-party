from __future__ import annotations

from datetime import timedelta

import pytest

from agents_party.domain.google_auth import GoogleOAuthStartContext
from agents_party.domain.slack_documents import utc_now
from agents_party.infrastructure.google_auth import (
    GoogleOAuthContextSigner,
    GoogleOAuthContextSignerError,
)


def test_context_signer_round_trips_without_exposing_plain_identifiers() -> None:
    """Verify context tokens round-trip and do not expose plaintext identifiers.

    Returns:
        None.
    """
    signer = GoogleOAuthContextSigner(secret="test-signing-secret")
    context = GoogleOAuthStartContext(
        team_id="TEAM-IDENTIFIER-123",
        slack_user_id="USER-IDENTIFIER-456",
        redirect_after_connect="https://example.com/after/connect",
    )

    token = signer.dumps(context)
    restored = signer.loads(token)

    assert restored == context
    assert "TEAM-IDENTIFIER-123" not in token
    assert "USER-IDENTIFIER-456" not in token
    assert "https://example.com/after/connect" not in token


def test_context_signer_rejects_expired_tokens() -> None:
    """Verify expired context tokens are rejected after decryption.

    Returns:
        None.
    """
    signer = GoogleOAuthContextSigner(secret="test-signing-secret")
    token = signer.dumps(
        GoogleOAuthStartContext(
            team_id="T1",
            slack_user_id="U1",
            expires_at=utc_now() - timedelta(seconds=1),
        )
    )

    with pytest.raises(GoogleOAuthContextSignerError, match="Expired"):
        signer.loads(token)
