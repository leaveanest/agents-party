"""Opaque context tokens for Google OAuth start URLs."""

from __future__ import annotations

import base64
import hashlib
import json

from cryptography.fernet import Fernet, InvalidToken
from pydantic import ValidationError

from agents_party.domain.google_auth import (
    GoogleOAuthStartContext,
    GoogleOAuthStateToken,
)
from agents_party.domain.slack_documents import utc_now


class GoogleOAuthContextSignerError(ValueError):
    """Raised when a signed Google OAuth context token is invalid."""


class GoogleOAuthContextSigner:
    """Issue and verify opaque Google OAuth start context tokens."""

    def __init__(self, *, secret: str) -> None:
        """Initialize the signer with a secret-derived encryption key.

        Args:
            secret: Secret material used to derive the context encryption key.

        Returns:
            None.
        """
        if not secret.strip():
            raise ValueError("Google OAuth context signing secret must not be blank")
        derived_key = base64.urlsafe_b64encode(
            hashlib.sha256(secret.encode("utf-8")).digest()
        )
        self._fernet = Fernet(derived_key)

    def dumps(self, context: GoogleOAuthStartContext) -> str:
        """Serialize and encrypt a Google OAuth start context.

        Args:
            context: Context payload to serialize and encrypt.

        Returns:
            Opaque token suitable for the public `context` query parameter.
        """
        return self._dump_model(context)

    def dumps_state_token(self, state_token: GoogleOAuthStateToken) -> str:
        """Serialize and encrypt an OAuth callback state token.

        Args:
            state_token: Callback state token payload to encrypt.

        Returns:
            Opaque token suitable for the OAuth `state` query parameter.
        """
        return self._dump_model(state_token)

    def loads(self, token: str) -> GoogleOAuthStartContext:
        """Decrypt and deserialize a Google OAuth start context token.

        Args:
            token: Opaque context token from the public `context` query parameter.

        Returns:
            Verified Google OAuth start context payload.

        Raises:
            GoogleOAuthContextSignerError: If the token is malformed, invalid, or expired.
        """
        context = self._load_model(token, GoogleOAuthStartContext)
        if context.expires_at <= utc_now():
            raise GoogleOAuthContextSignerError("Expired Google OAuth context token")
        return context

    def loads_state_token(self, token: str) -> GoogleOAuthStateToken:
        """Decrypt and deserialize an OAuth callback state token.

        Args:
            token: Opaque `state` token from the OAuth callback query parameter.

        Returns:
            Verified OAuth callback state token payload.

        Raises:
            GoogleOAuthContextSignerError: If the token is malformed, invalid, or expired.
        """
        state_token = self._load_model(token, GoogleOAuthStateToken)
        if state_token.expires_at <= utc_now():
            raise GoogleOAuthContextSignerError("Expired Google OAuth state token")
        return state_token

    def _dump_model(
        self,
        model: GoogleOAuthStartContext | GoogleOAuthStateToken,
    ) -> str:
        """Serialize and encrypt a supported OAuth model.

        Args:
            model: Supported OAuth model payload to encrypt.

        Returns:
            Opaque encrypted token string.
        """
        payload = json.dumps(
            model.model_dump(mode="json"),
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        return self._fernet.encrypt(payload).decode("utf-8")

    def _load_model[ModelT: GoogleOAuthStartContext | GoogleOAuthStateToken](
        self,
        token: str,
        model_type: type[ModelT],
    ) -> ModelT:
        """Decrypt and deserialize a supported OAuth model token.

        Args:
            token: Opaque encrypted token string.
            model_type: Pydantic model type expected after decryption.

        Returns:
            Deserialized model payload.

        Raises:
            GoogleOAuthContextSignerError: If the token is malformed or invalid.
        """
        try:
            payload = self._fernet.decrypt(token.encode("utf-8"))
        except (InvalidToken, ValueError, TypeError) as exc:
            raise GoogleOAuthContextSignerError(
                "Malformed Google OAuth context token"
            ) from exc

        try:
            return model_type.model_validate_json(payload)
        except ValidationError as exc:
            raise GoogleOAuthContextSignerError(
                "Invalid Google OAuth context payload"
            ) from exc


__all__ = ["GoogleOAuthContextSigner", "GoogleOAuthContextSignerError"]
